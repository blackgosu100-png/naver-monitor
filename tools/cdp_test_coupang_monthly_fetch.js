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
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

async function main() {
  const tabs = await getJson('http://127.0.0.1:9333/json');
  const page = tabs.find((tab) => tab.type === 'page' && /coupang\.com/.test(tab.url));
  if (!page) throw new Error('Coupang page tab not found');
  const conn = connect(page.webSocketDebuggerUrl);
  await conn.ready;
  await conn.send('Runtime.enable');
  const result = await conn.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      function parseMonthly(text) {
        if (!text) return null;
        const normalized = String(text)
          .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\\\\\"/g, '"')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\\s+/g, ' ');
        const patterns = [
          { re: /한\\s*달(?:간)?\\s*([0-9,]+)\\s*명\\s*이상\\s*구매/, lowerBound: true },
          { re: /한\\s*달(?:간)?\\s*([0-9,]+)\\s*명\\s*구매/, lowerBound: true },
          { re: /월\\s*([0-9,]+)\\s*명\\s*이상\\s*구매/, lowerBound: true },
          { re: /socialProofNumUsers\\s*["']?\\s*:\\s*(\\d+)/, lowerBound: true }
        ];
        for (const pattern of patterns) {
          const m = normalized.match(pattern.re);
          if (m && m[1]) return { total: Number(String(m[1]).replace(/,/g, '')), lowerBound: pattern.lowerBound };
        }
        return null;
      }
      const argLinks = ${JSON.stringify(process.argv.slice(2))};
      const links = (argLinks.length
        ? argLinks
        : Array.from(document.querySelectorAll('a[href*="/products/"]')).map((a) => a.href)
      ).filter(Boolean).slice(0, 8);
      const rows = [];
      for (const href of links) {
        try {
          const res = await fetch(href, { credentials: 'include', cache: 'no-store' });
          const text = await res.text();
          rows.push({ href, status: res.status, monthly: parseMonthly(text), length: text.length });
        } catch (e) {
          rows.push({ href, error: e && e.message ? e.message : String(e) });
        }
      }
      return rows;
    })()`
  });
  conn.ws.close();
  console.log(JSON.stringify(result.result.result.value, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
