"""네이버 스마트스토어 재고 스크래퍼 (Playwright 기반).

수강생 PC의 네이버 로그인 세션을 그대로 활용한다.
"""
import json
import re
import time
import random
import threading
from datetime import datetime
from pathlib import Path

from db import app_data_dir

_pw_lock = threading.Lock()


def chrome_profile_dir() -> Path:
    """수강생의 네이버 로그인 세션을 저장할 Chrome 프로파일 경로."""
    d = app_data_dir() / 'chrome_profile'
    d.mkdir(parents=True, exist_ok=True)
    return d


# ─── 결과 헬퍼 ────────────────────────────────────────────────────

def _ok(options: list) -> dict:
    return {
        'total':      sum(o['qty'] for o in options),
        'options':    options,
        'error':      None,
        'fetched_at': datetime.now().isoformat(),
    }


def _err(msg: str) -> dict:
    return {
        'total':      None,
        'options':    [],
        'error':      msg,
        'fetched_at': datetime.now().isoformat(),
    }


def _parse_combos(combos: list) -> list:
    result = []
    for c in combos:
        parts = [c.get(f'optionName{i}', '') for i in range(1, 4)]
        name = ' / '.join(p for p in parts if p) or c.get('name', '옵션')
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


# ─── Playwright 컨텍스트 ──────────────────────────────────────────

def _launch_context(pw, headless: bool = True):
    """수강생의 네이버 로그인 세션을 유지하는 persistent context.

    한 번 로그인하면 chrome_profile_dir() 에 세션 저장 → 다음 실행 시 자동 로그인.
    """
    return pw.chromium.launch_persistent_context(
        user_data_dir=str(chrome_profile_dir()),
        headless=headless,
        locale='ko-KR',
        timezone_id='Asia/Seoul',
        viewport={'width': 1280, 'height': 800},
        user_agent=(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/136.0.0.0 Safari/537.36'
        ),
        args=[
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
        ],
    )


def _fetch_one(context, url: str) -> dict:
    page = context.new_page()
    page.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    )

    captured: dict = {}

    def on_response(resp):
        u = resp.url
        ct = resp.headers.get('content-type', '')
        if 'json' not in ct or 'naver.com' not in u:
            return
        is_product_api = (
            ('/i/v2/channels/' in u and '/products/' in u) or
            ('/products/' in u and 'naver.com' in u)
        )
        if is_product_api:
            try:
                captured['product'] = resp.json()
            except Exception:
                pass

    page.on('response', on_response)

    try:
        page.goto(url, wait_until='networkidle', timeout=30_000,
                  referer='https://search.naver.com/')
        page.wait_for_timeout(2_000)

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

        return _err('재고 정보를 찾을 수 없습니다 (네이버 로그인 만료 가능성)')

    except Exception as e:
        msg = str(e)[:300]
        return _err('페이지 로딩 시간 초과' if 'timeout' in msg.lower() else msg)
    finally:
        page.close()


# ─── 외부 호출 API ────────────────────────────────────────────────

def fetch_single(url: str, headless: bool = True) -> dict:
    """경쟁사 URL 1개 조회."""
    from playwright.sync_api import sync_playwright
    with _pw_lock:
        with sync_playwright() as pw:
            ctx = _launch_context(pw, headless=headless)
            try:
                return _fetch_one(ctx, url)
            finally:
                ctx.close()


def fetch_all(competitors: list, save_cb) -> None:
    """경쟁사 전체 조회. save_cb(competitor_id, result) 를 각 결과마다 호출."""
    from playwright.sync_api import sync_playwright
    if not competitors:
        return
    with _pw_lock:
        with sync_playwright() as pw:
            ctx = _launch_context(pw, headless=True)
            try:
                for comp in competitors:
                    result = _fetch_one(ctx, comp['url'])
                    save_cb(comp['id'], result)
                    time.sleep(random.uniform(1.5, 3.0))
            finally:
                ctx.close()


# ─── 네이버 로그인 + ID 추출 ──────────────────────────────────────

def open_naver_login_and_get_id(timeout_sec: int = 300) -> str | None:
    """네이버 로그인 창을 띄우고, 로그인 완료되면 사용자 ID를 반환.

    수강생이 본인 ID/비밀번호로 직접 로그인. 우리 코드는 비밀번호를 보지 않는다.
    로그인 폼이 리셋되지 않도록 페이지를 건드리지 않고 URL 변화만 감시한다.
    """
    from playwright.sync_api import sync_playwright

    with _pw_lock:
        with sync_playwright() as pw:
            ctx = _launch_context(pw, headless=False)
            page = ctx.new_page()
            try:
                # 1) 이미 로그인된 세션이 있는지 빠르게 확인
                naver_id = _try_get_logged_in_id(page)
                if naver_id:
                    return naver_id

                # 2) 로그인 페이지로 이동 (한 번만)
                page.goto('https://nid.naver.com/nidlogin.login',
                          wait_until='domcontentloaded', timeout=30_000)

                # 3) 사용자가 로그인 완료할 때까지 URL 변화만 감시 (페이지 건드리지 않음!)
                deadline = time.time() + timeout_sec
                while time.time() < deadline:
                    try:
                        current_url = page.url
                    except Exception:
                        return None
                    # 로그인 페이지에서 벗어나면 로그인 완료
                    if current_url and 'nidlogin' not in current_url and 'nid.naver.com/nidlogin' not in current_url:
                        # 리다이렉트 안정화 대기
                        page.wait_for_timeout(1500)
                        return _try_get_logged_in_id(page)
                    time.sleep(1.0)
                return None
            finally:
                ctx.close()


_NAVER_EMAIL_RE = re.compile(r'\b([a-zA-Z0-9][a-zA-Z0-9._-]{2,29})@naver\.com\b')


def _try_get_logged_in_id(page) -> str | None:
    """네이버 메인 페이지에서 로그인된 사용자의 ID 추출.

    로그인되어 있으면 페이지 어딘가에 'xxx@naver.com' 형태로 본인 이메일이 노출된다.
    이 이메일 패턴을 매칭해서 ID를 가져온다. selector 변경에 강함.
    """
    try:
        page.goto('https://www.naver.com', wait_until='domcontentloaded',
                  timeout=15_000)
        page.wait_for_timeout(1500)  # SPA 렌더 대기
        # 페이지 전체 HTML에서 @naver.com 이메일 첫 매치
        html = page.content()
        m = _NAVER_EMAIL_RE.search(html)
        if m:
            return m.group(1).lower()
        # 안 보이면 visible 텍스트만 한 번 더 시도
        try:
            body = page.inner_text('body')
            m = _NAVER_EMAIL_RE.search(body)
            if m:
                return m.group(1).lower()
        except Exception:
            pass
        return None
    except Exception:
        return None
