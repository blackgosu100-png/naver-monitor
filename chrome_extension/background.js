// 백그라운드 서비스 워커 — 팝업이 닫혀도 조회 계속 실행

const SERVER = 'http://localhost:5001';

function parseNaverUrl(url) {
  var m = url.match(/(?:smartstore|brand)\.naver\.com\/([^/?#]+)\/products\/(\d+)/);
  return m ? { slug: m[1], pid: m[2] } : null;
}

function readStockFromCache(pid) {
  function deepFind(obj, key, depth) {
    depth = depth || 0;
    if (depth > 12 || obj == null || typeof obj !== 'object') return null;
    if (key in obj) return obj[key];
    var vals = Object.values(obj);
    for (var i = 0; i < vals.length; i++) {
      var r = deepFind(vals[i], key, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  if (typeof window.__naverStockCache === 'undefined')
    return { ok: false, error: 'hook미설치' };
  var data = window.__naverStockCache[pid];
  if (!data) return { ok: false, error: '캐시 없음 (SSR/XHR 데이터 미수신)' };
  var combos = deepFind(data, 'optionCombinations') || [];
  var options = combos.map(function(c) {
    var parts = [c.optionName1, c.optionName2, c.optionName3].filter(Boolean);
    return { name: parts.join(' / ') || c.name || '옵션', qty: c.stockQuantity != null ? c.stockQuantity : 0 };
  });
  if (options.length === 0) {
    var sq = deepFind(data, 'stockQuantity');
    if (sq != null) options.push({ name: '전체', qty: sq });
  }
  if (options.length === 0) return { ok: false, error: '재고 데이터 없음' };
  var total = options.reduce(function(s, o) { return s + o.qty; }, 0);
  return { ok: true, options: options, total: total };
}

async function setStatus(status) {
  await chrome.storage.local.set({ fetchStatus: status });
}

async function openTab(url) {
  return new Promise((resolve, reject) => {
    var timer = setTimeout(() => reject(new Error('탭 로딩 타임아웃')), 30000);
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError) { clearTimeout(timer); reject(new Error(chrome.runtime.lastError.message)); return; }
      var tid = tab.id;
      function onUpdated(tabId, changeInfo) {
        if (tabId === tid && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(timer);
          resolve(tid);
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function waitForCache(tabId, pid, onStatus) {
  var elapsed = 0;
  var verifying = false;
  var maxWait = 120000;

  while (elapsed < maxWait) {
    var tab;
    try { tab = await chrome.tabs.get(tabId); } catch(e) {
      return { ok: false, error: '탭이 닫힘' };
    }
    var currentUrl = tab.url || '';

    if (!currentUrl.includes('/products/')) {
      if (!verifying) {
        verifying = true;
        chrome.tabs.update(tabId, { active: true });
        if (onStatus) onStatus('⚠️ 인증 필요 — 전화번호 입력 후 자동 재개');
      }
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    if (verifying) {
      verifying = false;
      if (onStatus) onStatus('인증 완료 — 재고 데이터 로딩 중...');
      await new Promise(r => setTimeout(r, 2000));
      elapsed += 2000;
      continue;
    }

    var res;
    try {
      res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readStockFromCache,
        args: [pid]
      });
    } catch(e) {
      return { ok: false, error: '스크립트 실행 실패' };
    }
    var cr = res && res[0] && res[0].result;
    if (cr && cr.ok) return cr;

    await new Promise(r => setTimeout(r, 1000));
    elapsed += 1000;
  }
  return { ok: false, error: '타임아웃' };
}

async function runFetch(competitors) {
  var results = [];

  for (var i = 0; i < competitors.length; i++) {
    var comp = competitors[i];
    var parsed = parseNaverUrl(comp.url);

    await setStatus({
      running: true,
      current: i + 1,
      total: competitors.length,
      name: comp.name,
      msg: '조회 중...',
      results
    });

    if (!parsed) {
      results.push({ id: comp.id, name: comp.name, error: 'URL 형식 오류' });
      continue;
    }

    var tabId = null;
    try {
      tabId = await openTab(comp.url);
      var cr = await waitForCache(tabId, parsed.pid, async (msg) => {
        await setStatus({ running: true, current: i + 1, total: competitors.length, name: comp.name, msg, results });
      });

      if (cr && cr.ok) {
        results.push({ id: comp.id, name: comp.name, total: cr.total, options: cr.options, error: null, fetched_at: new Date().toISOString() });
      } else {
        results.push({ id: comp.id, name: comp.name, error: (cr && cr.error) || '데이터 없음' });
      }
    } catch(e) {
      results.push({ id: comp.id, name: comp.name, error: String(e) });
    } finally {
      if (tabId !== null) chrome.tabs.remove(tabId, () => {});
    }

    if (i < competitors.length - 1) await new Promise(r => setTimeout(r, 3000));
  }

  // 결과 서버에 저장
  try {
    await fetch(`${SERVER}/api/stock-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results })
    });
  } catch(e) {}

  var okCount = results.filter(r => !r.error).length;
  var errItems = results.filter(r => r.error);
  var msg = `✅ 완료! ${okCount}/${results.length} 성공`;
  if (errItems.length) msg += '\n❌ 실패: ' + errItems.map(r => r.name + '(' + r.error + ')').join(', ');

  await setStatus({ running: false, done: true, msg, results });

  // 대시보드 탭 새로고침
  chrome.tabs.query({ url: `${SERVER}/*` }, (tabs) => {
    if (tabs.length) chrome.tabs.reload(tabs[0].id);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_FETCH') {
    setStatus({ running: true, current: 0, total: msg.competitors.length, msg: '시작 중...', results: [] });
    runFetch(msg.competitors);
    sendResponse({ ok: true });
  }
  return false;
});
