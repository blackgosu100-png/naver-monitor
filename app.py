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
            'Chrome/124.0.0.0 Safari/537.36'
        ),
        locale='ko-KR',
        extra_http_headers={'Accept-Language': 'ko-KR,ko;q=0.9'},
    )
    page = context.new_page()
    captured: dict = {}

    def on_response(resp):
        u = resp.url
        ct = resp.headers.get('content-type', '')
        if 'json' not in ct:
            return
        is_product_api = (
            ('/i/v2/channels/' in u and '/products/' in u) or
            ('/products/' in u and 'naver.com' in u)
        )
        if is_product_api:
            print(f'[DEBUG] captured: {u}', flush=True)
            try:
                captured['product'] = resp.json()
            except Exception:
                pass

    page.on('response', on_response)

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(3_500)

        print(f'[DEBUG] captured keys: {list(captured.keys())}', flush=True)

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
        args=['--no-sandbox', '--disable-setuid-sandbox',
              '--disable-dev-shm-usage', '--disable-gpu'],
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
