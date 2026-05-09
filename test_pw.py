from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('https://www.naver.com')
    print('title:', page.title())
    browser.close()
    print('done')
