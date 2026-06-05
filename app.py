import json, re, hashlib, threading, time, random, os, uuid, html, calendar
from datetime import datetime, date, timedelta
from functools import wraps
from zoneinfo import ZoneInfo

import httpx
from flask import Flask, request, jsonify, session, render_template, redirect, g, send_from_directory
from apscheduler.schedulers.background import BackgroundScheduler
from urllib.parse import parse_qs, urlparse

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'naver-monitor-dev-secret-2024')
APP_VERSION = '5.69'

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
FREE_COMPETITOR_LIMIT = int(os.environ.get('FREE_COMPETITOR_LIMIT', '3'))
PLAN_LIMITS = {
    'free': FREE_COMPETITOR_LIMIT,
    'basic': 10,
    'pro': 20,
    'business': 50,
}
PLAN_LABELS = {
    'free': '무료',
    'basic': '베이직',
    'pro': '프로',
    'business': '비즈니스',
    'admin': '관리자',
    'unlimited': '무제한',
}
PLAN_PRICING = [
    {'id': 'free', 'label': '무료', 'price': '0원', 'period': '', 'months': 0, 'competitor_limit': 3, 'recommended': False, 'note': '승인 없이 바로 사용'},
    {'id': 'basic', 'label': '베이직', 'price': '19,900원', 'period': '3개월', 'months': 3, 'competitor_limit': 10, 'recommended': False, 'note': '가볍게 확장'},
    {'id': 'pro', 'label': '프로', 'price': '39,900원', 'period': '6개월', 'months': 6, 'competitor_limit': 20, 'recommended': True, 'note': '추천 플랜'},
    {'id': 'business', 'label': '비즈니스', 'price': '149,000원', 'period': '6개월', 'months': 6, 'competitor_limit': 50, 'recommended': False, 'note': '상담 후 활성화'},
]
PAID_PLAN_IDS = {'basic', 'pro', 'business'}

def _plan_meta(plan: str) -> dict:
    return next((item for item in PLAN_PRICING if item['id'] == plan), {})

def _today_kst() -> date:
    return datetime.now(KST).date()

def _add_months(day: date, months: int) -> date:
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(day.day, last_day))

def _parse_iso_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except Exception:
        return None

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
ADMIN_EMAIL        = os.environ.get('ADMIN_EMAIL', 'noahpark12@naver.com')
ADMIN_EMAILS       = [
    email.strip().lower()
    for email in os.environ.get('ADMIN_EMAILS', ADMIN_EMAIL).split(',')
    if email.strip()
]
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

def is_ohouse_url(url: str) -> bool:
    return bool(re.search(r'store\.ohou\.se/goods/\d+', url or '', re.I))

def is_coupang_url(url: str) -> bool:
    return bool(re.search(r'coupang\.com/(?:vp/)?products/\d+', url or '', re.I))

def ohouse_goods_id(url: str) -> str | None:
    match = re.search(r'store\.ohou\.se/goods/(\d+)', url or '', re.I)
    return match.group(1) if match else None

def coupang_product_params(url: str) -> tuple[str | None, str | None, str | None]:
    parsed = urlparse(url or '')
    query = parse_qs(parsed.query)
    product_match = re.search(r'/products/(\d+)', parsed.path or '', re.I)
    product_id = product_match.group(1) if product_match else None
    item_id = (query.get('itemId') or query.get('itemid') or [None])[0]
    vendor_item_id = (query.get('vendorItemId') or query.get('vendoritemid') or [None])[0]
    return product_id, item_id, vendor_item_id

def coupang_url_requires_vendor(url: str) -> str | None:
    if not is_coupang_url(url):
        return None
    _, item_id, vendor_item_id = coupang_product_params(url)
    if item_id and vendor_item_id:
        return None
    return '쿠팡 재고조회는 itemId와 vendorItemId가 포함된 상품 URL을 등록해야 합니다. 쿠팡 상품 페이지에서 옵션을 선택한 뒤 주소창의 전체 URL을 복사해 주세요.'

def competitor_market(url: str) -> str:
    if is_ohouse_url(url):
        return 'ohouse'
    if is_coupang_url(url):
        return 'coupang'
    return 'naver'

def _fetch_ohouse(url: str) -> dict:
    gid = ohouse_goods_id(url)
    if not gid:
        return _err('오늘의집 상품 ID를 찾을 수 없습니다')
    try:
        r = httpx.get(
            f'https://store.ohou.se/api/goods/options?id={gid}',
            headers={
                'User-Agent': (
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/136.0.0.0 Safari/537.36'
                ),
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': f'https://store.ohou.se/goods/{gid}',
            },
            timeout=20,
            follow_redirects=True,
        )
        if r.status_code == 404:
            return _err('오늘의집 상품을 찾을 수 없습니다. URL의 goods 번호가 실제 오늘의집 상품인지 확인해주세요.')
        if r.status_code >= 400:
            return _err(f'오늘의집 옵션 API 오류: HTTP {r.status_code}')
        data = r.json()
        production = data.get('production') or {}
        image_url = ((production.get('image') or {}).get('url') or '').strip()
        options = []
        for opt in production.get('options') or []:
            name_parts = [opt.get('explain') or '', opt.get('explain2') or '']
            name = ' / '.join(part for part in name_parts if part).strip() or '옵션'
            stock = opt.get('stock')
            if stock is None:
                continue
            options.append({'name': name, 'qty': int(stock)})
        if not options:
            if production.get('isSoldOut') is True:
                return _ok([{'name': '전체', 'qty': 0}])
            return _err('오늘의집 옵션 재고를 찾을 수 없습니다')
        result = _ok(options)
        if image_url:
            result['image_url'] = image_url
        return result
    except Exception as e:
        return _err(str(e)[:300])

def _fetch_coupang(url: str) -> dict:
    product_id, item_id, vendor_item_id = coupang_product_params(url)
    if not product_id:
        return _err('쿠팡 상품 ID를 찾을 수 없습니다')

    headers = {
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/136.0.0.0 Safari/537.36'
        ),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': url,
    }

    try:
        if not vendor_item_id:
            page = httpx.get(url, headers={**headers, 'Accept': 'text/html,application/xhtml+xml'}, timeout=20, follow_redirects=True)
            if page.status_code >= 400:
                return _err(f'쿠팡 상품 페이지 오류: HTTP {page.status_code}')
            vendor_match = re.search(r'"vendorItemId"\s*:\s*"?(\d+)"?', page.text)
            item_match = re.search(r'"itemId"\s*:\s*"?(\d+)"?', page.text)
            vendor_item_id = vendor_match.group(1) if vendor_match else None
            item_id = item_id or (item_match.group(1) if item_match else None)

        if not vendor_item_id:
            return _err('쿠팡 vendorItemId를 찾을 수 없습니다. 상품 URL에 vendorItemId가 포함되어야 합니다.')

        params = {
            'productId': product_id,
            'vendorItemId': vendor_item_id,
            'deliveryToggle': 'true',
            'landingProductId': product_id,
            'landingVendorItemId': vendor_item_id,
        }
        if item_id:
            params['landingItemId'] = item_id

        r = httpx.get(
            'https://www.coupang.com/next-api/products/quantity-info',
            params=params,
            headers=headers,
            timeout=20,
            follow_redirects=True,
        )
        if r.status_code >= 400:
            return _err(f'쿠팡 월간 구매 API 오류: HTTP {r.status_code}')

        data = r.json()
        base = data[0] if isinstance(data, list) and data else data
        modules = base.get('moduleData') if isinstance(base, dict) else []
        social = next((
            item for item in (modules or [])
            if item.get('viewType') == 'PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE'
            and item.get('type') == 'purchase'
        ), None)
        if not social:
            return _err('쿠팡 월간 구매 데이터가 노출되지 않는 상품입니다')

        count = social.get('socialProofNumUsers')
        if count is None:
            highlight_digits = re.sub(r'\D+', '', social.get('highlightText') or '')
            count = int(highlight_digits) if highlight_digits else None
        if count is None:
            return _err('쿠팡 월간 구매 수치를 찾을 수 없습니다')

        count = int(count)
        highlight = (social.get('highlightText') or '').strip()
        return {
            'total': count,
            'options': [{'name': highlight or '한 달간 구매 추정', 'qty': count}],
            'error': None,
            'fetched_at': datetime.now().isoformat(),
        }
    except Exception as e:
        return _err(str(e)[:300])

def _fetch_one(browser, url: str) -> dict:
    """Playwright 브라우저 컨텍스트 1개로 URL 1개 조회"""
    if is_ohouse_url(url):
        return _fetch_ohouse(url)
    if is_coupang_url(url):
        return _fetch_coupang(url)
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

def user_plan(user: dict) -> str:
    if _is_admin_user(user):
        return 'admin'
    app_meta = user.get('app_metadata') or {}
    raw = str(app_meta.get('plan') or app_meta.get('tier') or '').strip().lower()
    aliases = {
        'starter': 'basic',
        '베이직': 'basic',
        'paid': 'pro',
        'premium': 'pro',
        '프로': 'pro',
        'biz': 'business',
        'enterprise': 'business',
        '비즈니스': 'business',
    }
    plan = aliases.get(raw, raw)
    if plan in PLAN_LIMITS or plan in ('unlimited',):
        return plan
    if app_meta.get('approved') is True:
        return 'pro'
    return 'free'

def user_plan_label(user: dict) -> str:
    return PLAN_LABELS.get(user_plan(user), '무료')

def user_plan_dates(user: dict) -> dict:
    app_meta = user.get('app_metadata') or {}
    started = _parse_iso_date(app_meta.get('plan_started_at'))
    expires = _parse_iso_date(app_meta.get('plan_expires_at'))
    today = _today_kst()
    is_expired = expires is not None and expires < today
    remaining_days = (expires - today).days if expires else None
    return {
        'started_at': started.isoformat() if started else None,
        'expires_at': expires.isoformat() if expires else None,
        'remaining_days': remaining_days,
        'is_expired': is_expired,
    }

def is_plan_expired(user: dict) -> bool:
    return user_plan_dates(user)['is_expired']

def competitor_limit_for_user(user: dict) -> int | None:
    plan = user_plan(user)
    if plan in ('admin', 'unlimited'):
        return None
    if plan in PAID_PLAN_IDS and is_plan_expired(user):
        return FREE_COMPETITOR_LIMIT
    app_meta = user.get('app_metadata') or {}
    custom_limit = app_meta.get('competitor_limit') or app_meta.get('custom_competitor_limit')
    if plan == 'business' and custom_limit not in (None, ''):
        try:
            limit = int(custom_limit)
            if limit > 0:
                return limit
        except (TypeError, ValueError):
            pass
    return PLAN_LIMITS.get(plan, FREE_COMPETITOR_LIMIT)

def active_competitors_for_user(user: dict, competitors: list | None = None) -> list:
    competitors = competitors if competitors is not None else db_get_competitors(user.get('id'))
    limit = competitor_limit_for_user(user)
    if limit is None:
        return competitors
    return competitors[:limit]

def active_competitor_ids_for_user(user: dict, competitors: list | None = None) -> set:
    return {comp.get('id') for comp in active_competitors_for_user(user, competitors)}

def _stock_snapshot(now: datetime | None = None) -> tuple[str, str]:
    dt = (now or datetime.now(KST)).astimezone(KST)
    return dt.date().isoformat(), dt.strftime('%Y-%m-%d %H:%M:%S')

def db_save_stock(user_id: str, cid: str, fetch_date: str, result: dict, fetch_key: str | None = None):
    image_url = (result.get('image_url') or '').strip()
    if image_url:
        sb_update('competitors', {'image_url': image_url}, 'id', cid, f'&user_id=eq.{user_id}')
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

def latest_stock_by_competitor(user_id: str, days: int = 30) -> dict:
    _, rows = db_get_history(user_id, days)
    latest: dict = {}
    for row in sorted(rows, key=lambda item: item.get('fetched_at') or ''):
        if row.get('error') or row.get('total') is None:
            continue
        try:
            latest[row['competitor_id']] = int(row.get('total'))
        except (TypeError, ValueError):
            continue
    return latest

SCHEDULE_MARKETS = ['naver', 'ohouse', 'coupang_stock']

def normalize_schedule_markets(value) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            value = [item.strip() for item in value.split(',')]
    if not isinstance(value, list):
        value = SCHEDULE_MARKETS
    allowed = set(SCHEDULE_MARKETS)
    result = []
    for item in value:
        item = str(item or '').strip().lower()
        if item in allowed and item not in result:
            result.append(item)
    return result or SCHEDULE_MARKETS

def db_get_schedule(user_id: str) -> dict:
    keys = 'schedule_enabled,schedule_hour,schedule_minute,schedule_markets'
    rows = sb_select('app_settings', f'?user_id=eq.{user_id}&key=in.({keys})')
    s = {row['key']: row['value'] for row in rows}
    return {
        'enabled': s.get('schedule_enabled', 'false') == 'true',
        'hour':    int(s.get('schedule_hour', 9)),
        'minute':  int(s.get('schedule_minute', 0)),
        'markets': normalize_schedule_markets(s.get('schedule_markets')),
    }

def db_save_schedule(user_id: str, enabled: bool, hour: int, minute: int, markets: list | None = None):
    for key, val in [
        ('schedule_enabled', str(enabled).lower()),
        ('schedule_hour',    str(hour)),
        ('schedule_minute',  str(minute)),
        ('schedule_markets', json.dumps(normalize_schedule_markets(markets), ensure_ascii=False)),
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

def normalize_ext_fetch_mode(value) -> str:
    value = str(value or '').strip().lower()
    if value in ('coupang_stock', 'stock'):
        return 'coupang_stock'
    if value in ('coupang_sales', 'sales'):
        return 'coupang_sales'
    return ''

def db_get_ext_queue_fetch_mode(user_id: str) -> str:
    rows = sb_select('app_settings', f'?user_id=eq.{user_id}&key=eq.ext_queue_fetch_mode&limit=1')
    if not rows:
        return ''
    return normalize_ext_fetch_mode(rows[0].get('value') or '')

def db_save_ext_queue_fetch_mode(user_id: str, fetch_mode: str):
    sb_upsert(
        'app_settings',
        {'user_id': user_id, 'key': 'ext_queue_fetch_mode', 'value': normalize_ext_fetch_mode(fetch_mode)},
        on_conflict='user_id,key',
    )

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

def db_queue_competitors(user_id: str, cid: str | None = None, user: dict | None = None, fetch_mode: str = '') -> list:
    competitors = db_get_competitors(user_id)
    valid_ids = [comp['id'] for comp in competitors]
    active_ids = valid_ids if user is None else [comp['id'] for comp in active_competitors_for_user(user, competitors)]
    if cid:
        if cid not in valid_ids:
            raise ValueError('경쟁사를 찾을 수 없습니다')
        if cid not in active_ids:
            raise ValueError('현재 플랜에서는 등록순 상위 상품만 조회할 수 있습니다. 계속 조회하려면 플랜을 연장하거나 업그레이드해주세요.')
        target_ids = [cid]
    else:
        target_ids = active_ids

    queued_ids = db_get_ext_queue_ids(user_id)
    for target_id in target_ids:
        if target_id not in queued_ids:
            queued_ids.append(target_id)
    db_save_ext_queue_ids(user_id, queued_ids)
    db_save_ext_queue_fetch_mode(user_id, fetch_mode)
    return [comp for comp in competitors if comp['id'] in target_ids]

def db_remove_ext_queue_ids(user_id: str, ids: list | None = None):
    if ids is None:
        db_save_ext_queue_ids(user_id, [])
        db_save_ext_queue_fetch_mode(user_id, '')
        return
    remove_ids = {str(cid) for cid in ids}
    queued_ids = [cid for cid in db_get_ext_queue_ids(user_id) if cid not in remove_ids]
    db_save_ext_queue_ids(user_id, queued_ids)
    if not queued_ids:
        db_save_ext_queue_fetch_mode(user_id, '')

def db_get_fetch_logs(user_id: str) -> list:
    rows = sb_select('app_settings', f'?user_id=eq.{user_id}&key=eq.fetch_logs&limit=1')
    if not rows:
        return []
    try:
        logs = json.loads(rows[0].get('value') or '[]')
    except Exception:
        return []
    return logs if isinstance(logs, list) else []

def db_save_fetch_logs(user_id: str, logs: list):
    sb_upsert(
        'app_settings',
        {'user_id': user_id, 'key': 'fetch_logs', 'value': json.dumps(logs[:50], ensure_ascii=False)},
        on_conflict='user_id,key',
    )

def db_append_fetch_log(user_id: str, log: dict):
    if not isinstance(log, dict):
        return
    item_logs = log.get('items') if isinstance(log.get('items'), list) else []
    slim_items = []
    for item in item_logs[:200]:
        if not isinstance(item, dict):
            continue
        slim_items.append({
            'name': str(item.get('name') or '')[:160],
            'market': str(item.get('market') or '')[:30],
            'status': str(item.get('status') or '')[:30],
            'elapsedMs': int(item.get('elapsedMs') or 0),
            'error': str(item.get('error') or '')[:240],
        })
    entry = {
        'runId': str(log.get('runId') or '')[:80],
        'mode': str(log.get('mode') or '')[:40],
        'phase': str(log.get('phase') or '')[:40],
        'startedAt': str(log.get('startedAt') or '')[:40],
        'finishedAt': str(log.get('finishedAt') or '')[:40],
        'elapsedMs': int(log.get('elapsedMs') or 0),
        'total': int(log.get('total') or 0),
        'ok': int(log.get('ok') or 0),
        'errors': int(log.get('errors') or 0),
        'stopped': bool(log.get('stopped')),
        'scheduled': bool(log.get('scheduled')),
        'message': str(log.get('message') or '')[:300],
        'items': slim_items,
    }
    logs = db_get_fetch_logs(user_id)
    db_save_fetch_logs(user_id, [entry] + logs)

# ─── 스케줄러 ─────────────────────────────────────────────────
scheduler = BackgroundScheduler(timezone='Asia/Seoul')

def _update_scheduler(user_id: str):
    job_id = f'daily_fetch_{user_id}'
    try:
        scheduler.remove_job(job_id)
    except Exception:
        pass
    # Browser-backed markets run from the Chrome extension alarm.
    # Keep the legacy server scheduler disabled so saved market choices are honored.

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
    admin_name = (ADMIN_USERNAME or '').strip().lower()
    return bool(email and (
        email in ADMIN_EMAILS
        or email.split('@', 1)[0] == admin_name
        or (admin_name and email == admin_name)
    ))

def _is_approved_user(user: dict) -> bool:
    return True

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

@app.route('/ui')
def ui_preview_index():
    return send_from_directory('ui_previews', 'index.html')

@app.route('/ui/<path:filename>')
def ui_preview_file(filename):
    return send_from_directory('ui_previews', filename)

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
            'data': {'plan': 'free'},
        },
        timeout=20,
    )
    if r.status_code >= 400:
        return jsonify({'error': _auth_error(r, 'Signup failed')}), 400
    data = r.json()
    return jsonify({
        'ok': True,
        'plan': 'free',
        'message': '회원가입이 완료되었습니다. 무료 플랜으로 경쟁사 상품 3개까지 바로 사용할 수 있습니다.',
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
    competitors = db_get_competitors(g.user_id)
    competitors = [{**comp, 'market': competitor_market(comp.get('url') or '')} for comp in competitors]
    competitor_limit = competitor_limit_for_user(g.user)
    plan = user_plan(g.user)
    plan_dates = user_plan_dates(g.user)
    return jsonify({
        'username':    email,
        'app_version': APP_VERSION,
        'user_id':     g.user_id,
        'is_admin':    _is_admin_user(g.user),
        'approved':    _is_approved_user(g.user),
        'plan':        plan,
        'plan_label':  PLAN_LABELS.get(plan, '무료'),
        'plan_started_at': plan_dates['started_at'],
        'plan_expires_at': plan_dates['expires_at'],
        'plan_remaining_days': plan_dates['remaining_days'],
        'plan_expired': plan_dates['is_expired'],
        'pricing':     PLAN_PRICING,
        'competitors': competitors,
        'competitor_limit': competitor_limit,
        'competitor_count': len(competitors),
        'active_competitor_ids': list(active_competitor_ids_for_user(g.user, competitors)),
        'schedule':    db_get_schedule(g.user_id),
    })

@app.route('/api/coupang-helper-folder', methods=['POST'])
@login_required
def api_coupang_helper_folder():
    base_dir = os.path.abspath(os.path.dirname(__file__))
    launcher = os.path.join(base_dir, 'run_coupang_stock_helper.bat')
    if os.name != 'nt':
        return jsonify({'error': '도우미 폴더 열기는 Windows 로컬 실행 환경에서만 사용할 수 있습니다.'}), 400
    if not os.path.exists(launcher):
        return jsonify({'error': 'run_coupang_stock_helper.bat 파일을 찾을 수 없습니다.'}), 404
    try:
        os.startfile(base_dir)  # type: ignore[attr-defined]
    except Exception as exc:
        return jsonify({'error': f'도우미 폴더를 열지 못했습니다: {exc}'}), 500
    return jsonify({
        'ok': True,
        'folder': base_dir,
        'launcher': launcher,
        'message': '폴더가 열렸습니다. run_coupang_stock_helper.bat를 실행한 뒤 재고 조회를 시작하세요.',
    })

@app.route('/api/plan-request', methods=['POST'])
@login_required
def api_plan_request():
    body = request.get_json() or {}
    plan = str(body.get('plan') or '').strip().lower()
    if plan not in PAID_PLAN_IDS:
        return jsonify({'error': '신청할 수 없는 플랜입니다'}), 400
    request_payload = {
        'plan': plan,
        'plan_label': PLAN_LABELS.get(plan, plan),
        'status': 'pending',
        'requested_at': datetime.now(KST).isoformat(),
    }
    sb_upsert(
        'app_settings',
        {
            'user_id': g.user_id,
            'key': 'plan_request',
            'value': json.dumps(request_payload, ensure_ascii=False),
        },
        on_conflict='user_id,key',
    )
    return jsonify({
        'ok': True,
        'message': f'{PLAN_LABELS.get(plan, plan)} 플랜 신청이 접수되었습니다. 관리자가 확인 후 전환해드립니다.',
        'request': request_payload,
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
    plan_requests = {}
    try:
        rows = sb_select('app_settings', '?select=user_id,value&key=eq.plan_request')
        for row in rows:
            try:
                plan_requests[row.get('user_id')] = json.loads(row.get('value') or '{}')
            except Exception:
                plan_requests[row.get('user_id')] = {'status': 'pending'}
    except Exception:
        plan_requests = {}
    result = []
    for user in users:
        plan = user_plan(user)
        plan_dates = user_plan_dates(user)
        result.append({
            'id': user.get('id'),
            'email': user.get('email') or '',
            'created_at': user.get('created_at') or '',
            'last_sign_in_at': user.get('last_sign_in_at') or '',
            'email_confirmed_at': user.get('email_confirmed_at') or user.get('confirmed_at') or '',
            'approved': plan not in ('free',),
            'plan': plan,
            'plan_label': PLAN_LABELS.get(plan, '무료'),
            'competitor_limit': competitor_limit_for_user(user),
            'plan_started_at': plan_dates['started_at'],
            'plan_expires_at': plan_dates['expires_at'],
            'plan_remaining_days': plan_dates['remaining_days'],
            'plan_expired': plan_dates['is_expired'],
            'plan_request': plan_requests.get(user.get('id')),
            'is_admin': _is_admin_user(user),
        })
    result.sort(key=lambda u: u.get('created_at') or '', reverse=True)
    return jsonify({'users': result})

@app.route('/api/admin/fetch-logs')
@admin_required
def api_admin_fetch_logs():
    rows = sb_select('app_settings', '?select=user_id,value&key=eq.fetch_logs')
    email_by_id = {}
    try:
        if SUPABASE_URL and SUPABASE_KEY:
            r = httpx.get(
                f'{SUPABASE_URL}/auth/v1/admin/users',
                headers=_admin_api_headers(),
                params={'page': 1, 'per_page': 200},
                timeout=20,
            )
            if r.status_code < 400:
                data = r.json()
                users = data.get('users', data if isinstance(data, list) else [])
                email_by_id = {u.get('id'): (u.get('email') or '') for u in users}
    except Exception:
        email_by_id = {}
    logs = []
    for row in rows:
        user_id = row.get('user_id') or ''
        try:
            entries = json.loads(row.get('value') or '[]')
        except Exception:
            entries = []
        if not isinstance(entries, list):
            continue
        for entry in entries[:20]:
            if not isinstance(entry, dict):
                continue
            logs.append({**entry, 'user_id': user_id, 'email': email_by_id.get(user_id, '')})
    logs.sort(key=lambda item: item.get('startedAt') or '', reverse=True)
    return jsonify({'logs': logs[:100]})

@app.route('/api/admin/users/<uid>/plan', methods=['PUT'])
@admin_required
def api_admin_user_plan(uid):
    body = request.get_json() or {}
    plan = str(body.get('plan') or '').strip().lower()
    if plan not in PLAN_LIMITS:
        return jsonify({'error': '지원하지 않는 플랜입니다'}), 400
    current = httpx.get(
        f'{SUPABASE_URL}/auth/v1/admin/users/{uid}',
        headers=_admin_api_headers(),
        timeout=20,
    )
    if current.status_code >= 400:
        return jsonify({'error': _auth_error(current, 'User not found')}), 404
    user = current.json()
    app_meta = user.get('app_metadata') or {}
    app_meta['plan'] = plan
    app_meta['approved'] = plan != 'free'
    if plan == 'business':
        raw_limit = body.get('competitor_limit')
        if raw_limit in (None, ''):
            raw_limit = PLAN_LIMITS['business']
        try:
            competitor_limit = int(raw_limit)
        except (TypeError, ValueError):
            return jsonify({'error': '비즈니스 상품 수량은 숫자로 입력해 주세요.'}), 400
        if competitor_limit < 1 or competitor_limit > 1000:
            return jsonify({'error': '비즈니스 상품 수량은 1개 이상 1000개 이하로 입력해 주세요.'}), 400
        app_meta['competitor_limit'] = competitor_limit
    else:
        app_meta.pop('competitor_limit', None)
        app_meta.pop('custom_competitor_limit', None)
    if plan in PAID_PLAN_IDS:
        started = _today_kst()
        expires = _add_months(started, int(_plan_meta(plan).get('months') or 0))
        app_meta['plan_started_at'] = started.isoformat()
        app_meta['plan_expires_at'] = expires.isoformat()
    else:
        app_meta.pop('plan_started_at', None)
        app_meta.pop('plan_expires_at', None)
    r = httpx.put(
        f'{SUPABASE_URL}/auth/v1/admin/users/{uid}',
        headers=_admin_api_headers(),
        json={'app_metadata': app_meta},
        timeout=20,
    )
    if r.status_code >= 400:
        return jsonify({'error': _auth_error(r, 'Plan update failed')}), 500
    return jsonify({
        'ok': True,
        'plan': plan,
        'plan_label': PLAN_LABELS.get(plan, '무료'),
        'competitor_limit': competitor_limit_for_user({'app_metadata': app_meta}),
    })

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
    app_meta['plan'] = 'pro' if approved else 'free'
    if approved:
        started = _today_kst()
        app_meta['plan_started_at'] = started.isoformat()
        app_meta['plan_expires_at'] = _add_months(started, int(_plan_meta('pro').get('months') or 6)).isoformat()
    else:
        app_meta.pop('plan_started_at', None)
        app_meta.pop('plan_expires_at', None)
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
    is_naver_url = re.search(r'(?:smartstore|brand)\.naver\.com/.+/products/\d+', url)
    is_ohouse_url = re.search(r'store\.ohou\.se/goods/\d+', url)
    is_coupang_product_url = is_coupang_url(url)
    coupang_vendor_error = coupang_url_requires_vendor(url)
    if coupang_vendor_error:
        return jsonify({'error': coupang_vendor_error}), 400
    if not (is_naver_url or is_ohouse_url or is_coupang_product_url):
        return jsonify({'error': '네이버 스마트스토어, 오늘의집, 쿠팡 상품 URL이어야 합니다'}), 400
    competitor_limit = competitor_limit_for_user(g.user)
    if competitor_limit is not None and len(db_get_competitors(g.user_id)) >= competitor_limit:
        return jsonify({'error': f'{user_plan_label(g.user)} 플랜은 경쟁사 상품을 {competitor_limit}개까지만 등록할 수 있습니다.'}), 403
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
        coupang_vendor_error = coupang_url_requires_vendor(update['url'])
        if coupang_vendor_error:
            return jsonify({'error': coupang_vendor_error}), 400
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
            'market': competitor_market(comp.get('url') or ''),
            'image_url': comp.get('image_url') or '',
            'days': {},
        }
        prev_total = None

        for d in dates:
            row = hmap.get(cid, {}).get(d)
            if row:
                total = row.get('total')
                if total is not None and prev_total is not None:
                    sales = (total - prev_total) if entry['market'] == 'coupang' else (prev_total - total)
                else:
                    sales = None
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
    market = str(body.get('market') or '').strip().lower()
    active_ids = active_competitor_ids_for_user(g.user)
    if cid:
        competitors = db_get_competitors(g.user_id)
        comp = next((c for c in competitors if c['id'] == cid), None)
        if not comp:
            return jsonify({'error': '경쟁사를 찾을 수 없습니다'}), 404
        if cid not in active_ids:
            return jsonify({'error': '현재 플랜에서는 등록순 상위 상품만 조회할 수 있습니다. 계속 조회하려면 플랜을 연장하거나 업그레이드해주세요.'}), 403
        if competitor_market(comp.get('url') or '') != 'ohouse':
            return jsonify({'error': '이 조회 버튼은 오늘의집 전용입니다. 네이버와 쿠팡은 각 탭에서 확장프로그램 조회로 실행해주세요.'}), 400
        queued = db_queue_competitors(g.user_id, cid, g.user)
        db_save_ext_queue_fetch_mode(g.user_id, '')
        return jsonify({'ok': True, 'queued': True, 'count': len(queued)})
    else:
        competitors = active_competitors_for_user(g.user)
        if market and market != 'ohouse':
            return jsonify({'error': '서버 직접조회는 오늘의집만 실행합니다. 네이버와 쿠팡은 확장프로그램 조회를 사용해주세요.'}), 400
        ohouse_ids = [
            comp['id'] for comp in competitors
            if competitor_market(comp.get('url') or '') == 'ohouse'
        ]
        queued_ids = db_get_ext_queue_ids(g.user_id)
        for target_id in ohouse_ids:
            if target_id not in queued_ids:
                queued_ids.append(target_id)
        db_save_ext_queue_ids(g.user_id, queued_ids)
        db_save_ext_queue_fetch_mode(g.user_id, '')
        return jsonify({'ok': True, 'queued': True, 'count': len(ohouse_ids)})
    return jsonify({'ok': True, 'queued': True})

@app.route('/api/schedule', methods=['PUT'])
@login_required
def api_schedule():
    body    = request.get_json() or {}
    enabled = bool(body.get('enabled', False))
    hour    = max(0, min(23, int(body.get('hour', 9))))
    minute  = max(0, min(59, int(body.get('minute', 0))))
    markets = normalize_schedule_markets(body.get('markets'))
    db_save_schedule(g.user_id, enabled, hour, minute, markets)
    _update_scheduler(g.user_id)
    return jsonify({'ok': True})

@app.route('/api/fetch-log', methods=['POST'])
@login_required
def api_fetch_log():
    body = request.get_json() or {}
    db_append_fetch_log(g.user_id, body)
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
    ids = body.get('ids')
    fetch_mode = body.get('fetchMode') or body.get('fetch_mode') or ''
    if isinstance(ids, list):
        competitors = db_get_competitors(g.user_id)
        valid_ids = {comp['id'] for comp in competitors}
        active_ids = active_competitor_ids_for_user(g.user, competitors)
        target_ids = [
            str(cid) for cid in ids
            if str(cid) in valid_ids and str(cid) in active_ids
        ]
        queued_ids = db_get_ext_queue_ids(g.user_id)
        for target_id in target_ids:
            if target_id not in queued_ids:
                queued_ids.append(target_id)
        db_save_ext_queue_ids(g.user_id, queued_ids)
        db_save_ext_queue_fetch_mode(g.user_id, fetch_mode)
        return jsonify({'ok': True, 'count': len(target_ids)})
    try:
        queued = db_queue_competitors(g.user_id, body.get('id'), g.user, fetch_mode)
    except ValueError as e:
        status = 403 if '현재 플랜' in str(e) else 404
        return jsonify({'error': str(e)}), status
    return jsonify({'ok': True, 'count': len(queued)})

# ─── 크롬 확장프로그램용 Public API (인증 불필요) ────────────────

@app.route('/api/coupang/monthly', methods=['POST'])
@login_required
def api_coupang_monthly():
    body = request.get_json() or {}
    cid = body.get('id')
    url = (body.get('url') or '').strip()
    active_ids = active_competitor_ids_for_user(g.user)

    if cid:
        if cid not in active_ids:
            return jsonify({'error': '현재 플랜에서 조회할 수 없는 상품입니다'}), 403
        competitors = db_get_competitors(g.user_id)
        comp = next((c for c in competitors if c.get('id') == cid), None)
        if not comp:
            return jsonify({'error': '상품을 찾을 수 없습니다'}), 404
        url = comp.get('url') or url

    if not is_coupang_url(url):
        return jsonify({'error': '쿠팡 상품 URL이 아닙니다'}), 400

    result = _fetch_coupang(url)
    return jsonify({'ok': not bool(result.get('error')), **result})

@app.route('/api/public/competitors')
@login_required
def api_public_competitors():
    competitors = db_get_competitors(g.user_id)
    active = active_competitors_for_user(g.user, competitors)
    latest_stock = latest_stock_by_competitor(g.user_id)
    for comp in active:
        if is_coupang_url(comp.get('url') or '') and comp.get('id') in latest_stock:
            comp['expectedStock'] = latest_stock[comp['id']]
    return jsonify({'competitors': active})

@app.route('/api/public/queue', methods=['GET'])
@login_required
def api_public_queue_get():
    queue = db_get_ext_queue(g.user_id)
    active_ids = active_competitor_ids_for_user(g.user)
    visible_queue = [comp for comp in queue if comp.get('id') in active_ids]
    latest_stock = latest_stock_by_competitor(g.user_id)
    for comp in visible_queue:
        if is_coupang_url(comp.get('url') or '') and comp.get('id') in latest_stock:
            comp['expectedStock'] = latest_stock[comp['id']]
    fetch_mode = db_get_ext_queue_fetch_mode(g.user_id)
    if fetch_mode and not all(is_coupang_url(comp.get('url') or '') for comp in visible_queue):
        fetch_mode = ''
    return jsonify({
        'queue': visible_queue,
        'fetchMode': fetch_mode,
    })

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
    fetch_mode = normalize_ext_fetch_mode(body.get('fetchMode') or body.get('fetch_mode') or '')
    active_ids = active_competitor_ids_for_user(g.user)
    competitors_by_id = {comp.get('id'): comp for comp in db_get_competitors(g.user_id)}
    fetch_date, fetch_key = _stock_snapshot()
    for r in results:
        cid = r.get('id')
        if not cid or cid not in active_ids:
            continue
        image_url = (r.get('image_url') or '').strip()
        if image_url:
            sb_update('competitors', {'image_url': image_url}, 'id', cid, f'&user_id=eq.{g.user_id}')
        options = r.get('options') or []
        comp = competitors_by_id.get(cid) or {}
        if fetch_mode and competitor_market(comp.get('url') or '') == 'coupang':
            options = [opt for opt in options if opt.get('name') != '__fetch_mode']
            options.append({'name': '__fetch_mode', 'text': fetch_mode})
        db_save_stock(g.user_id, cid, fetch_date, {
            'total':      r.get('total'),
            'options':    options,
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
