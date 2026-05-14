import json, re, hashlib, threading, time, random, os, uuid, html
from datetime import datetime, date, timedelta
from functools import wraps
from zoneinfo import ZoneInfo

import httpx
from flask import Flask, request, jsonify, session, render_template, redirect, g
from apscheduler.schedulers.background import BackgroundScheduler

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'naver-monitor-dev-secret-2024')

@app.after_request
def add_cors(response):
    origin = request.headers.get('Origin', '')
    if origin.startswith('chrome-extension://'):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response

@app.route('/api/public/<path:p>', methods=['OPTIONS'])
@app.route('/api/stock-data', methods=['OPTIONS'])
def cors_preflight(p=''):
    origin = request.headers.get('Origin', '')
    resp = app.make_default_options_response()
    resp.headers['Access-Control-Allow-Origin'] = origin
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return resp

# ─── Supabase REST 클라이언트 (SDK 없이 httpx 직접 호출) ───────
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
SUPABASE_ANON_KEY = os.environ.get('SUPABASE_ANON_KEY', '')
KST = ZoneInfo('Asia/Seoul')

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

def sb_update(table: str, data: dict, col: str, val: str, extra_query: str = '') -> None:
    r = httpx.patch(
        f'{_sb_url(table)}?{col}=eq.{val}{extra_query}',
        json=data, headers=_sb_headers('return=minimal'),
    )
    r.raise_for_status()

def sb_delete(table: str, col: str, val: str, extra_query: str = '') -> None:
    r = httpx.delete(
        f'{_sb_url(table)}?{col}=eq.{val}{extra_query}',
        headers=_sb_headers('return=minimal'),
    )
    r.raise_for_status()

@app.errorhandler(httpx.HTTPStatusError)
def handle_supabase_error(exc):
    response = exc.response
    try:
        data = response.json()
    except Exception:
        data = {}
    message = data.get('message') or data.get('error') or response.text or 'Database request failed'
    return jsonify({'error': message}), 500

# ─── Admin 계정 (Railway 환경변수로 설정) ──────────────────────
ADMIN_USERNAME     = os.environ.get('ADMIN_USERNAME', 'admin')
ADMIN_EMAIL        = os.environ.get('ADMIN_EMAIL', ADMIN_USERNAME)
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

def fetch_all(user_id: str):
    """스케줄러 / 전체 조회 버튼에서 호출"""
    from playwright.sync_api import sync_playwright
    competitors = db_get_competitors(user_id)
    if not competitors:
        return
    fetch_date, fetch_key = _stock_snapshot()
    with _pw_lock:
        with sync_playwright() as pw:
            browser = _launch_browser(pw)
            for comp in competitors:
                result = _fetch_one(browser, comp['url'])
                db_save_stock(user_id, comp['id'], fetch_date, result, fetch_key)
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

def fetch_product_image(url: str) -> str:
    try:
        r = httpx.get(
            url,
            headers={
                'User-Agent': (
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/136.0.0.0 Safari/537.36'
                ),
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            follow_redirects=True,
            timeout=15,
        )
        if r.status_code >= 400:
            return ''
        match = re.search(
            r'<meta\s+(?:property|name)=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
            r.text,
            re.I,
        ) or re.search(
            r'<meta\s+content=["\']([^"\']+)["\']\s+(?:property|name)=["\']og:image["\']',
            r.text,
            re.I,
        )
        return html.unescape(match.group(1).strip()) if match else ''
    except Exception:
        return ''

def db_get_competitors(user_id: str) -> list:
    return sb_select('competitors', f'?user_id=eq.{user_id}&order=created_at')

def _stock_snapshot(now: datetime | None = None) -> tuple[str, str]:
    dt = (now or datetime.now(KST)).astimezone(KST)
    return dt.date().isoformat(), dt.strftime('%Y-%m-%d %H:%M')

def db_save_stock(user_id: str, cid: str, fetch_date: str, result: dict, fetch_key: str | None = None):
    sb_upsert('stock_history', {
        'user_id':       user_id,
        'competitor_id': cid,
        'fetch_date':    fetch_date,
        'fetch_key':     fetch_key or fetch_date,
        'total':         result.get('total'),
        'options':       result.get('options', []),
        'error':         result.get('error'),
        'fetched_at':    result.get('fetched_at', datetime.now().isoformat()),
    }, on_conflict='user_id,competitor_id,fetch_key')

def db_get_history(user_id: str, days: int = 14):
    start = (date.today() - timedelta(days=days)).isoformat()
    competitors = db_get_competitors(user_id)
    rows = sb_select(
        'stock_history',
        f'?select=competitor_id,fetch_date,fetch_key,total,options,error,fetched_at'
        f'&user_id=eq.{user_id}&fetch_date=gte.{start}&order=fetch_date',
    )
    return competitors, rows

def db_get_schedule(user_id: str) -> dict:
    keys = 'schedule_enabled,schedule_hour,schedule_minute'
    rows = sb_select('app_settings', f'?user_id=eq.{user_id}&key=in.({keys})')
    s = {row['key']: row['value'] for row in rows}
    return {
        'enabled': s.get('schedule_enabled', 'false') == 'true',
        'hour':    int(s.get('schedule_hour', 9)),
        'minute':  int(s.get('schedule_minute', 0)),
    }

def db_save_schedule(user_id: str, enabled: bool, hour: int, minute: int):
    for key, val in [
        ('schedule_enabled', str(enabled).lower()),
        ('schedule_hour',    str(hour)),
        ('schedule_minute',  str(minute)),
    ]:
        sb_upsert('app_settings', {'user_id': user_id, 'key': key, 'value': val}, on_conflict='user_id,key')

def db_get_ext_queue_ids(user_id: str) -> list:
    rows = sb_select('app_settings', f'?user_id=eq.{user_id}&key=eq.ext_queue_ids&limit=1')
    if not rows:
        return []
    try:
        ids = json.loads(rows[0].get('value') or '[]')
    except Exception:
        return []
    return [str(cid) for cid in ids if cid]

def db_save_ext_queue_ids(user_id: str, ids: list):
    sb_upsert(
        'app_settings',
        {'user_id': user_id, 'key': 'ext_queue_ids', 'value': json.dumps(ids, ensure_ascii=False)},
        on_conflict='user_id,key',
    )

def db_get_ext_queue(user_id: str) -> list:
    queued_ids = db_get_ext_queue_ids(user_id)
    if not queued_ids:
        return []
    competitors = db_get_competitors(user_id)
    by_id = {comp['id']: comp for comp in competitors}
    return [by_id[cid] for cid in queued_ids if cid in by_id]

def db_queue_competitors(user_id: str, cid: str | None = None) -> list:
    competitors = db_get_competitors(user_id)
    valid_ids = [comp['id'] for comp in competitors]
    if cid:
        if cid not in valid_ids:
            raise ValueError('경쟁사를 찾을 수 없습니다')
        target_ids = [cid]
    else:
        target_ids = valid_ids

    queued_ids = db_get_ext_queue_ids(user_id)
    for target_id in target_ids:
        if target_id not in queued_ids:
            queued_ids.append(target_id)
    db_save_ext_queue_ids(user_id, queued_ids)
    return [comp for comp in competitors if comp['id'] in target_ids]

def db_remove_ext_queue_ids(user_id: str, ids: list | None = None):
    if ids is None:
        db_save_ext_queue_ids(user_id, [])
        return
    remove_ids = {str(cid) for cid in ids}
    queued_ids = [cid for cid in db_get_ext_queue_ids(user_id) if cid not in remove_ids]
    db_save_ext_queue_ids(user_id, queued_ids)

# ─── 스케줄러 ─────────────────────────────────────────────────
scheduler = BackgroundScheduler(timezone='Asia/Seoul')

def _update_scheduler(user_id: str):
    s = db_get_schedule(user_id)
    job_id = f'daily_fetch_{user_id}'
    try:
        scheduler.remove_job(job_id)
    except Exception:
        pass
    if s['enabled']:
        scheduler.add_job(fetch_all, 'cron',
                          hour=s['hour'], minute=s['minute'],
                          id=job_id, args=[user_id])

# ─── Auth 데코레이터 ──────────────────────────────────────────
def _bearer_token() -> str:
    auth = request.headers.get('Authorization', '')
    if auth.lower().startswith('bearer '):
        return auth.split(' ', 1)[1].strip()
    return ''

def _auth_api_key() -> str:
    return SUPABASE_ANON_KEY or SUPABASE_KEY

def _auth_error(response, fallback: str) -> str:
    try:
        data = response.json()
    except Exception:
        return fallback
    return data.get('msg') or data.get('error_description') or data.get('error') or fallback

def _admin_api_headers() -> dict:
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
    }

def _is_admin_user(user: dict) -> bool:
    email = (user.get('email') or '').strip().lower()
    admin_email = (ADMIN_EMAIL or '').strip().lower()
    admin_name = (ADMIN_USERNAME or '').strip().lower()
    return bool(email and (
        email == admin_email
        or email.split('@', 1)[0] == admin_name
        or (admin_name and email == admin_name)
    ))

def _is_approved_user(user: dict) -> bool:
    if _is_admin_user(user):
        return True
    app_meta = user.get('app_metadata') or {}
    return app_meta.get('approved') is True

def _verify_supabase_user(token: str) -> dict | None:
    auth_key = _auth_api_key()
    if not token or not SUPABASE_URL or not auth_key:
        return None
    try:
        r = httpx.get(
            f'{SUPABASE_URL}/auth/v1/user',
            headers={'apikey': auth_key, 'Authorization': f'Bearer {token}'},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None

def login_required(f):
    @wraps(f)
    def dec(*args, **kwargs):
        user = _verify_supabase_user(_bearer_token())
        if not user or not user.get('id'):
            return jsonify({'error': 'Unauthorized'}), 401
        if not _is_approved_user(user):
            return jsonify({'error': '관리자 승인 후 이용할 수 있습니다.'}), 403
        g.user = user
        g.user_id = user['id']
        return f(*args, **kwargs)
    return dec

def admin_required(f):
    @wraps(f)
    def dec(*args, **kwargs):
        user = _verify_supabase_user(_bearer_token())
        if not user or not user.get('id'):
            return jsonify({'error': 'Unauthorized'}), 401
        if not _is_admin_user(user):
            return jsonify({'error': 'Admin only'}), 403
        g.user = user
        g.user_id = user['id']
        return f(*args, **kwargs)
    return dec

# ─── 라우트 ───────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login')
def login_page():
    return render_template('login.html')

@app.route('/privacy')
def privacy_page():
    return render_template('privacy.html')

@app.route('/api/auth-config')
def api_auth_config():
    return jsonify({
        'supabase_url': SUPABASE_URL,
        'uses_server_auth': True,
    })

@app.route('/api/auth/login', methods=['POST'])
def api_auth_login():
    body = request.get_json() or {}
    email = (body.get('email') or '').strip()
    password = body.get('password') or ''
    if not email or not password:
        return jsonify({'error': 'Email and password are required'}), 400
    auth_key = _auth_api_key()
    if not SUPABASE_URL or not auth_key:
        return jsonify({'error': 'Supabase auth is not configured'}), 500
    r = httpx.post(
        f'{SUPABASE_URL}/auth/v1/token?grant_type=password',
        headers={'apikey': auth_key, 'Content-Type': 'application/json'},
        json={'email': email, 'password': password},
        timeout=20,
    )
    if r.status_code >= 400:
        return jsonify({'error': _auth_error(r, 'Login failed')}), 401
    data = r.json()
    user = data.get('user') or {}
    if not _is_approved_user(user):
        return jsonify({'error': '회원가입은 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.'}), 403
    return jsonify(data)

@app.route('/api/auth/signup', methods=['POST'])
def api_auth_signup():
    body = request.get_json() or {}
    email = (body.get('email') or '').strip()
    password = body.get('password') or ''
    if not email or not password:
        return jsonify({'error': 'Email and password are required'}), 400
    auth_key = _auth_api_key()
    if not SUPABASE_URL or not auth_key:
        return jsonify({'error': 'Supabase auth is not configured'}), 500
    r = httpx.post(
        f'{SUPABASE_URL}/auth/v1/signup',
        headers={'apikey': auth_key, 'Content-Type': 'application/json'},
        params={'redirect_to': request.url_root.rstrip('/') + '/login'},
        json={
            'email': email,
            'password': password,
            'data': {'approved': False},
        },
        timeout=20,
    )
    if r.status_code >= 400:
        return jsonify({'error': _auth_error(r, 'Signup failed')}), 400
    data = r.json()
    return jsonify({
        'ok': True,
        'requires_email_confirmation': True,
        'message': '가입 확인 메일을 보냈습니다. 이메일 인증 후 관리자 승인을 기다려주세요.',
        'user': data.get('user'),
    })

@app.route('/api/auth/refresh', methods=['POST'])
def api_auth_refresh():
    body = request.get_json() or {}
    refresh_token = body.get('refresh_token') or ''
    if not refresh_token:
        return jsonify({'error': 'Refresh token is required'}), 400
    auth_key = _auth_api_key()
    if not SUPABASE_URL or not auth_key:
        return jsonify({'error': 'Supabase auth is not configured'}), 500
    r = httpx.post(
        f'{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token',
        headers={'apikey': auth_key, 'Content-Type': 'application/json'},
        json={'refresh_token': refresh_token},
        timeout=20,
    )
    if r.status_code >= 400:
        return jsonify({'error': _auth_error(r, 'Session refresh failed')}), 401
    return jsonify(r.json())

@app.route('/api/login', methods=['POST'])
def api_login():
    body = request.get_json() or {}
    if (body.get('username') == ADMIN_USERNAME
            and _hash(body.get('password', '')) == ADMIN_PASSWORD_HASH):
        return jsonify({'error': 'Supabase Auth login is required'}), 410
    return jsonify({'error': '아이디 또는 비밀번호가 올바르지 않습니다'}), 401

@app.route('/api/logout', methods=['POST'])
def api_logout():
    session.clear()
    return jsonify({'ok': True})

@app.route('/api/config')
@login_required
def api_config():
    email = g.user.get('email') or g.user.get('phone') or g.user_id
    return jsonify({
        'username':    email,
        'user_id':     g.user_id,
        'is_admin':    _is_admin_user(g.user),
        'approved':    _is_approved_user(g.user),
        'competitors': db_get_competitors(g.user_id),
        'schedule':    db_get_schedule(g.user_id),
    })

@app.route('/api/admin/users')
@admin_required
def api_admin_users():
    if not SUPABASE_URL or not SUPABASE_KEY:
        return jsonify({'error': 'Supabase service role key is not configured'}), 500
    r = httpx.get(
        f'{SUPABASE_URL}/auth/v1/admin/users',
        headers=_admin_api_headers(),
        params={'page': 1, 'per_page': 200},
        timeout=20,
    )
    if r.status_code >= 400:
        return jsonify({'error': _auth_error(r, 'Failed to load users')}), 500
    data = r.json()
    users = data.get('users', data if isinstance(data, list) else [])
    result = []
    for user in users:
        app_meta = user.get('app_metadata') or {}
        result.append({
            'id': user.get('id'),
            'email': user.get('email') or '',
            'created_at': user.get('created_at') or '',
            'last_sign_in_at': user.get('last_sign_in_at') or '',
            'email_confirmed_at': user.get('email_confirmed_at') or user.get('confirmed_at') or '',
            'approved': app_meta.get('approved') is True or _is_admin_user(user),
            'is_admin': _is_admin_user(user),
        })
    result.sort(key=lambda u: u.get('created_at') or '', reverse=True)
    return jsonify({'users': result})

@app.route('/api/admin/users/<uid>/approval', methods=['PUT'])
@admin_required
def api_admin_user_approval(uid):
    body = request.get_json() or {}
    approved = bool(body.get('approved'))
    current = httpx.get(
        f'{SUPABASE_URL}/auth/v1/admin/users/{uid}',
        headers=_admin_api_headers(),
        timeout=20,
    )
    if current.status_code >= 400:
        return jsonify({'error': _auth_error(current, 'User not found')}), 404
    user = current.json()
    app_meta = user.get('app_metadata') or {}
    app_meta['approved'] = approved
    r = httpx.put(
        f'{SUPABASE_URL}/auth/v1/admin/users/{uid}',
        headers=_admin_api_headers(),
        json={'app_metadata': app_meta},
        timeout=20,
    )
    if r.status_code >= 400:
        return jsonify({'error': _auth_error(r, 'Approval update failed')}), 500
    return jsonify({'ok': True})

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
    cid = f"c{uuid.uuid4().hex}"
    sb_insert('competitors', {
        'id': cid,
        'user_id': g.user_id,
        'name': name,
        'url': url,
        'image_url': '',
    })
    return jsonify({'ok': True, 'id': cid})

@app.route('/api/competitors/<cid>', methods=['PUT'])
@login_required
def api_update_competitor(cid):
    body   = request.get_json() or {}
    update = {k: body[k].strip() for k in ('name', 'url') if body.get(k)}
    if 'url' in update:
        update['image_url'] = ''
    if update:
        sb_update('competitors', update, 'id', cid, f'&user_id=eq.{g.user_id}')
    return jsonify({'ok': True})

@app.route('/api/competitors/<cid>', methods=['DELETE'])
@login_required
def api_delete_competitor(cid):
    sb_delete('competitors', 'id', cid, f'&user_id=eq.{g.user_id}')
    return jsonify({'ok': True})

@app.route('/api/history')
@login_required
def api_history():
    days = min(int(request.args.get('days', 14)), 60)
    competitors, rows = db_get_history(g.user_id, days)

    dates = sorted({row.get('fetch_key') or row['fetch_date'] for row in rows})

    # {competitor_id: {fetch_key: row}}
    hmap: dict = {}
    for row in rows:
        hmap.setdefault(row['competitor_id'], {})[row.get('fetch_key') or row['fetch_date']] = row

    last_fetched = max((r.get('fetched_at', '') for r in rows), default='')

    result = {'dates': dates, 'competitors': [], 'last_fetched': last_fetched}

    for comp in competitors:
        cid   = comp['id']
        entry = {
            'id': cid,
            'name': comp['name'],
            'url': comp['url'],
            'image_url': comp.get('image_url') or '',
            'days': {},
        }
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
        competitors = db_get_competitors(g.user_id)
        comp = next((c for c in competitors if c['id'] == cid), None)
        if not comp:
            return jsonify({'error': '경쟁사를 찾을 수 없습니다'}), 404
        result = fetch_single(comp)
        fetch_date, fetch_key = _stock_snapshot()
        db_save_stock(g.user_id, cid, fetch_date, result, fetch_key)
    else:
        fetch_all(g.user_id)
    return jsonify({'ok': True})

@app.route('/api/schedule', methods=['PUT'])
@login_required
def api_schedule():
    body    = request.get_json() or {}
    enabled = bool(body.get('enabled', False))
    hour    = max(0, min(23, int(body.get('hour', 9))))
    minute  = max(0, min(59, int(body.get('minute', 0))))
    db_save_schedule(g.user_id, enabled, hour, minute)
    _update_scheduler(g.user_id)
    return jsonify({'ok': True})

@app.route('/api/credentials', methods=['PUT'])
@login_required
def api_credentials():
    return jsonify({'error': 'Railway 환경변수(ADMIN_PASSWORD_HASH)에서 변경하세요'}), 400

# 쿠키 관련 — Playwright 사용으로 불필요, 하위호환 유지
@app.route('/api/cookie')
@login_required
def api_cookie():
    ext_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'chrome_extension'))
    return jsonify({'has_cookie': False, 'preview': '', 'ext_path': ext_path})

@app.route('/api/ext/queue', methods=['POST'])
@login_required
def api_ext_queue():
    body = request.get_json() or {}
    try:
        queued = db_queue_competitors(g.user_id, body.get('id'))
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    return jsonify({'ok': True, 'count': len(queued)})

# ─── 크롬 확장프로그램용 Public API (인증 불필요) ────────────────

@app.route('/api/public/competitors')
@login_required
def api_public_competitors():
    return jsonify({'competitors': db_get_competitors(g.user_id)})

@app.route('/api/public/queue', methods=['GET'])
@login_required
def api_public_queue_get():
    return jsonify({'queue': db_get_ext_queue(g.user_id)})

@app.route('/api/public/queue', methods=['DELETE'])
@login_required
def api_public_queue_delete():
    body = request.get_json(silent=True) or {}
    ids = body.get('ids')
    db_remove_ext_queue_ids(g.user_id, ids if isinstance(ids, list) else None)
    return jsonify({'ok': True})

@app.route('/api/stock-data', methods=['POST'])
@login_required
def api_stock_data():
    body = request.get_json() or {}
    results = body.get('results', [])
    fetch_date, fetch_key = _stock_snapshot()
    for r in results:
        cid = r.get('id')
        if not cid:
            continue
        image_url = (r.get('image_url') or '').strip()
        if image_url:
            sb_update('competitors', {'image_url': image_url}, 'id', cid, f'&user_id=eq.{g.user_id}')
        db_save_stock(g.user_id, cid, fetch_date, {
            'total':      r.get('total'),
            'options':    r.get('options', []),
            'error':      r.get('error'),
            'fetched_at': r.get('fetched_at', datetime.now().isoformat()),
        }, fetch_key)
    return jsonify({'ok': True})

# ─── 시작 ─────────────────────────────────────────────────────
if __name__ == '__main__':
    scheduler.start()
    try:
        pass
    except Exception as e:
        print(f'스케줄러 초기화 실패 (무시): {e}')
    port = int(os.environ.get('PORT', 5000))
    print(f'서버 시작 → http://localhost:{port}')
    app.run(host='0.0.0.0', port=port, debug=False)
