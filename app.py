import json, re, hashlib, threading, time, random, os
from datetime import datetime, date, timedelta
from functools import wraps

import httpx
from flask import Flask, request, jsonify, session, render_template, redirect
from apscheduler.schedulers.background import BackgroundScheduler

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'naver-monitor-dev-secret-2024')

# ─── Supabase REST 클라이언트 (SDK 없이 httpx 직접 호출) ───────
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')

def _sb_headers(prefer: str = 'return=representation') -> dict:
    return {
        'apikey':        SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type':  'application/json',
        'Prefer':        prefer,
    }

def _sb_url(table: str) -> str:
    return f'{SUPABASE_URL}/rest/v1/{table}'

def sb_select(table: str, query: str = '') -> list:
    r = httpx.get(f'{_sb_url(table)}{query}', headers=_sb_headers())
    r.raise_for_status()
    return r.json()

def sb_insert(table: str, data: dict) -> dict:
    r = httpx.post(_sb_url(table), json=data, headers=_sb_headers())
    r.raise_for_status()
    body = r.json()
    return body[0] if isinstance(body, list) else body

def sb_upsert(table: str, data: dict, on_conflict: str) -> None:
    headers = _sb_headers(f'resolution=merge-duplicates,return=minimal')
    r = httpx.post(
        f'{_sb_url(table)}?on_conflict={on_conflict}',
        json=data, headers=headers,
    )
    r.raise_for_status()

def sb_update(table: str, data: dict, col: str, val: str) -> None:
    r = httpx.patch(
        f'{_sb_url(table)}?{col}=eq.{val}',
        json=data, headers=_sb_headers('return=minimal'),
    )
    r.raise_for_status()

def sb_delete(table: str, col: str, val: str) -> None:
    r = httpx.delete(
        f'{_sb_url(table)}?{col}=eq.{val}',
        headers=_sb_headers('return=minimal'),
    )
    r.raise_for_status()

# ─── Admin 계정 (Railway 환경변수로 설정) ──────────────────────
ADMIN_USERNAME     = os.environ.get('ADMIN_USERNAME', 'admin')
ADMIN_PASSWORD_HASH = os.environ.get(
    'ADMIN_PASSWORD_HASH',
    hashlib.sha256(b'1234').hexdigest()
)

def _hash(pwd: str) -> str:
    return hashlib.sha256(pwd.encode()).hexdigest()

# ─── Playwright 스크래퍼 ───────────────────────────────────────
_pw_lock = threading.Lock()

def _ok(options: list) -> dict:
    return {
        'total': sum(o['qty'] for o in options),
        'options': options,
        'error': None,
        'fetched_at': datetime.now().isoformat(),
    }

def _err(msg: str) -> dict:
    return {'total': None, 'options': [], 'error': msg, 'fetched_at': datetime.now().isoformat()}

def _parse_combos(combos: list) -> list:
    result = []
    for c in combos:
        parts = [c.get(f'optionName{i}', '') for i in range(1, 4)]
        name  = ' / '.join(p for p in parts if p) or c.get('name', '옵션')
        result.append({'name': name, 'qty': c.get('stockQuantity', 0)})
    return result

def _deep_find(obj, key, depth=0):
    if depth > 12:
        return None
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = _deep_find(v, key, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for item in obj:
            r = _deep_find(item, key, depth + 1)
            if r is not None:
                return r
    return None

def _parse_product_response(data: dict):
    combos = _deep_find(data, 'optionCombinations')
    if combos:
        opts = _parse_combos(combos)
        if opts:
            return _ok(opts)
    sq = _deep_find(data, 'stockQuantity')
    if sq is not None:
        return _ok([{'name': '전체', 'qty': sq}])
    return None

def _fetch_one(browser, url: str) -> dict:
    """Playwright 브라우저 컨텍스트 1개로 URL 1개 조회"""
    context = browser.new_context(
        user_agent=(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/136.0.0.0 Safari/537.36'
        ),
        locale='ko-KR',
        timezone_id='Asia/Seoul',
        geolocation={'latitude': 37.5665, 'longitude': 126.9780},
        permissions=['geolocation'],
        viewport={'width': 1280, 'height': 800},
        extra_http_headers={
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        },
    )
    page = context.new_page()
    page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    captured: dict = {}

    def on_response(resp):
        u = resp.url
        ct = resp.headers.get('content-type', '')
        if 'json' in ct and 'naver.com' in u:
            print(f'[DEBUG] json url: {u}', flush=True)
        is_product_api = (
            ('/i/v2/channels/' in u and '/products/' in u) or
            ('/products/' in u and 'naver.com' in u)
        )
        if is_product_api and 'json' in ct:
            print(f'[DEBUG] captured: {u}', flush=True)
            try:
                captured['product'] = resp.json()
            except Exception:
                pass

    page.on('response', on_response)

    try:
        page.goto(url, wait_until='networkidle', timeout=30_000,
                  referer='https://search.naver.com/')
        page.wait_for_timeout(2_000)

        print(f'[DEBUG] page url: {page.url}', flush=True)
        print(f'[DEBUG] page title: {page.title()}', flush=True)
        print(f'[DEBUG] total captured: {list(captured.keys())}', flush=True)

        if 'product' in captured:
            result = _parse_product_response(captured['product'])
            if result:
                return result

        # fallback: __NEXT_DATA__
        nd = page.evaluate(
            '() => { const el = document.getElementById("__NEXT_DATA__");'
            ' return el ? el.textContent : ""; }'
        )
        if nd:
            data = json.loads(nd)
            combos = _deep_find(data, 'optionCombinations')
            if combos:
                opts = _parse_combos(combos)
                if opts:
                    return _ok(opts)
            sq = _deep_find(data, 'stockQuantity')
            if sq is not None:
                return _ok([{'name': '전체', 'qty': sq}])

        return _err('재고 정보를 찾을 수 없습니다')

    except Exception as e:
        msg = str(e)[:300]
        return _err('페이지 로딩 시간 초과' if 'timeout' in msg.lower() else msg)
    finally:
        context.close()

def _launch_browser(pw):
    return pw.chromium.launch(
        headless=True,
        args=[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
        ],
    )

def fetch_all():
    """스케줄러 / 전체 조회 버튼에서 호출"""
    from playwright.sync_api import sync_playwright
    competitors = db_get_competitors()
    if not competitors:
        return
    today = date.today().isoformat()
    with _pw_lock:
        with sync_playwright() as pw:
            browser = _launch_browser(pw)
            for comp in competitors:
                result = _fetch_one(browser, comp['url'])
                db_save_stock(comp['id'], today, result)
                time.sleep(random.uniform(1.5, 3.0))
            browser.close()

def fetch_single(comp: dict) -> dict:
    from playwright.sync_api import sync_playwright
    with _pw_lock:
        with sync_playwright() as pw:
            browser = _launch_browser(pw)
            result = _fetch_one(browser, comp['url'])
            browser.close()
    return result

# ─── DB 헬퍼 (Supabase REST) ──────────────────────────────────

def db_get_competitors() -> list:
    return sb_select('competitors', '?order=created_at')

def db_save_stock(cid: str, fetch_date: str, result: dict):
    sb_upsert('stock_history', {
        'competitor_id': cid,
        'fetch_date':    fetch_date,
        'total':         result.get('total'),
        'options':       result.get('options', []),
        'error':         result.get('error'),
        'fetched_at':    result.get('fetched_at', datetime.now().isoformat()),
    }, on_conflict='competitor_id,fetch_date')

def db_get_history(days: int = 14):
    start = (date.today() - timedelta(days=days)).isoformat()
    competitors = db_get_competitors()
    rows = sb_select(
        'stock_history',
        f'?select=competitor_id,fetch_date,total,options,error,fetched_at'
        f'&fetch_date=gte.{start}&order=fetch_date',
    )
    return competitors, rows

def db_get_schedule() -> dict:
    keys = 'schedule_enabled,schedule_hour,schedule_minute'
    rows = sb_select('app_settings', f'?key=in.({keys})')
    s = {row['key']: row['value'] for row in rows}
    return {
        'enabled': s.get('schedule_enabled', 'false') == 'true',
        'hour':    int(s.get('schedule_hour', 9)),
        'minute':  int(s.get('schedule_minute', 0)),
    }

def db_save_schedule(enabled: bool, hour: int, minute: int):
    for key, val in [
        ('schedule_enabled', str(enabled).lower()),
        ('schedule_hour',    str(hour)),
        ('schedule_minute',  str(minute)),
    ]:
        sb_upsert('app_settings', {'key': key, 'value': val}, on_conflict='key')

# ─── 관리자 페이지용 DB 함수 (수강생 화이트리스트 / 사용로그 / 공지) ──

def db_list_approved_users() -> list:
    return sb_select('approved_users', '?order=created_at.desc')

def db_add_approved_user(naver_id: str, display_name: str = '',
                          memo: str = '', expires_at: str | None = None) -> None:
    sb_upsert('approved_users', {
        'naver_id':     naver_id,
        'display_name': display_name,
        'memo':         memo,
        'expires_at':   expires_at,
        'blocked':      False,
    }, on_conflict='naver_id')

def db_update_approved_user(naver_id: str, fields: dict) -> None:
    if fields:
        sb_update('approved_users', fields, 'naver_id', naver_id)

def db_delete_approved_user(naver_id: str) -> None:
    sb_delete('approved_users', 'naver_id', naver_id)

def db_get_approved_user(naver_id: str) -> dict | None:
    rows = sb_select('approved_users', f'?naver_id=eq.{naver_id}&limit=1')
    return rows[0] if rows else None

def db_log_usage(naver_id: str, event: str, ip: str = '',
                  user_agent: str = '', app_version: str = '') -> None:
    sb_insert('usage_logs', {
        'naver_id':    naver_id,
        'event':       event,
        'ip':          ip[:64],
        'user_agent':  user_agent[:256],
        'app_version': app_version[:32],
    })

def db_recent_usage(limit: int = 200) -> list:
    return sb_select('usage_logs', f'?order=created_at.desc&limit={limit}')

def db_active_notice() -> dict | None:
    rows = sb_select('notices', '?active=eq.true&order=created_at.desc&limit=1')
    return rows[0] if rows else None

def db_list_notices() -> list:
    return sb_select('notices', '?order=created_at.desc')

def db_add_notice(title: str, body: str) -> None:
    sb_insert('notices', {'title': title, 'body': body, 'active': True})

def db_set_notice_active(notice_id: int, active: bool) -> None:
    sb_update('notices', {'active': active}, 'id', str(notice_id))

def db_delete_notice(notice_id: int) -> None:
    sb_delete('notices', 'id', str(notice_id))

# ─── 스케줄러 ─────────────────────────────────────────────────
scheduler = BackgroundScheduler(timezone='Asia/Seoul')

def _update_scheduler():
    s = db_get_schedule()
    try:
        scheduler.remove_job('daily_fetch')
    except Exception:
        pass
    if s['enabled']:
        scheduler.add_job(fetch_all, 'cron',
                          hour=s['hour'], minute=s['minute'],
                          id='daily_fetch')

# ─── Auth 데코레이터 ──────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def dec(*args, **kwargs):
        if not session.get('logged_in'):
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect('/login')
        return f(*args, **kwargs)
    return dec

# ─── 라우트 ───────────────────────────────────────────────────

@app.route('/')
@login_required
def index():
    return render_template('index.html')

@app.route('/login')
def login_page():
    if session.get('logged_in'):
        return redirect('/')
    return render_template('login.html')

@app.route('/api/login', methods=['POST'])
def api_login():
    body = request.get_json() or {}
    if (body.get('username') == ADMIN_USERNAME
            and _hash(body.get('password', '')) == ADMIN_PASSWORD_HASH):
        session['logged_in'] = True
        session['username']  = ADMIN_USERNAME
        return jsonify({'ok': True})
    return jsonify({'error': '아이디 또는 비밀번호가 올바르지 않습니다'}), 401

@app.route('/api/logout', methods=['POST'])
def api_logout():
    session.clear()
    return jsonify({'ok': True})

@app.route('/api/config')
@login_required
def api_config():
    return jsonify({
        'username':    session.get('username', ADMIN_USERNAME),
        'competitors': db_get_competitors(),
        'schedule':    db_get_schedule(),
    })

@app.route('/api/competitors', methods=['POST'])
@login_required
def api_add_competitor():
    body = request.get_json() or {}
    name = (body.get('name') or '').strip()
    url  = (body.get('url')  or '').strip()
    if not name or not url:
        return jsonify({'error': '이름과 URL을 입력해주세요'}), 400
    if not re.search(r'(?:smartstore|brand)\.naver\.com/.+/products/\d+', url):
        return jsonify({'error': 'smartstore.naver.com 또는 brand.naver.com URL이어야 합니다'}), 400
    cid = f"c{int(time.time() * 1000)}"
    sb_insert('competitors', {'id': cid, 'name': name, 'url': url})
    return jsonify({'ok': True, 'id': cid})

@app.route('/api/competitors/<cid>', methods=['PUT'])
@login_required
def api_update_competitor(cid):
    body   = request.get_json() or {}
    update = {k: body[k].strip() for k in ('name', 'url') if body.get(k)}
    if update:
        sb_update('competitors', update, 'id', cid)
    return jsonify({'ok': True})

@app.route('/api/competitors/<cid>', methods=['DELETE'])
@login_required
def api_delete_competitor(cid):
    sb_delete('competitors', 'id', cid)
    return jsonify({'ok': True})

@app.route('/api/history')
@login_required
def api_history():
    days = min(int(request.args.get('days', 14)), 60)
    competitors, rows = db_get_history(days)

    dates = sorted({row['fetch_date'] for row in rows})

    # {competitor_id: {fetch_date: row}}
    hmap: dict = {}
    for row in rows:
        hmap.setdefault(row['competitor_id'], {})[row['fetch_date']] = row

    last_fetched = max((r.get('fetched_at', '') for r in rows), default='')

    result = {'dates': dates, 'competitors': [], 'last_fetched': last_fetched}

    for comp in competitors:
        cid   = comp['id']
        entry = {'id': cid, 'name': comp['name'], 'url': comp['url'], 'days': {}}
        prev_total = None

        for d in dates:
            row = hmap.get(cid, {}).get(d)
            if row:
                total = row.get('total')
                sales = (prev_total - total) if (total is not None and prev_total is not None) else None
                entry['days'][d] = {
                    'total':      total,
                    'sales':      sales,
                    'options':    row.get('options') or [],
                    'error':      row.get('error'),
                    'fetched_at': row.get('fetched_at', ''),
                }
                if total is not None:
                    prev_total = total
            else:
                entry['days'][d] = None

        result['competitors'].append(entry)

    return jsonify(result)

@app.route('/api/fetch', methods=['POST'])
@login_required
def api_fetch():
    body = request.get_json() or {}
    cid  = body.get('id')
    if cid:
        competitors = db_get_competitors()
        comp = next((c for c in competitors if c['id'] == cid), None)
        if not comp:
            return jsonify({'error': '경쟁사를 찾을 수 없습니다'}), 404
        result = fetch_single(comp)
        db_save_stock(cid, date.today().isoformat(), result)
    else:
        fetch_all()
    return jsonify({'ok': True})

@app.route('/api/schedule', methods=['PUT'])
@login_required
def api_schedule():
    body    = request.get_json() or {}
    enabled = bool(body.get('enabled', False))
    hour    = max(0, min(23, int(body.get('hour', 9))))
    minute  = max(0, min(59, int(body.get('minute', 0))))
    db_save_schedule(enabled, hour, minute)
    _update_scheduler()
    return jsonify({'ok': True})

@app.route('/api/credentials', methods=['PUT'])
@login_required
def api_credentials():
    return jsonify({'error': 'Railway 환경변수(ADMIN_PASSWORD_HASH)에서 변경하세요'}), 400

# 쿠키 관련 — Playwright 사용으로 불필요, 하위호환 유지
@app.route('/api/cookie')
@login_required
def api_cookie():
    return jsonify({'has_cookie': False, 'preview': '', 'ext_path': ''})

@app.route('/api/ext/queue', methods=['POST'])
@login_required
def api_ext_queue():
    return jsonify({'error': 'Playwright 모드에서는 개별 조회 버튼을 사용하세요'}), 400

# ═══════════════════════════════════════════════════════════════
# 관리자 페이지: 수강생 화이트리스트 관리
# ═══════════════════════════════════════════════════════════════

@app.route('/admin/users')
@login_required
def admin_users_page():
    return render_template('admin_users.html')

@app.route('/api/admin/users', methods=['GET'])
@login_required
def api_admin_list_users():
    return jsonify({'users': db_list_approved_users()})

@app.route('/api/admin/users', methods=['POST'])
@login_required
def api_admin_add_user():
    body = request.get_json() or {}
    naver_id = (body.get('naver_id') or '').strip().lower()
    if not naver_id:
        return jsonify({'error': '네이버 ID를 입력해주세요'}), 400
    if not re.fullmatch(r'[a-z0-9_\-]{3,30}', naver_id):
        return jsonify({'error': '네이버 ID 형식이 올바르지 않습니다 (영문/숫자/_/-, 3~30자)'}), 400
    db_add_approved_user(
        naver_id     = naver_id,
        display_name = (body.get('display_name') or '').strip()[:64],
        memo         = (body.get('memo') or '').strip()[:200],
        expires_at   = (body.get('expires_at') or None),
    )
    return jsonify({'ok': True})

@app.route('/api/admin/users/bulk', methods=['POST'])
@login_required
def api_admin_bulk_add_users():
    """CSV 붙여넣기: 한 줄에 하나, 'naver_id,display_name,expires_at' 또는 'naver_id'만"""
    body = request.get_json() or {}
    text = (body.get('text') or '').strip()
    added, errors = [], []
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts  = [p.strip() for p in line.split(',')]
        naver  = parts[0].lower()
        if not re.fullmatch(r'[a-z0-9_\-]{3,30}', naver):
            errors.append(f'{i}행: ID 형식 오류 ({naver})')
            continue
        db_add_approved_user(
            naver_id     = naver,
            display_name = parts[1] if len(parts) > 1 else '',
            memo         = '',
            expires_at   = parts[2] if len(parts) > 2 and parts[2] else None,
        )
        added.append(naver)
    return jsonify({'added': added, 'errors': errors})

@app.route('/api/admin/users/<naver_id>', methods=['PUT'])
@login_required
def api_admin_update_user(naver_id):
    body = request.get_json() or {}
    fields = {}
    for key in ('display_name', 'memo', 'expires_at'):
        if key in body:
            v = body[key]
            fields[key] = (v.strip() if isinstance(v, str) else v) or None
    if 'blocked' in body:
        fields['blocked'] = bool(body['blocked'])
    db_update_approved_user(naver_id, fields)
    return jsonify({'ok': True})

@app.route('/api/admin/users/<naver_id>', methods=['DELETE'])
@login_required
def api_admin_delete_user(naver_id):
    db_delete_approved_user(naver_id)
    return jsonify({'ok': True})

@app.route('/api/admin/usage', methods=['GET'])
@login_required
def api_admin_usage():
    limit = min(int(request.args.get('limit', 200)), 1000)
    return jsonify({'logs': db_recent_usage(limit)})

@app.route('/api/admin/notices', methods=['GET'])
@login_required
def api_admin_list_notices():
    return jsonify({'notices': db_list_notices()})

@app.route('/api/admin/notices', methods=['POST'])
@login_required
def api_admin_add_notice():
    body  = request.get_json() or {}
    title = (body.get('title') or '').strip()[:200]
    text  = (body.get('body')  or '').strip()[:2000]
    if not title:
        return jsonify({'error': '제목을 입력해주세요'}), 400
    db_add_notice(title, text)
    return jsonify({'ok': True})

@app.route('/api/admin/notices/<int:nid>', methods=['PUT'])
@login_required
def api_admin_toggle_notice(nid):
    body   = request.get_json() or {}
    active = bool(body.get('active', True))
    db_set_notice_active(nid, active)
    return jsonify({'ok': True})

@app.route('/api/admin/notices/<int:nid>', methods=['DELETE'])
@login_required
def api_admin_delete_notice(nid):
    db_delete_notice(nid)
    return jsonify({'ok': True})

# ═══════════════════════════════════════════════════════════════
# 라이선스 API (수강생 PC의 로컬앱이 호출 — 인증 불필요)
# ═══════════════════════════════════════════════════════════════

def _client_ip() -> str:
    return (request.headers.get('X-Forwarded-For', '').split(',')[0].strip()
            or request.remote_addr or '')

@app.route('/api/verify', methods=['POST'])
def api_verify():
    """수강생 앱 시작 시 호출. 네이버 ID가 화이트리스트에 있는지 검증."""
    body     = request.get_json(silent=True) or {}
    naver_id = (body.get('naver_id') or '').strip().lower()
    version  = (body.get('version')  or '').strip()
    if not naver_id:
        return jsonify({'valid': False, 'reason': 'naver_id가 필요합니다'}), 400

    user = db_get_approved_user(naver_id)
    try:
        db_log_usage(naver_id, 'verify',
                     _client_ip(),
                     request.headers.get('User-Agent', ''),
                     version)
    except Exception:
        pass

    if not user:
        return jsonify({'valid': False, 'reason': '승인되지 않은 ID입니다. 강사에게 문의하세요.'})
    if user.get('blocked'):
        return jsonify({'valid': False, 'reason': '차단된 계정입니다. 강사에게 문의하세요.'})
    exp = user.get('expires_at')
    if exp and exp < date.today().isoformat():
        return jsonify({'valid': False, 'reason': f'사용 기간이 만료되었습니다 ({exp}).'})

    notice = db_active_notice()
    return jsonify({
        'valid':        True,
        'display_name': user.get('display_name') or naver_id,
        'expires_at':   exp,
        'notice':       {'title': notice['title'], 'body': notice['body']} if notice else None,
    })

@app.route('/api/heartbeat', methods=['POST'])
def api_heartbeat():
    """수강생 앱이 24시간마다 호출 — 살아있다는 신호 + 화이트리스트 재확인"""
    body     = request.get_json(silent=True) or {}
    naver_id = (body.get('naver_id') or '').strip().lower()
    version  = (body.get('version')  or '').strip()
    if not naver_id:
        return jsonify({'valid': False}), 400

    user = db_get_approved_user(naver_id)
    try:
        db_log_usage(naver_id, 'heartbeat',
                     _client_ip(),
                     request.headers.get('User-Agent', ''),
                     version)
    except Exception:
        pass

    if not user or user.get('blocked'):
        return jsonify({'valid': False, 'reason': '계정이 비활성화되었습니다'})
    exp = user.get('expires_at')
    if exp and exp < date.today().isoformat():
        return jsonify({'valid': False, 'reason': '사용 기간이 만료되었습니다'})
    return jsonify({'valid': True, 'expires_at': exp})

# ─── 시작 ─────────────────────────────────────────────────────
if __name__ == '__main__':
    scheduler.start()
    try:
        _update_scheduler()
    except Exception as e:
        print(f'스케줄러 초기화 실패 (무시): {e}')
    port = int(os.environ.get('PORT', 5000))
    print(f'서버 시작 → http://localhost:{port}')
    app.run(host='0.0.0.0', port=port, debug=False)
