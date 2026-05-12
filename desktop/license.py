"""라이선스 검증 모듈.

관리자 페이지(Railway)의 /api/verify, /api/heartbeat 를 호출한다.
"""
import os
from datetime import datetime, timedelta

import httpx

import db
import scraper

# Railway에 배포된 관리자 서버 주소.
# 환경변수로 덮어쓸 수 있게 함 (개발/테스트용).
LICENSE_SERVER = os.environ.get(
    'NAVER_MONITOR_LICENSE_SERVER',
    'https://naver-monitor-production.up.railway.app',
).rstrip('/')

APP_VERSION = '1.0.0'

# 오프라인 허용 기간: 마지막 검증 후 N일까지는 인터넷 없어도 사용 가능
OFFLINE_GRACE_DAYS = 7

# 백그라운드 heartbeat 주기 (초). 24시간 = 86400초
HEARTBEAT_INTERVAL_SEC = 24 * 3600


def verify_with_server(naver_id: str) -> dict:
    """서버에 라이선스 검증 요청. 결과 dict 반환.

    {valid: bool, display_name, expires_at, notice, reason}
    네트워크 실패 시 {valid: False, network_error: True}.
    """
    try:
        r = httpx.post(
            f'{LICENSE_SERVER}/api/verify',
            json={'naver_id': naver_id, 'version': APP_VERSION},
            timeout=10,
        )
        if r.status_code != 200:
            return {'valid': False, 'reason': f'서버 오류 ({r.status_code})'}
        return r.json()
    except (httpx.RequestError, httpx.TimeoutException) as e:
        return {'valid': False, 'network_error': True, 'reason': str(e)[:100]}


def send_heartbeat(naver_id: str) -> dict:
    try:
        r = httpx.post(
            f'{LICENSE_SERVER}/api/heartbeat',
            json={'naver_id': naver_id, 'version': APP_VERSION},
            timeout=10,
        )
        if r.status_code != 200:
            return {'valid': False, 'reason': f'서버 오류 ({r.status_code})'}
        return r.json()
    except (httpx.RequestError, httpx.TimeoutException):
        return {'valid': True, 'network_error': True}  # 네트워크 실패는 일단 통과


def acquire_license() -> dict:
    """앱 시작 시 호출.

    1. 캐시된 라이선스가 있으면 검증 시도
    2. 없으면 네이버 로그인 창 띄우고 ID 추출
    3. 서버에 검증 요청
    4. 통과하면 캐시에 저장하고 결과 반환

    반환: {ok: bool, naver_id, display_name, reason, notice}
    """
    cached = db.get_current_license()

    # 캐시가 있으면 그것으로 먼저 시도
    if cached and cached.get('valid'):
        result = verify_with_server(cached['naver_id'])
        if result.get('valid'):
            db.save_license_cache(
                cached['naver_id'],
                result.get('display_name') or cached.get('display_name') or '',
                result.get('expires_at'),
                True,
            )
            return {
                'ok':           True,
                'naver_id':     cached['naver_id'],
                'display_name': result.get('display_name'),
                'notice':       result.get('notice'),
            }
        if result.get('network_error'):
            # 오프라인 grace 기간 내면 통과
            last = cached.get('last_verified_at') or ''
            try:
                last_dt = datetime.fromisoformat(last)
                if datetime.now() - last_dt < timedelta(days=OFFLINE_GRACE_DAYS):
                    return {
                        'ok':           True,
                        'naver_id':     cached['naver_id'],
                        'display_name': cached.get('display_name'),
                        'offline':      True,
                    }
            except Exception:
                pass
            return {'ok': False, 'reason': '인터넷 연결을 확인해주세요'}
        # 서버가 거부한 경우 (차단/만료)
        db.save_license_cache(
            cached['naver_id'],
            cached.get('display_name') or '',
            cached.get('expires_at'),
            False,
        )
        return {'ok': False, 'reason': result.get('reason', '권한이 없습니다')}

    # 캐시 없음 → 네이버 로그인 → ID 추출 → 서버 검증
    naver_id = scraper.open_naver_login_and_get_id()
    if not naver_id:
        return {'ok': False, 'reason': '네이버 로그인을 완료하지 못했습니다'}

    result = verify_with_server(naver_id)
    if result.get('valid'):
        db.save_license_cache(
            naver_id,
            result.get('display_name') or naver_id,
            result.get('expires_at'),
            True,
        )
        return {
            'ok':           True,
            'naver_id':     naver_id,
            'display_name': result.get('display_name'),
            'notice':       result.get('notice'),
        }
    return {'ok': False, 'reason': result.get('reason') or '승인되지 않은 ID입니다'}


def background_heartbeat_loop(stop_event=None):
    """별도 스레드에서 24시간마다 heartbeat. 차단/만료되면 stop_event를 set."""
    import time
    while True:
        if stop_event is not None and stop_event.is_set():
            return
        time.sleep(HEARTBEAT_INTERVAL_SEC)
        cached = db.get_current_license()
        if not cached:
            continue
        result = send_heartbeat(cached['naver_id'])
        if not result.get('valid') and not result.get('network_error'):
            db.save_license_cache(
                cached['naver_id'],
                cached.get('display_name') or '',
                cached.get('expires_at'),
                False,
            )
            if stop_event is not None:
                stop_event.set()
            return
