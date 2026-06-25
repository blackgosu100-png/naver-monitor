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

async function main() {
  const tabs = await getJson('http://127.0.0.1:9333/json');
  const page = tabs.find((tab) => tab.type === 'page' && /coupang\.com/.test(tab.url));
  if (!page) throw new Error('Coupang page tab not found');

  let seq = 0;
  const pending = new Map();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const before = await send('Runtime.evaluate', {
    expression: `({
      ready: document.readyState,
      title: document.title,
      button: !!document.querySelector('.nm-coupang-button'),
      productLinks: document.querySelectorAll('a[href*="/products/"]').length
    })`,
    returnByValue: true
  });

  await send('Runtime.evaluate', {
    expression: `document.querySelector('.nm-coupang-button') && document.querySelector('.nm-coupang-button').click()`,
    returnByValue: true
  });
  await new Promise((resolve) => setTimeout(resolve, 26000));

  const after = await send('Runtime.evaluate', {
    expression: `Array.from(document.querySelectorAll('.nm-coupang-overlay')).slice(0, 12).map((el) => el.innerText)`,
    returnByValue: true
  });

  ws.close();
  console.log(JSON.stringify({
    before: before.result && before.result.result && before.result.result.value,
    overlays: after.result && after.result.result && after.result.result.value
  }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
