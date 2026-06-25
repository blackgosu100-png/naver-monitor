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
    expression: `(() => {
      function priceNumber(text) {
        var m = String(text || '').replace(/,/g, '').match(/(\\d{3,})/);
        return m ? Number(m[1]) : null;
      }
      function parseCurrentPriceFromText(text) {
        function addLineCandidate(list, value, score, order, originalIndex) {
          if (value === null) return;
          list.push({ value: value, score: score, order: order, originalIndex: originalIndex || 0 });
        }
        var lines = String(text || '').split(/\\n+/).map(function(line) { return line.trim(); }).filter(Boolean);
        function priceValuesFromLine(line) {
          return (String(line || '').match(/[\\d,]{3,}\\s*원/g) || [])
            .map(function(match) { return priceNumber(match); })
            .filter(function(value) { return value !== null; });
        }
        var lineCandidates = [];
        lines.forEach(function(line, index) {
          if (/최대|적립|도착|배송|무료배송|로켓|리뷰|상품평|모레|내일|오늘/i.test(line)) return;
          var matches = line.match(/[\\d,]{3,}\\s*원/g) || [];
          if (!matches.length) return;
          var score = 10;
          var hasPercent = /%/.test(line);
          if (hasPercent && matches.length > 1) score += 45;
          if (/판매가|쿠폰|와우|즉시|할인가|최종|타임할인/i.test(line)) score += 35;
          if (/정가|할인\\s*$/i.test(line)) score -= 45;
          if (/개당/i.test(line)) score -= 25;
          var values = matches.map(function(match) { return priceNumber(match); }).filter(function(value) { return value !== null; });
          if (!values.length) return;
          if (hasPercent && values.length > 1) {
            addLineCandidate(lineCandidates, Math.min.apply(Math, values), score + 15, index, 0);
            return;
          }
          if (hasPercent && values.length === 1) {
            var currentValue = values[0];
            var prevValues = priceValuesFromLine(lines[index - 1] || '');
            var nextValues = priceValuesFromLine(lines[index + 1] || '');
            var prevHigher = prevValues.some(function(value) { return value > currentValue; });
            var nextLower = nextValues.some(function(value) { return value < currentValue; });
            if (nextLower) score -= 70;
            else if (prevHigher) score += 75;
            else score += 15;
          }
          values.forEach(function(value, matchIndex) {
            addLineCandidate(lineCandidates, value, score + matchIndex, index, matchIndex);
          });
        });
        lineCandidates.sort(function(a, b) {
          if (b.score !== a.score) return b.score - a.score;
          if (b.order !== a.order) return b.order - a.order;
          return a.value - b.value;
        });
        return lineCandidates[0] && lineCandidates[0].value;
      }
      const cards = Array.from(document.querySelectorAll('a[href*="/products/"]'))
        .map((anchor) => {
          let node = anchor;
          for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
            const text = node.innerText || '';
            const rect = node.getBoundingClientRect();
            if (rect.width > 160 && rect.height > 180 && /원/.test(text)) {
              return { text, parsed: parseCurrentPriceFromText(text) };
            }
          }
          return null;
        })
        .filter(Boolean);
      const seen = new Set();
      const rows = [];
      for (const card of cards) {
        const key = card.text.replace(/\\s+/g, ' ').slice(0, 120);
        if (seen.has(key)) continue;
        seen.add(key);
        const priceLines = card.text.split(/\\n+/).map((line) => line.trim()).filter((line) => /[\\d,]{3,}\\s*원|%/.test(line));
        rows.push({ parsed: card.parsed, priceLines: priceLines.slice(0, 8) });
        if (rows.length >= 8) break;
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
