"""로컬앱 진입점 — 수강생 PC에서 실행되는 Flask 서버.

흐름:
  1. SQLite 초기화
  2. Flask 서버 시작 (localhost:5000)
  3. 기본 브라우저로 자동 오픈
  4. 시작 화면 → 라이선스 검증 (네이버 로그인 → ID 추출 → 서버 검증)
  5. 통과하면 모니터링 대시보드
"""
import os
import re
import sys
import time
import socket
import threading
import webbrowser
from datetime import date
from functools import wraps

from flask import Flask, request, jsonify, render_template, redirect
from apscheduler.schedulers.background import BackgroundScheduler

# 같은 디렉터리 내 모듈
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db
import scraper
import license as license_mod   # 표준 라이브러리 license와 충돌 피함

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'naver-monitor-local-secret')

# ─── 라이선스 상태 (메모리) ────────────────────────────────────────
_license_state = {
    'acquired':     False,
    'naver_id':     None,
    'display_name': None,
    'notice':       None,
    'in_progress':  False,
}
_stop_event = threading.Event()


def _restore_license_from_cache() -> None:
    """앱 시작 시 캐시된 라이선스 즉시 복원 (서버 검증은 별도)."""
    cached = db.get_current_license()
    if cached and cached.get('valid'):
        _license_state['acquired']     = True
        _license_state['naver_id']     = cached['naver_id']
        _license_state['display_name'] = cached.get('display_name') or cached['naver_id']


def license_required(f):
    @wraps(f)
    def dec(*args, **kwargs):
        if not _license_state['acquired']:
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({'error': 'License required'}), 401
            return redirect('/start')
        return f(*args, **kwargs)
    return dec


# ─── 시작 화면 (라이선스) ──────────────────────────────────────────

@app.route('/start')
def start_page():
    if _license_state['acquired']:
        return redirect('/')
    return render_template('license_start.html')


@app.route('/api/license/state')
def api_license_state():
    return jsonify({
        'acquired':     _license_state['acquired'],
        'naver_id':     _license_state['naver_id'],
        'display_name': _license_state['display_name'],
        'in_progress':  _license_state['in_progress'],
        'notice':       _license_state['notice'],
    })


@app.route('/api/license/start', methods=['POST'])
def api_license_start():
    """네이버 로그인 → ID 추출 → 서버 검증. 동기 호출 (Playwright 실행)."""
    if _license_state['in_progress']:
        return jsonify({'error': '이미 진행 중입니다'}), 409
    _license_state['in_progress'] = True
    try:
        result = license_mod.acquire_license()
        if result.get('ok'):
            _license_state['acquired']     = True
            _license_state['naver_id']     = result['naver_id']
            _license_state['display_name'] = result.get('display_name') or result['naver_id']
            _license_state['notice']       = result.get('notice')
        return jsonify(result)
    finally:
        _license_state['in_progress'] = False


@app.route('/api/license/logout', methods=['POST'])
def api_license_logout():
    db.clear_license_cache()
    _license_state['acquired']     = False
    _license_state['naver_id']     = None
    _license_state['display_name'] = None
    return jsonify({'ok': True})


# ─── 모니터링 페이지 ──────────────────────────────────────────────

@app.route('/')
@license_required
def index():
    return render_template('index.html')


@app.route('/api/config')
@license_required
def api_config():
    return jsonify({
        'username':    _license_state['display_name'] or _license_state['naver_id'],
        'competitors': db.get_competitors(),
        'schedule':    db.get_schedule(),
        'notice':      _license_state.get('notice'),
    })


@app.route('/api/competitors', methods=['POST'])
@license_required
def api_add_competitor():
    body = request.get_json() or {}
    name = (body.get('name') or '').strip()
    url  = (body.get('url')  or '').strip()
    if not name or not url:
        return jsonify({'error': '이름과 URL을 입력해주세요'}), 400
    if not re.search(r'(?:smartstore|brand)\.naver\.com/.+/products/\d+', url):
        return jsonify({'error': 'smartstore.naver.com 또는 brand.naver.com URL이어야 합니다'}), 400
    cid = f'c{int(time.time() * 1000)}'
    db.add_competitor(cid, name, url)
    return jsonify({'ok': True, 'id': cid})


@app.route('/api/competitors/<cid>', methods=['PUT'])
@license_required
def api_update_competitor(cid):
    body   = request.get_json() or {}
    update = {k: body[k].strip() for k in ('name', 'url') if body.get(k)}
    if update:
        db.update_competitor(cid, update)
    return jsonify({'ok': True})


@app.route('/api/competitors/<cid>', methods=['DELETE'])
@license_required
def api_delete_competitor(cid):
    db.delete_competitor(cid)
    return jsonify({'ok': True})


@app.route('/api/history')
@license_required
def api_history():
    days = min(int(request.args.get('days', 14)), 60)
    competitors, rows = db.get_history(days)
    dates = sorted({row['fetch_date'] for row in rows})

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
@license_required
def api_fetch():
    body = request.get_json() or {}
    cid  = body.get('id')
    today = date.today().isoformat()
    if cid:
        competitors = db.get_competitors()
        comp = next((c for c in competitors if c['id'] == cid), None)
        if not comp:
            return jsonify({'error': '경쟁사를 찾을 수 없습니다'}), 404
        result = scraper.fetch_single(comp['url'])
        db.save_stock(cid, today, result)
    else:
        scraper.fetch_all(db.get_competitors(),
                          lambda cid_, r: db.save_stock(cid_, today, r))
    return jsonify({'ok': True})


@app.route('/api/schedule', methods=['PUT'])
@license_required
def api_schedule():
    body    = request.get_json() or {}
    enabled = bool(body.get('enabled', False))
    hour    = max(0, min(23, int(body.get('hour', 9))))
    minute  = max(0, min(59, int(body.get('minute', 0))))
    db.save_schedule(enabled, hour, minute)
    _update_scheduler()
    return jsonify({'ok': True})


# ─── 스케줄러 ─────────────────────────────────────────────────────
scheduler = BackgroundScheduler(timezone='Asia/Seoul')


def _scheduled_fetch():
    today = date.today().isoformat()
    scraper.fetch_all(db.get_competitors(),
                      lambda cid_, r: db.save_stock(cid_, today, r))


def _update_scheduler():
    s = db.get_schedule()
    try:
        scheduler.remove_job('daily_fetch')
    except Exception:
        pass
    if s['enabled']:
        scheduler.add_job(_scheduled_fetch, 'cron',
                          hour=s['hour'], minute=s['minute'],
                          id='daily_fetch')


# ─── 시작 / 진입점 ────────────────────────────────────────────────

def _find_free_port(start: int = 5000, end: int = 5050) -> int:
    """포트가 비어있는지 확인. 충돌 시 다음 포트 시도."""
    for p in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', p)) != 0:
                return p
    return start


def _open_browser_delayed(url: str, delay: float = 1.2):
    def _open():
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:
            pass
    threading.Thread(target=_open, daemon=True).start()


def main():
    print('▶ 네이버 모니터링 로컬앱 시작')
    db.init_db()
    _restore_license_from_cache()

    port = _find_free_port()
    url = f'http://localhost:{port}/'
    print(f'▶ 서버: {url}')

    scheduler.start()
    try:
        _update_scheduler()
    except Exception as e:
        print(f'스케줄러 초기화 실패 (무시): {e}')

    # 백그라운드 라이선스 heartbeat
    threading.Thread(
        target=license_mod.background_heartbeat_loop,
        args=(_stop_event,),
        daemon=True,
    ).start()

    _open_browser_delayed(url)
    app.run(host='127.0.0.1', port=port, debug=False, use_reloader=False)


if __name__ == '__main__':
    main()
