import json, re, hashlib, uuid, threading, webbrowser, time, random
import os, sqlite3, base64, ctypes, ctypes.wintypes, subprocess
from datetime import datetime, date
from pathlib import Path
from functools import wraps

import requests
from curl_cffi import requests as cf_requests
from flask import Flask, request, jsonify, session, render_template, redirect
from apscheduler.schedulers.background import BackgroundScheduler

app = Flask(__name__)
app.secret_key = 'naver-monitor-2024-secret-key'

BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / 'config.json'
DATA_FILE = BASE_DIR / 'data.json'

_queue_lock = threading.Lock()
_fetch_queue = []  # competitor IDs queued for individual extension fetch

# ─── Config ──────────────────────────────────────────────────

def _hash(pwd):
    return hashlib.sha256(pwd.encode()).hexdigest()

def load_config():
    if CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding='utf-8'))
    else:
        cfg = {}
    default = {
        'credentials': {'username': 'admin', 'password': _hash('1234')},
        'competitors': [],
        'schedule': {'enabled': False, 'hour': 9, 'minute': 0},
        'naver_cookie': ''
    }
    for k, v in default.items():
        cfg.setdefault(k, v)
    return cfg

def save_config(cfg):
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')

def load_data():
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding='utf-8'))
    return {}

def save_data(data):
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')

# ─── Naver Scraper ────────────────────────────────────────────

PAGE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control': 'max-age=0',
}

API_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
}

def _ok(options):
    total = sum(o['qty'] for o in options) if options else None
    return {'total': total, 'options': options, 'error': None, 'fetched_at': datetime.now().isoformat()}

def _err(msg):
    return {'total': None, 'options': [], 'error': msg, 'fetched_at': datetime.now().isoformat()}

def _parse_combos(combos):
    options = []
    for combo in combos:
        parts = [combo.get(f'optionName{i}', '') for i in range(1, 4)]
        name = ' / '.join(p for p in parts if p) or combo.get('name', '옵션')
        options.append({'name': name, 'qty': combo.get('stockQuantity', 0)})
    return options

def _deep_find(obj, key, depth=0):
    """Recursively find first occurrence of key in nested dict/list"""
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

def _parse_product_response(data):
    """Parse Naver Smart Store product API response → options list or None"""
    product = data.get('product', data)
    if not isinstance(product, dict):
        return None
    options = _parse_combos(product.get('optionCombinations', []))
    if not options:
        options = _parse_combos(product.get('supplementOptionCombinations', []))
    if not options and product.get('stockQuantity') is not None:
        options = [{'name': '전체', 'qty': product['stockQuantity']}]
    return _ok(options) if options else None

def _apply_cookie(session_obj):
    """config에 저장된 Naver 쿠키를 세션 헤더에 직접 적용"""
    cookie_str = load_config().get('naver_cookie', '').strip()
    if cookie_str:
        session_obj.headers['Cookie'] = cookie_str
    return bool(cookie_str)

def fetch_naver_stock(url):
    s = cf_requests.Session(impersonate='chrome120')
    _apply_cookie(s)
    errors = []

    try:
        # URL 파싱: https://smartstore.naver.com/{store_slug}/products/{product_id}
        url_m = re.search(r'(?:smartstore|brand)\.naver\.com/([^/?#]+)/products/(\d+)', url)
        if not url_m:
            return _err('URL 형식 오류: smartstore.naver.com 또는 brand.naver.com/{스토어}/products/{상품ID} 형태여야 합니다')
        store_slug = url_m.group(1)
        pid = url_m.group(2)

        channel_id = None

        # 요청 간 랜덤 딜레이 (Naver 차단 방지)
        time.sleep(random.uniform(1.0, 2.5))

        # Step 1: 스토어 슬러그로 채널 ID 조회
        try:
            ch_url = f'https://smartstore.naver.com/i/v2/channels/channel-url-key/{store_slug}'
            cr = s.get(ch_url, headers=API_HEADERS, timeout=15)
            if cr.status_code == 200:
                ch_data = cr.json()
                channel_id = _deep_find(ch_data, 'channelNo')
        except Exception as e:
            errors.append(f'채널API:{e}')

        # Step 2: 채널 ID로 상품 재고 API 호출
        if channel_id:
            time.sleep(random.uniform(0.5, 1.5))
            try:
                prod_url = f'https://smartstore.naver.com/i/v2/channels/{channel_id}/products/{pid}?withWindow=false'
                pr = s.get(prod_url, headers={**API_HEADERS, 'Referer': url}, timeout=15)
                if pr.status_code == 200:
                    result = _parse_product_response(pr.json())
                    if result:
                        return result
                else:
                    errors.append(f'상품API:{pr.status_code}')
            except Exception as e:
                errors.append(f'상품API:{e}')

        # Step 3: 페이지 HTML에서 직접 파싱 (fallback)
        try:
            hr = s.get(url, headers=PAGE_HEADERS, timeout=20)
            hr.raise_for_status()
            html = hr.text

            # HTML에서 채널 ID 재시도
            if not channel_id:
                ch_m = re.search(r'"channelNo"\s*:\s*"?(\d+)"?', html)
                if ch_m:
                    channel_id = ch_m.group(1)
                    try:
                        prod_url = f'https://smartstore.naver.com/i/v2/channels/{channel_id}/products/{pid}?withWindow=false'
                        pr2 = s.get(prod_url, headers={**API_HEADERS, 'Referer': url}, timeout=15)
                        if pr2.status_code == 200:
                            result = _parse_product_response(pr2.json())
                            if result:
                                return result
                    except Exception as e:
                        errors.append(f'채널재시도:{e}')

            # HTML에서 optionCombinations JSON 추출
            for pat in [
                r'"optionCombinations"\s*:\s*(\[[\s\S]*?\]),\s*"(?:supplement|sold|product)',
                r'"optionCombinations"\s*:\s*(\[[\s\S]{10,8000}?\])',
            ]:
                m = re.search(pat, html)
                if m:
                    try:
                        combos = json.loads(m.group(1))
                        if isinstance(combos, list) and combos:
                            options = _parse_combos(combos)
                            if options:
                                return _ok(options)
                    except Exception:
                        pass

            # __NEXT_DATA__ 내 JSON 파싱
            nd_m = re.search(r'<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>', html)
            if nd_m:
                try:
                    nd = json.loads(nd_m.group(1))
                    combos = _deep_find(nd, 'optionCombinations')
                    if combos:
                        options = _parse_combos(combos)
                        if options:
                            return _ok(options)
                    sq = _deep_find(nd, 'stockQuantity')
                    if sq is not None:
                        return _ok([{'name': '전체', 'qty': sq}])
                except Exception as e:
                    errors.append(f'NEXT_DATA:{e}')

            # 최후 수단: 페이지 내 모든 stockQuantity 숫자
            sq_all = [int(q) for q in re.findall(r'"stockQuantity"\s*:\s*(\d+)', html)]
            if sq_all:
                return _ok([{'name': '전체', 'qty': max(sq_all)}])

        except requests.exceptions.HTTPError as e:
            errors.append(f'페이지HTTP:{e.response.status_code}')
        except Exception as e:
            errors.append(f'페이지:{e}')

        err_msg = ' | '.join(errors) if errors else '알 수 없는 오류'
        return _err(f'재고 정보를 찾을 수 없습니다 ({err_msg})')

    except Exception as e:
        msg = str(e)
        if 'timed out' in msg.lower() or 'timeout' in msg.lower():
            return _err('요청 시간 초과')
        if 'connection' in msg.lower():
            return _err('연결 실패')
        return _err(msg)

def fetch_all():
    cfg = load_config()
    data = load_data()
    today = date.today().isoformat()
    if today not in data:
        data[today] = {}
    for c in cfg['competitors']:
        data[today][c['id']] = fetch_naver_stock(c['url'])
    save_data(data)
    return data.get(today, {})

# ─── Auth ─────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def dec(*args, **kwargs):
        if not session.get('logged_in'):
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect('/login')
        return f(*args, **kwargs)
    return dec

# ─── Routes ──────────────────────────────────────────────────

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
    cfg = load_config()
    if (body.get('username') == cfg['credentials']['username'] and
            _hash(body.get('password', '')) == cfg['credentials']['password']):
        session['logged_in'] = True
        session['username'] = body['username']
        return jsonify({'ok': True})
    return jsonify({'error': '아이디 또는 비밀번호가 올바르지 않습니다'}), 401

@app.route('/api/logout', methods=['POST'])
def api_logout():
    session.clear()
    return jsonify({'ok': True})

@app.route('/api/config')
@login_required
def api_config():
    cfg = load_config()
    return jsonify({
        'username': cfg['credentials']['username'],
        'competitors': cfg['competitors'],
        'schedule': cfg['schedule']
    })

@app.route('/api/competitors', methods=['POST'])
@login_required
def api_add():
    body = request.get_json() or {}
    name = body.get('name', '').strip()
    url = body.get('url', '').strip()
    if not name or not url:
        return jsonify({'error': '이름과 URL을 입력해주세요'}), 400
    if not re.search(r'(?:smartstore|brand)\.naver\.com', url):
        return jsonify({'error': '스마트스토어 또는 브랜드스토어 URL을 입력해주세요'}), 400
    cfg = load_config()
    comp = {'id': uuid.uuid4().hex[:8], 'name': name, 'url': url}
    cfg['competitors'].append(comp)
    save_config(cfg)
    return jsonify(comp)

@app.route('/api/competitors/<cid>', methods=['PUT'])
@login_required
def api_update(cid):
    body = request.get_json() or {}
    cfg = load_config()
    for c in cfg['competitors']:
        if c['id'] == cid:
            if body.get('name'):
                c['name'] = body['name']
            if body.get('url'):
                c['url'] = body['url']
            break
    save_config(cfg)
    return jsonify({'ok': True})

@app.route('/api/competitors/<cid>', methods=['DELETE'])
@login_required
def api_delete(cid):
    cfg = load_config()
    cfg['competitors'] = [c for c in cfg['competitors'] if c['id'] != cid]
    save_config(cfg)
    return jsonify({'ok': True})

@app.route('/api/fetch', methods=['POST'])
@login_required
def api_fetch():
    body = request.get_json() or {}
    cid = body.get('id')
    if cid:
        cfg = load_config()
        comp = next((c for c in cfg['competitors'] if c['id'] == cid), None)
        if not comp:
            return jsonify({'error': '경쟁사를 찾을 수 없습니다'}), 404
        data = load_data()
        today = date.today().isoformat()
        data.setdefault(today, {})[cid] = fetch_naver_stock(comp['url'])
        save_data(data)
        return jsonify({'ok': True})
    fetch_all()
    return jsonify({'ok': True})

@app.route('/api/debug/<cid>')
@login_required
def api_debug(cid):
    """디버그: 특정 경쟁사의 원시 조회 결과 반환"""
    cfg = load_config()
    comp = next((c for c in cfg['competitors'] if c['id'] == cid), None)
    if not comp:
        return jsonify({'error': '없음'}), 404
    result = fetch_naver_stock(comp['url'])
    return jsonify({'name': comp['name'], 'url': comp['url'], 'result': result})

@app.route('/api/history')
@login_required
def api_history():
    data = load_data()
    cfg = load_config()
    days = min(int(request.args.get('days', 14)), 60)
    sorted_dates = sorted(data.keys())[-days:]

    result = {'dates': sorted_dates, 'competitors': [], 'last_fetched': ''}

    if sorted_dates:
        last_day = data.get(sorted_dates[-1], {})
        times = [v.get('fetched_at', '') for v in last_day.values() if isinstance(v, dict)]
        if times:
            result['last_fetched'] = max(times)

    for comp in cfg['competitors']:
        cid = comp['id']
        entry = {'id': cid, 'name': comp['name'], 'url': comp['url'], 'days': {}}
        prev_total = None

        for d in sorted_dates:
            day = data.get(d, {}).get(cid)
            if day and isinstance(day, dict):
                total = day.get('total')
                sales = None
                if total is not None and prev_total is not None:
                    sales = prev_total - total
                entry['days'][d] = {
                    'total': total,
                    'sales': sales,
                    'options': day.get('options', []),
                    'error': day.get('error'),
                    'fetched_at': day.get('fetched_at', '')
                }
                if total is not None:
                    prev_total = total
            else:
                entry['days'][d] = None

        result['competitors'].append(entry)

    return jsonify(result)

@app.route('/api/schedule', methods=['PUT'])
@login_required
def api_schedule():
    body = request.get_json() or {}
    cfg = load_config()
    cfg['schedule'] = {
        'enabled': bool(body.get('enabled', False)),
        'hour': max(0, min(23, int(body.get('hour', 9)))),
        'minute': max(0, min(59, int(body.get('minute', 0))))
    }
    save_config(cfg)
    _update_scheduler()
    return jsonify({'ok': True})

@app.route('/api/credentials', methods=['PUT'])
@login_required
def api_credentials():
    body = request.get_json() or {}
    cfg = load_config()
    if _hash(body.get('current', '')) != cfg['credentials']['password']:
        return jsonify({'error': '현재 비밀번호가 올바르지 않습니다'}), 400
    if body.get('username'):
        cfg['credentials']['username'] = body['username']
    if body.get('new_password'):
        cfg['credentials']['password'] = _hash(body['new_password'])
    save_config(cfg)
    return jsonify({'ok': True})

@app.route('/cookie-import')
def cookie_import():
    """Chrome 확장 프로그램에서 새 탭으로 쿠키 전달"""
    import base64, urllib.parse
    data = request.args.get('data', '')
    if not data:
        return '<h3>❌ 데이터 없음</h3>', 400
    try:
        cookie = base64.b64decode(urllib.parse.unquote(data)).decode('utf-8')
    except Exception as e:
        return f'<h3>❌ 디코딩 오류: {e}</h3>', 400
    if not cookie.strip():
        return '<h3>❌ 쿠키가 비어 있습니다</h3>', 400
    cfg = load_config()
    cfg['naver_cookie'] = cookie.strip()
    save_config(cfg)
    count = len([p for p in cookie.split(';') if '=' in p.strip()])
    return f'''<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<style>body{{font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}}
.box{{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.1)}}
h2{{color:#166534;margin-bottom:8px}}p{{color:#64748b;font-size:14px}}</style>
</head><body><div class="box">
<h2>✅ 쿠키 {count}개 저장 완료!</h2>
<p>이 탭은 3초 후 자동으로 닫힙니다</p>
</div><script>setTimeout(function(){{window.close()}},3000)</script></body></html>'''

@app.route('/api/public/competitors')
def api_public_competitors():
    """확장 프로그램용 — 인증 없이 경쟁사 목록 반환"""
    cfg = load_config()
    resp = jsonify({'competitors': cfg['competitors']})
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

@app.route('/api/stock-data', methods=['POST', 'OPTIONS'])
def api_stock_data():
    """확장 프로그램에서 재고 데이터 수신"""
    if request.method == 'OPTIONS':
        r = app.make_response('')
        r.headers['Access-Control-Allow-Origin'] = '*'
        r.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        r.headers['Access-Control-Allow-Methods'] = 'POST'
        return r
    body = request.get_json() or {}
    data = load_data()
    today = date.today().isoformat()
    data.setdefault(today, {})
    for item in body.get('results', []):
        cid = item.get('id')
        if not cid:
            continue
        if item.get('error'):
            data[today][cid] = _err(item['error'])
        else:
            data[today][cid] = {
                'total':      item.get('total'),
                'options':    item.get('options', []),
                'error':      None,
                'fetched_at': item.get('fetched_at', datetime.now().isoformat())
            }
    save_data(data)
    resp = jsonify({'ok': True})
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

@app.route('/api/ext/queue', methods=['POST'])
@login_required
def api_ext_queue():
    """대시보드에서 개별 조회 요청 → 확장 프로그램 큐에 등록"""
    body = request.get_json() or {}
    cid = body.get('id')
    if not cid:
        return jsonify({'error': 'id 필요'}), 400
    cfg = load_config()
    comp = next((c for c in cfg['competitors'] if c['id'] == cid), None)
    if not comp:
        return jsonify({'error': '경쟁사 없음'}), 404
    with _queue_lock:
        if cid not in _fetch_queue:
            _fetch_queue.append(cid)
    return jsonify({'ok': True})

@app.route('/api/public/queue', methods=['GET', 'DELETE', 'OPTIONS'])
def api_public_queue():
    """확장 프로그램용 — 대기 큐 조회/삭제"""
    if request.method == 'OPTIONS':
        r = app.make_response('')
        r.headers['Access-Control-Allow-Origin'] = '*'
        r.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        r.headers['Access-Control-Allow-Methods'] = 'GET, DELETE'
        return r
    cfg = load_config()
    if request.method == 'GET':
        with _queue_lock:
            items = [c for c in cfg['competitors'] if c['id'] in _fetch_queue]
        resp = jsonify({'queue': items})
        resp.headers['Access-Control-Allow-Origin'] = '*'
        return resp
    # DELETE — clear processed items
    body = request.get_json() or {}
    ids = body.get('ids', [])
    with _queue_lock:
        for cid in ids:
            if cid in _fetch_queue:
                _fetch_queue.remove(cid)
    resp = jsonify({'ok': True})
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

@app.route('/api/cookie/from-extension', methods=['POST', 'OPTIONS'])
def api_cookie_from_ext():
    """Chrome 확장 프로그램에서 쿠키 수신 (CORS 허용)"""
    if request.method == 'OPTIONS':
        resp = app.make_response('')
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        resp.headers['Access-Control-Allow-Methods'] = 'POST'
        return resp
    body = request.get_json() or {}
    cookie = body.get('cookie', '').strip()
    if not cookie:
        resp = jsonify({'error': '쿠키가 비어 있습니다'})
        resp.headers['Access-Control-Allow-Origin'] = '*'
        return resp, 400
    cfg = load_config()
    cfg['naver_cookie'] = cookie
    save_config(cfg)
    count = len([p for p in cookie.split(';') if '=' in p])
    resp = jsonify({'ok': True, 'count': count})
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

@app.route('/api/cookie', methods=['PUT'])
@login_required
def api_cookie():
    body = request.get_json() or {}
    cfg = load_config()
    cfg['naver_cookie'] = body.get('cookie', '').strip()
    save_config(cfg)
    return jsonify({'ok': True})

@app.route('/api/cookie', methods=['GET'])
@login_required
def api_cookie_get():
    cfg = load_config()
    cookie = cfg.get('naver_cookie', '')
    ext_path = str(BASE_DIR / 'chrome_extension')
    return jsonify({
        'has_cookie': bool(cookie),
        'preview': cookie[:40] + '...' if len(cookie) > 40 else cookie,
        'ext_path': ext_path
    })

# ─── Chrome Cookie Extractor ──────────────────────────────────

class _DataBlob(ctypes.Structure):
    _fields_ = [('cbData', ctypes.wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]

def _dpapi_decrypt(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _DataBlob(len(data), buf)
    blob_out = _DataBlob()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    if not ok:
        raise RuntimeError(f'DPAPI 복호화 실패 (코드: {ctypes.GetLastError()})')
    result = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return result

def _is_chrome_running() -> bool:
    try:
        out = subprocess.check_output(['tasklist', '/FI', 'IMAGENAME eq chrome.exe', '/NH'],
                                      text=True, stderr=subprocess.DEVNULL)
        return 'chrome.exe' in out.lower()
    except Exception:
        return False

def _read_locked_file(path: str) -> bytes:
    """Chrome이 락을 걸고 있어도 읽을 수 있도록 Windows API 직접 사용"""
    GENERIC_READ       = 0x80000000
    FILE_SHARE_ALL     = 0x07          # READ | WRITE | DELETE
    OPEN_EXISTING      = 3
    FILE_ATTR_NORMAL   = 0x80
    INVALID_HANDLE     = ctypes.c_void_p(-1).value
    k32 = ctypes.windll.kernel32

    h = k32.CreateFileW(path, GENERIC_READ, FILE_SHARE_ALL,
                        None, OPEN_EXISTING, FILE_ATTR_NORMAL, None)
    if h == INVALID_HANDLE:
        raise OSError(f'파일 열기 실패 (WinError {k32.GetLastError()}): {path}')
    try:
        size = k32.GetFileSize(h, None)
        buf  = ctypes.create_string_buffer(size)
        read = ctypes.wintypes.DWORD(0)
        k32.ReadFile(h, buf, size, ctypes.byref(read), None)
        return buf.raw[:read.value]
    finally:
        k32.CloseHandle(h)

def _copy_chrome_db(src: str, dst: str):
    """쿠키 DB와 WAL/SHM 파일 모두 복사 (Chrome 실행 중에도 작동)"""
    data = _read_locked_file(src)
    with open(dst, 'wb') as f:
        f.write(data)
    for ext in ('-wal', '-shm'):
        s = src + ext
        d = dst + ext
        if os.path.exists(s):
            try:
                with open(d, 'wb') as f:
                    f.write(_read_locked_file(s))
            except Exception:
                pass

def _extract_chrome_naver_cookies() -> list[str]:
    local = os.environ.get('LOCALAPPDATA', '')

    state_path = os.path.join(local, 'Google', 'Chrome', 'User Data', 'Local State')
    if not os.path.exists(state_path):
        raise FileNotFoundError('Chrome Local State 파일을 찾을 수 없습니다')

    with open(state_path, 'r', encoding='utf-8') as f:
        state = json.load(f)
    enc_key_b64 = state.get('os_crypt', {}).get('encrypted_key', '')
    if not enc_key_b64:
        raise ValueError('Chrome 암호화 키를 찾을 수 없습니다')
    aes_key = _dpapi_decrypt(base64.b64decode(enc_key_b64)[5:])  # skip 'DPAPI' prefix

    for rel in ('Default/Network/Cookies', 'Default/Cookies'):
        cookie_file = os.path.join(local, 'Google', 'Chrome', 'User Data', rel)
        if os.path.exists(cookie_file):
            break
    else:
        raise FileNotFoundError('Chrome 쿠키 파일을 찾을 수 없습니다')

    tmp = cookie_file + '_naver_tmp'
    _copy_chrome_db(cookie_file, tmp)
    try:
        conn = sqlite3.connect(tmp)
        rows = conn.execute(
            "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%.naver.com'"
        ).fetchall()
        conn.close()
    finally:
        for f in (tmp, tmp + '-wal', tmp + '-shm'):
            try: os.remove(f)
            except Exception: pass

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    parts = []
    for name, enc_val in rows:
        if not name or not enc_val:
            continue
        try:
            ev = bytes(enc_val)
            if ev[:3] in (b'v10', b'v11'):
                value = AESGCM(aes_key).decrypt(ev[3:15], ev[15:], None).decode('utf-8')
            else:
                value = _dpapi_decrypt(ev).decode('utf-8')
            if value:
                parts.append(f'{name}={value}')
        except Exception:
            pass
    return parts

@app.route('/api/cookie/auto', methods=['POST'])
@login_required
def api_cookie_auto():
    try:
        parts = _extract_chrome_naver_cookies()
    except FileNotFoundError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': f'쿠키 추출 오류: {e}'}), 500

    if not parts:
        return jsonify({'error': 'Chrome에서 네이버 쿠키를 찾을 수 없습니다. 네이버에 로그인된 상태인지 확인해주세요.'}), 404

    cookie_str = '; '.join(parts)
    cfg = load_config()
    cfg['naver_cookie'] = cookie_str
    save_config(cfg)
    preview = cookie_str[:40] + '...' if len(cookie_str) > 40 else cookie_str
    return jsonify({'ok': True, 'count': len(parts), 'preview': preview})

# ─── Scheduler ────────────────────────────────────────────────

scheduler = BackgroundScheduler(timezone='Asia/Seoul')

def _update_scheduler():
    cfg = load_config()
    s = cfg.get('schedule', {})
    try:
        scheduler.remove_job('daily_fetch')
    except Exception:
        pass
    if s.get('enabled'):
        scheduler.add_job(fetch_all, 'cron',
                          hour=s.get('hour', 9), minute=s.get('minute', 0),
                          id='daily_fetch')

if __name__ == '__main__':
    if not CONFIG_FILE.exists():
        save_config(load_config())
    scheduler.start()
    _update_scheduler()
    threading.Timer(1.5, lambda: webbrowser.open('http://localhost:5000')).start()
    print('=' * 50)
    print('  네이버 경쟁사 모니터링 서버 시작')
    print('  http://localhost:5000')
    print('  초기 계정: admin / 1234')
    print('=' * 50)
    app.run(host='0.0.0.0', port=5000, debug=False)
