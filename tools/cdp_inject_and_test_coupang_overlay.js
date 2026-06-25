const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  let seq = 0;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

async function main() {
  const tabs = await getJson('http://127.0.0.1:9333/json');
  const page = tabs.find((tab) => tab.type === 'page' && /coupang\.com/.test(tab.url));
  const worker = tabs.find((tab) => tab.type === 'service_worker' && /chrome-extension:/.test(tab.url));
  const extensionPage = tabs.find((tab) => tab.type === 'page' && /chrome-extension:/.test(tab.url));
  const extensionContext = worker || extensionPage;
  if (!page) throw new Error('Coupang page tab not found');
  if (!extensionContext) throw new Error('Extension context not found');

  const pageConn = connect(page.webSocketDebuggerUrl);
  await pageConn.ready;
  await pageConn.send('Runtime.enable');

  const tabInfo = await pageConn.send('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true
  });
  const pageUrl = tabInfo.result.result.value;

  const workerConn = connect(extensionContext.webSocketDebuggerUrl);
  await workerConn.ready;
  await workerConn.send('Runtime.enable');
  const injectResult = await workerConn.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      chrome.tabs.query({ url: '*://*.coupang.com/*' }, (tabs) => {
        const tab = tabs.find((item) => item.url === ${JSON.stringify(pageUrl)}) || tabs[0];
        if (!tab) return resolve({ ok: false, error: 'no coupang tab' });
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['coupang_overlay.js'] }, () => {
          resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError && chrome.runtime.lastError.message, tabId: tab.id });
        });
      });
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  if (injectResult.exceptionDetails) {
    throw new Error('inject exception: ' + JSON.stringify(injectResult.exceptionDetails));
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const before = await pageConn.send('Runtime.evaluate', {
    expression: `({
      ready: document.readyState,
      title: document.title,
      button: !!document.querySelector('.nm-coupang-button'),
      productLinks: document.querySelectorAll('a[href*="/products/"]').length
    })`,
    returnByValue: true
  });

  await pageConn.send('Runtime.evaluate', {
    expression: `document.querySelector('.nm-coupang-button') && document.querySelector('.nm-coupang-button').click()`,
    returnByValue: true
  });
  await new Promise((resolve) => setTimeout(resolve, 36000));

  const after = await pageConn.send('Runtime.evaluate', {
    expression: `Array.from(document.querySelectorAll('.nm-coupang-overlay')).slice(0, 12).map((el) => el.innerText)`,
    returnByValue: true
  });

  pageConn.ws.close();
  workerConn.ws.close();

  console.log(JSON.stringify({
    injectRaw: injectResult,
    inject: injectResult.result && injectResult.result.result && injectResult.result.result.value,
    before: before.result && before.result.result && before.result.result.value,
    overlays: after.result && after.result.result && after.result.result.value
  }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
