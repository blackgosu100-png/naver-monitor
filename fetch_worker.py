"""Flask에서 subprocess로 호출되는 Playwright 스크래퍼"""
import sys, json
from playwright.sync_api import sync_playwright
from datetime import datetime

def _parse_combos(combos):
    result = []
    for c in combos:
        parts = [c.get(f'optionName{i}', '') for i in range(1, 4)]
        name = ' / '.join(p for p in parts if p) or c.get('name', '옵션')
        result.append({'name': name, 'qty': c.get('stockQuantity', 0)})
    return result

def _deep_find(obj, key, depth=0):
    if depth > 12: return None
    if isinstance(obj, dict):
        if key in obj: return obj[key]
        for v in obj.values():
            r = _deep_find(v, key, depth+1)
            if r is not None: return r
    elif isinstance(obj, list):
        for item in obj:
            r = _deep_find(item, key, depth+1)
            if r is not None: return r
    return None

def fetch(url):
    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel='chrome',
            headless=True,
            args=['--disable-blink-features=AutomationControlled'],
        )
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            locale='ko-KR',
            timezone_id='Asia/Seoul',
            viewport={'width': 1280, 'height': 800},
        )
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        captured = {}

        def on_response(resp):
            u = resp.url
            ct = resp.headers.get('content-type', '')
            if 'json' in ct and ('channels' in u or 'products' in u) and 'naver.com' in u:
                try:
                    captured['product'] = resp.json()
                except Exception:
                    pass

        page.on('response', on_response)

        try:
            page.goto(url, wait_until='domcontentloaded', timeout=30_000,
                      referer='https://search.naver.com/')
            page.wait_for_timeout(4000)

            if 'product' in captured:
                data = captured['product']
                combos = _deep_find(data, 'optionCombinations')
                if combos:
                    opts = _parse_combos(combos)
                    if opts:
                        return {'total': sum(o['qty'] for o in opts), 'options': opts, 'error': None}
                sq = _deep_find(data, 'stockQuantity')
                if sq is not None:
                    return {'total': sq, 'options': [{'name': '전체', 'qty': sq}], 'error': None}

            nd = page.evaluate('() => { const el = document.getElementById("__NEXT_DATA__"); return el ? el.textContent : ""; }')
            if nd:
                import json as _json
                data = _json.loads(nd)
                combos = _deep_find(data, 'optionCombinations')
                if combos:
                    opts = _parse_combos(combos)
                    if opts:
                        return {'total': sum(o['qty'] for o in opts), 'options': opts, 'error': None}
                sq = _deep_find(data, 'stockQuantity')
                if sq is not None:
                    return {'total': sq, 'options': [{'name': '전체', 'qty': sq}], 'error': None}

            title = page.title()
            return {'total': None, 'options': [], 'error': f'재고 정보 없음 (페이지: {title})'}

        except Exception as e:
            return {'total': None, 'options': [], 'error': str(e)[:300]}
        finally:
            browser.close()

if __name__ == '__main__':
    url = sys.argv[1]
    result = fetch(url)
    result['fetched_at'] = datetime.now().isoformat()
    print(json.dumps(result, ensure_ascii=False))
