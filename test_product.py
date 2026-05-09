from playwright.sync_api import sync_playwright

url = 'https://brand.naver.com/k-garden/products/9627234636'

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=False)
    page = browser.new_page()
    page.goto(url, wait_until='domcontentloaded')
    page.wait_for_timeout(3000)
    print('title:', page.title())
    browser.close()
