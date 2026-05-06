// ─── 유틸 ─────────────────────────────────────────────────────
function showMsg(id, text, cls) {
  var el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + cls;
  el.style.display = 'block';
}

function parseNaverUrl(url) {
  var m = url.match(/(?:smartstore|brand)\.naver\.com\/([^/?#]+)\/products\/(\d+)/);
  return m ? { slug: m[1], pid: m[2] } : null;
}

// ─── 탭 열고 완전히 로드될 때까지 대기 ────────────────────────
function openAndWait(url) {
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      reject(new Error('탭 로딩 타임아웃 (30초)'));
    }, 30000);

    chrome.tabs.create({ url: url, active: false }, function(tab) {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
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

// ─── 캐시에서 재고 읽기 (MAIN world 주입 함수) ─────────────────
// content.js가 Naver SPA의 fetch를 가로채 window.__naverStockCache에 저장한 데이터를 읽음
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

  // 진단: 캐시 변수 자체가 존재하는지
  if (typeof window.__naverStockCache === 'undefined') {
    return { ok: false, error: 'hook미설치 (content.js MAIN world 미실행)' };
  }
  var data = window.__naverStockCache[pid];
  if (!data) return { ok: false, error: '캐시 없음 (SSR/XHR 데이터 미수신)' };

  var combos = deepFind(data, 'optionCombinations') || [];
  var options = combos.map(function(c) {
    var parts = [c.optionName1, c.optionName2, c.optionName3].filter(Boolean);
    return {
      name: parts.join(' / ') || c.name || '옵션',
      qty: c.stockQuantity != null ? c.stockQuantity : 0
    };
  });

  if (options.length === 0) {
    var sq = deepFind(data, 'stockQuantity');
    if (sq != null) options.push({ name: '전체', qty: sq });
  }

  if (options.length === 0) return { ok: false, error: '재고 데이터 없음' };

  var total = options.reduce(function(s, o) { return s + o.qty; }, 0);
  return { ok: true, options: options, total: total };
}

// ─── 대기 큐 자동 처리 (팝업 열릴 때) ────────────────────────
async function checkAndProcessQueue() {
  var qSec = document.getElementById('queue-section');
  var qBar = document.getElementById('queue-bar');
  var qFill = document.getElementById('queue-fill');
  try {
    var r = await fetch('http://localhost:5000/api/public/queue');
    if (!r.ok) return;
    var data = await r.json();
    var queue = data.queue || [];
    if (queue.length === 0) return;

    qSec.style.display = 'block';
    qBar.style.display = 'block';
    qFill.style.width = '0%';
    showMsg('queue-msg', '대기 중인 조회 ' + queue.length + '개 처리 시작...', 'info');

    var results = [];
    for (var i = 0; i < queue.length; i++) {
      var comp = queue[i];
      var parsed = parseNaverUrl(comp.url);
      showMsg('queue-msg', '처리 중 (' + (i + 1) + '/' + queue.length + '): ' + comp.name, 'info');
      qFill.style.width = Math.round(((i + 0.5) / queue.length) * 85) + '%';

      if (!parsed) {
        results.push({ id: comp.id, name: comp.name, error: 'URL 형식 오류' });
        continue;
      }
      var tabId = null;
      try {
        tabId = await openAndWait(comp.url);
        await new Promise(function(res) { setTimeout(res, 4000); });
        var cacheResult = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'MAIN',
          func: readStockFromCache,
          args: [parsed.pid]
        });
        var cr = cacheResult && cacheResult[0] && cacheResult[0].result;
        if (cr && cr.ok) {
          results.push({ id: comp.id, name: comp.name, total: cr.total, options: cr.options, error: null, fetched_at: new Date().toISOString() });
        } else {
          results.push({ id: comp.id, name: comp.name, error: (cr && cr.error) || '데이터 없음' });
        }
      } catch(e) {
        results.push({ id: comp.id, name: comp.name, error: String(e) });
      } finally {
        if (tabId !== null) chrome.tabs.remove(tabId, function() {});
      }
    }

    qFill.style.width = '90%';
    await fetch('http://localhost:5000/api/stock-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: results })
    });

    await fetch('http://localhost:5000/api/public/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: queue.map(function(c) { return c.id; }) })
    });

    qFill.style.width = '100%';
    var okCount = results.filter(function(res) { return !res.error; }).length;
    var errItems = results.filter(function(res) { return res.error; });
    var msg = '✅ ' + okCount + '/' + queue.length + ' 완료';
    if (errItems.length) msg += '\n❌ ' + errItems.map(function(res) { return res.name + '(' + res.error + ')'; }).join(', ');
    showMsg('queue-msg', msg, okCount === queue.length ? 'ok' : 'info');

    chrome.tabs.query({ url: 'http://localhost:5000/*' }, function(tabs) {
      if (tabs.length) chrome.tabs.reload(tabs[0].id);
    });
  } catch(e) {
    // 서버 미실행 등 — 조용히 무시
  }
}

// ─── 경쟁사 재고 조회 버튼 ────────────────────────────────────
document.getElementById('fetch-btn').addEventListener('click', async function() {
  var btn = document.getElementById('fetch-btn');
  var bar = document.getElementById('progress-bar');
  var fill = document.getElementById('progress-fill');
  btn.disabled = true;
  bar.style.display = 'block';
  fill.style.width = '0%';
  showMsg('fetch-msg', '앱 서버에서 경쟁사 목록 로드 중...', 'info');

  try {
    var listResp = await fetch('http://localhost:5000/api/public/competitors');
    if (!listResp.ok) throw new Error('앱 서버 연결 실패 — run.bat이 실행 중인지 확인하세요');
    var listData = await listResp.json();
    var competitors = listData.competitors || [];
    if (competitors.length === 0) throw new Error('등록된 경쟁사가 없습니다. 앱 설정에서 추가해주세요.');

    var results = [];

    for (var i = 0; i < competitors.length; i++) {
      var comp = competitors[i];
      var parsed = parseNaverUrl(comp.url);

      showMsg('fetch-msg', '조회 중 (' + (i + 1) + '/' + competitors.length + '): ' + comp.name, 'info');
      fill.style.width = Math.round(((i + 0.5) / competitors.length) * 85) + '%';

      if (!parsed) {
        results.push({ id: comp.id, name: comp.name, error: 'URL 형식 오류' });
        continue;
      }

      var tabId = null;
      try {
        // 상품 페이지를 탭으로 열기 (content.js가 자동으로 fetch 후킹)
        tabId = await openAndWait(comp.url);

        // Naver SPA가 상품 API를 호출하고 응답을 받을 시간 확보
        await new Promise(function(r) { setTimeout(r, 4000); });

        // 캐시에서 재고 데이터 읽기
        var cacheResult = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: 'MAIN',
          func: readStockFromCache,
          args: [parsed.pid]
        });
        var cr = cacheResult && cacheResult[0] && cacheResult[0].result;

        if (cr && cr.ok) {
          results.push({
            id: comp.id, name: comp.name,
            total: cr.total, options: cr.options,
            error: null, fetched_at: new Date().toISOString()
          });
        } else {
          results.push({ id: comp.id, name: comp.name, error: (cr && cr.error) || '데이터 없음' });
        }
      } catch(e) {
        results.push({ id: comp.id, name: comp.name, error: String(e) });
      } finally {
        if (tabId !== null) chrome.tabs.remove(tabId, function() {});
      }
    }

    fill.style.width = '90%';
    showMsg('fetch-msg', '결과 저장 중...', 'info');

    var saveResp = await fetch('http://localhost:5000/api/stock-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: results })
    });
    if (!saveResp.ok) throw new Error('결과 저장 실패');

    fill.style.width = '100%';
    var okCount = results.filter(function(r) { return !r.error; }).length;
    var errItems = results.filter(function(r) { return r.error; });
    var msg = '✅ 완료! ' + okCount + '/' + results.length + ' 성공';
    if (errItems.length) {
      msg += '\n❌ 실패: ' + errItems.map(function(r) { return r.name + '(' + r.error + ')'; }).join(', ');
    }
    showMsg('fetch-msg', msg, okCount === results.length ? 'ok' : 'info');

    chrome.tabs.query({ url: 'http://localhost:5000/*' }, function(tabs) {
      if (tabs.length) chrome.tabs.reload(tabs[0].id);
    });

  } catch(e) {
    showMsg('fetch-msg', '❌ ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// 팝업 열릴 때 대기 큐 자동 확인
checkAndProcessQueue();

// ─── 쿠키 전송 버튼 ───────────────────────────────────────────
document.getElementById('cookie-btn').addEventListener('click', function() {
  var btn = document.getElementById('cookie-btn');
  btn.disabled = true;
  showMsg('cookie-msg', '쿠키 읽는 중...', 'info');

  chrome.cookies.getAll({ domain: '.naver.com' }, function(cookies) {
    if (!cookies || cookies.length === 0) {
      showMsg('cookie-msg', '네이버 쿠키 없음. Chrome에서 naver.com에 로그인 후 시도하세요.', 'err');
      btn.disabled = false;
      return;
    }
    var cookieStr = cookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');
    var encoded;
    try { encoded = btoa(unescape(encodeURIComponent(cookieStr))); }
    catch(e) { showMsg('cookie-msg', '인코딩 오류: ' + e, 'err'); btn.disabled = false; return; }

    chrome.tabs.create(
      { url: 'http://localhost:5000/cookie-import?data=' + encodeURIComponent(encoded) },
      function() {
        showMsg('cookie-msg', '✅ 새 탭에서 저장 완료!', 'ok');
        btn.disabled = false;
      }
    );
  });
});
