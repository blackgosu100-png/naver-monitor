// 백그라운드 서비스 워커 — 팝업이 닫혀도 조회 계속 실행

const DEFAULT_SERVER = 'https://naver-monitor-production.up.railway.app';
var stopRequested = false;
var currentFetchTabId = null;
var fetchRunning = false;

function normalizeServerUrl(url) {
  var value = (url || DEFAULT_SERVER).replace(/\/$/, '');
  if (value === 'http://localhost:5000' || value === 'http://localhost:5001') {
    return DEFAULT_SERVER;
  }
  return value;
}

async function getAuthState() {
  var data = await chrome.storage.local.get(['serverUrl', 'accessToken', 'refreshToken']);
  var serverUrl = normalizeServerUrl(data.serverUrl);
  if (data.serverUrl !== serverUrl) await chrome.storage.local.set({ serverUrl: serverUrl });
  return {
    serverUrl: serverUrl,
    accessToken: data.accessToken || '',
    refreshToken: data.refreshToken || ''
  };
}

async function refreshServiceToken(state) {
  if (!state.refreshToken) return null;
  var res = await fetch(state.serverUrl + '/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: state.refreshToken })
  });
  if (!res.ok) return null;
  var data = await res.json();
  if (!data.access_token) return null;
  await chrome.storage.local.set({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || state.refreshToken
  });
  return data.access_token;
}

async function ensureServiceToken(waitMs) {
  var deadline = Date.now() + (waitMs || 3000);
  var state = await getAuthState();

  while (Date.now() <= deadline) {
    if (state.accessToken) return state.accessToken;
    if (state.refreshToken) {
      var refreshed = await refreshServiceToken(state);
      if (refreshed) return refreshed;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    state = await getAuthState();
  }

  return '';
}

async function apiFetch(path, options) {
  var state = await getAuthState();
  if (!state.accessToken) state.accessToken = await ensureServiceToken(3000);
  if (!state.accessToken) throw new Error('서비스 로그인이 필요합니다.');
  options = options || {};
  options.headers = Object.assign({}, options.headers || {}, {
    'Authorization': 'Bearer ' + state.accessToken
  });
  var res = await fetch(state.serverUrl + path, options);
  if (res.status === 401) {
    var newToken = await refreshServiceToken(state);
    if (newToken) {
      options.headers.Authorization = 'Bearer ' + newToken;
      res = await fetch(state.serverUrl + path, options);
    }
  }
  return res;
}

function parseNaverUrl(url) {
  var m = url.match(/(?:smartstore|brand)\.naver\.com\/([^/?#]+)\/products\/(\d+)/);
  return m ? { slug: m[1], pid: m[2] } : null;
}

function parseCoupangUrl(url) {
  var m = (url || '').match(/coupang\.com\/(?:vp\/)?products\/(\d+)/);
  if (!m) return null;
  var item = (url || '').match(/[?&]itemId=(\d+)/);
  var vendor = (url || '').match(/[?&]vendorItemId=(\d+)/);
  return {
    pid: m[1],
    itemId: item ? item[1] : '',
    vendorItemId: vendor ? vendor[1] : ''
  };
}

function parseOhouseUrl(url) {
  var m = (url || '').match(/store\.ohou\.se\/goods\/(\d+)/);
  return m ? { pid: m[1] } : null;
}

function detectMarket(url) {
  if (parseOhouseUrl(url)) return 'ohouse';
  if (parseCoupangUrl(url)) return 'coupang';
  return 'naver';
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
  function getImageUrl(data) {
    var meta = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (meta && meta.content) return meta.content;
    var keys = ['representativeImageUrl', 'imageUrl', 'thumbnailUrl', 'productImageUrl'];
    for (var i = 0; i < keys.length; i++) {
      var found = deepFind(data, keys[i]);
      if (typeof found === 'string' && found) return found;
    }
    var img = document.querySelector('img[src*="phinf"], img[src*="shopping"], img[src*="shop-phinf"]');
    return img && img.src ? img.src : '';
  }
  if (typeof window.__naverStockCache === 'undefined')
    return { ok: false, error: 'hook미설치' };
  var data = window.__naverStockCache[pid];
  if (!data) return { ok: false, error: '캐시 없음 (SSR/XHR 데이터 미수신)' };
  var imageUrl = getImageUrl(data);
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
  return { ok: true, options: options, total: total, image_url: imageUrl };
}

function readCoupangMonthlyPurchase(pid) {
  function getImageUrl() {
    var meta = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (meta && meta.content) return meta.content;
    var img = document.querySelector('img[src*="coupangcdn.com"]');
    return img && img.src ? img.src : '';
  }

  function findSocial(data) {
    var root = Array.isArray(data) ? data[0] : data;
    var modules = root && root.moduleData;
    if (!Array.isArray(modules)) return null;
    for (var i = 0; i < modules.length; i++) {
      var item = modules[i];
      if (
        item &&
        item.viewType === 'PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE' &&
        item.type === 'purchase'
      ) return item;
    }
    return null;
  }

  function socialFromText(text) {
    if (!text) return null;
    var normalized = text.replace(/\\"/g, '"');
    var idx = normalized.indexOf('PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE');
    if (idx < 0) return null;
    var start = Math.max(0, idx - 600);
    var end = Math.min(normalized.length, idx + 400);
    var chunk = normalized.slice(start, end);
    if (chunk.indexOf('"type":"purchase"') < 0 && chunk.indexOf('"type": "purchase"') < 0) return null;
    var countMatch = chunk.match(/"socialProofNumUsers"\s*:\s*(\d+)/);
    if (!countMatch) return null;
    var highlightMatch = chunk.match(/"highlightText"\s*:\s*"([^"]*)"/);
    return {
      socialProofNumUsers: Number(countMatch[1]),
      highlightText: highlightMatch ? highlightMatch[1] : ''
    };
  }

  var data = window.__coupangQuantityCache && window.__coupangQuantityCache[pid];
  var social = data ? findSocial(data) : null;
  if (!social) {
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length && !social; i++) {
      social = socialFromText(scripts[i].textContent || '');
    }
  }
  if (!social) social = socialFromText(document.documentElement.innerHTML || '');
  if (!social || social.socialProofNumUsers == null) {
    return { ok: false, error: '쿠팡 월간 구매 데이터가 노출되지 않는 상품입니다' };
  }

  var total = Number(social.socialProofNumUsers);
  var label = (social.highlightText || '').trim() || '한 달간 구매 추정';
  return {
    ok: true,
    total: total,
    options: [{ name: label, qty: total }],
    image_url: getImageUrl()
  };
}

function readCoupangWingCatalogViews(keyword, productId, productUrl, expectedName) {
  function visible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 20 && rect.height > 10;
  }

  function text(el) {
    return (el && el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function toNumber(value) {
    var m = String(value || '').match(/[0-9][0-9,]*/);
    return m ? Number(m[0].replace(/,/g, '')) : null;
  }

  function getImageUrl(card) {
    var img = card && card.querySelector('img');
    return img && img.src ? img.src : '';
  }

  function findSearchInput() {
    var inputs = Array.from(document.querySelectorAll('input')).filter(function(input) {
      if (!visible(input)) return false;
      if (input.disabled || input.readOnly) return false;
      var type = (input.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', ''].indexOf(type) >= 0;
    });
    inputs.sort(function(a, b) {
      function score(input) {
        var label = [
          input.placeholder || '',
          input.getAttribute('aria-label') || '',
          input.getAttribute('name') || ''
        ].join(' ');
        var scoreValue = input.getBoundingClientRect().width;
        if (label.indexOf('\uC0C1\uD488') >= 0) scoreValue += 2000;
        if (label.indexOf('URL') >= 0) scoreValue += 1000;
        if (label.indexOf('\uCFE0\uD321') >= 0) scoreValue += 1000;
        if (input.closest('[role="dialog"], .modal, [class*="modal"], [class*="Modal"]')) scoreValue += 500;
        return scoreValue;
      }
      return score(b) - score(a);
    });
    return inputs[0] || null;
  }

  function openCatalogDialog() {
    var catalogText = '\uCE74\uD0C8\uB85C\uADF8';
    var matchingText = '\uB9E4\uCE6D';
    var productSearchText = '\uC0C1\uD488 \uAC80\uC0C9';
    var triggers = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(visible);
    var trigger = triggers.find(function(el) {
      var t = text(el);
      return t.indexOf(catalogText) >= 0 || t.indexOf(productSearchText) >= 0 || t.indexOf(matchingText) >= 0;
    });
    if (!trigger) return false;
    trigger.click();
    return true;
  }

  function clickSearch(input) {
    var scopes = [
      input && input.closest('[role="dialog"], .modal, [class*="modal"], [class*="Modal"]'),
      input && input.closest('form'),
      input && input.closest('section'),
      document
    ].filter(Boolean);
    var buttons = [];
    scopes.some(function(scope) {
      buttons = Array.from(scope.querySelectorAll('button')).filter(visible);
      return buttons.length > 0;
    });
    var productSearchText = '\uC0C1\uD488 \uAC80\uC0C9';
    var searchText = '\uAC80\uC0C9';
    var btn = buttons.find(function(button) {
      return text(button).indexOf(productSearchText) >= 0;
    }) || buttons.find(function(button) {
      return text(button).indexOf(searchText) >= 0;
    });
    if (btn) {
      btn.click();
      return true;
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return true;
  }

  function runSearchOnce() {
    var stamp = window.__naverMonitorCoupangWingSearch || {};
    if (!keyword) return false;
    var input = findSearchInput();
    if (!input) {
      openCatalogDialog();
      return false;
    }
    if (stamp.keyword === keyword && Date.now() - (stamp.clickedAt || 0) < 2500) return true;
    input.focus();
    try { input.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e) {}
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (setter) {
      setter.call(input, '');
      setter.call(input, keyword);
    } else {
      input.value = '';
      input.value = keyword;
    }
    try {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: keyword }));
    } catch(e) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    window.__naverMonitorCoupangWingSearch = {
      keyword: keyword,
      startedAt: stamp.keyword === keyword ? stamp.startedAt : Date.now(),
      clickedAt: Date.now()
    };
    return clickSearch(input);
  }

  function cardScore(card, cardText) {
    var score = 0;
    if (productId && cardText.indexOf(productId) >= 0) score += 100;
    if (productId) {
      var links = Array.from(card.querySelectorAll('a[href]'));
      if (links.some(function(a) { return (a.href || '').indexOf(productId) >= 0; })) score += 100;
    }
    if (productUrl && cardText.indexOf(productUrl) >= 0) score += 20;
    if (expectedName) {
      var name = text(card.querySelector('.product-name')) || cardText;
      var cleanExpected = expectedName.replace(/\s+/g, '');
      var cleanName = name.replace(/\s+/g, '');
      if (cleanExpected && cleanName.indexOf(cleanExpected.slice(0, Math.min(8, cleanExpected.length))) >= 0) score += 10;
    }
    return score;
  }

  function readResults() {
    var viewLabel = '\uC870\uD68C\uC218';
    var cards = Array.from(document.querySelectorAll('.result-row, .product-info')).filter(function(card) {
      return text(card).indexOf(viewLabel) >= 0;
    });
    if (!cards.length) {
      cards = Array.from(document.querySelectorAll('div, article, li')).filter(function(card) {
        var t = text(card);
        return t.indexOf(viewLabel) >= 0 && t.length < 3000;
      });
    }

    var parsed = [];
    cards.forEach(function(card) {
      var cardText = text(card);
      var viewNumber = null;
      var rows = Array.from(card.querySelectorAll('tr'));
      for (var i = 0; i < rows.length; i++) {
        var rowText = text(rows[i]);
        if (rowText.indexOf(viewLabel) < 0) continue;
        viewNumber = toNumber(rowText.replace(viewLabel, ''));
        if (viewNumber != null) break;
      }
      if (viewNumber == null) {
        var m = cardText.match(new RegExp(viewLabel + '\\s*([0-9,]+)'));
        if (m) viewNumber = toNumber(m[1]);
      }
      if (viewNumber == null) return;
      var score = cardScore(card, cardText);
      if (score <= 0) return;
      parsed.push({
        score: score,
        views28: viewNumber,
        name: text(card.querySelector('.product-name')) || expectedName || '',
        image_url: getImageUrl(card)
      });
    });

    parsed.sort(function(a, b) { return b.score - a.score; });
    return parsed[0] || null;
  }

  var noResultText = '\uAC80\uC0C9\uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4';
  var stamp = window.__naverMonitorCoupangWingSearch || {};
  if (stamp.keyword === keyword) {
    var result = readResults();
    if (result) {
      return {
        ok: true,
        views28: result.views28,
        name: result.name,
        image_url: result.image_url
      };
    }
  }

  if (stamp.keyword === keyword && text(document.body).indexOf(noResultText) >= 0) {
    return { ok: false, final: true, error: 'Wing search returned no results' };
  }
  if (
    stamp.keyword === keyword &&
    Date.now() - (stamp.clickedAt || 0) > 4500 &&
    text(document.body).indexOf('\uC870\uD68C\uC218') >= 0
  ) {
    return { ok: false, final: true, error: 'Wing search returned non-matching results' };
  }

  if (!runSearchOnce()) {
    return { ok: false, pending: true, error: 'Wing search input not ready' };
  }
  return { ok: false, pending: true, error: 'Waiting for Wing search results' };
}

async function readOhouseStock(pid) {
  function getImageUrl(data) {
    var image = data && data.production && data.production.image;
    if (image && image.url) return image.url;
    if (typeof document === 'undefined') return '';
    var meta = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (meta && meta.content) return meta.content;
    var img = document.querySelector('img[src*="ohouse"], img[src*="ohou.se"]');
    return img && img.src ? img.src : '';
  }

  var res = await fetch('https://store.ohou.se/api/goods/options?id=' + pid, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    credentials: 'include'
  });
  if (res.status === 404) return { ok: false, error: '오늘의집 상품을 찾을 수 없습니다' };
  if (!res.ok) return { ok: false, error: '오늘의집 옵션 API 오류: HTTP ' + res.status };

  var data = await res.json();
  var production = data.production || {};
  var options = [];
  (production.options || []).forEach(function(opt) {
    if (opt.stock == null) return;
    var parts = [opt.explain || '', opt.explain2 || ''].filter(Boolean);
    options.push({
      name: parts.join(' / ') || '옵션',
      qty: Number(opt.stock) || 0
    });
  });

  if (!options.length) {
    if (production.isSoldOut === true) options.push({ name: '전체', qty: 0 });
    else return { ok: false, error: '오늘의집 옵션 재고를 찾을 수 없습니다' };
  }

  var total = options.reduce(function(sum, item) { return sum + item.qty; }, 0);
  return { ok: true, total: total, options: options, image_url: getImageUrl(data) };
}

async function setStatus(status) {
  await chrome.storage.local.set({ fetchStatus: status });
}

function shouldStop() {
  return !!stopRequested;
}

async function stopCurrentFetch() {
  stopRequested = true;
  if (currentFetchTabId !== null) {
    try {
      await chrome.tabs.remove(currentFetchTabId);
    } catch(e) {}
    currentFetchTabId = null;
  }
  await setStatus({
    running: false,
    stopped: true,
    msg: 'STOP 요청으로 조회를 중지했습니다.',
    results: []
  });
}

async function openTab(url, active) {
  if (active === undefined) active = true;
  return new Promise((resolve, reject) => {
    var done = false;
    var timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      reject(new Error('탭 로딩 타임아웃'));
    }, 30000);

    var tid = null;
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    function onUpdated(tabId, changeInfo) {
      if (tabId === tid && changeInfo.status === 'complete') {
        if (done) return;
        done = true;
        cleanup();
        resolve(tid);
      }
    }
    function onRemoved(tabId) {
      if (tabId === tid) {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(shouldStop() ? '사용자 중지' : '탭이 닫힘'));
      }
    }

    chrome.tabs.create({ url, active }, (tab) => {
      if (chrome.runtime.lastError) { clearTimeout(timer); reject(new Error(chrome.runtime.lastError.message)); return; }
      tid = tab.id;
      currentFetchTabId = tid;
      if (shouldStop()) {
        chrome.tabs.remove(tid, () => {});
        if (!done) {
          done = true;
          cleanup();
          reject(new Error('사용자 중지'));
        }
        return;
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  });
}

async function waitForCache(tabId, pid, onStatus) {
  var elapsed = 0;
  var verifying = false;
  var maxWait = 120000;

  while (elapsed < maxWait) {
    if (shouldStop()) return { ok: false, stopped: true, error: '사용자 중지' };
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
  if (shouldStop()) return { ok: false, stopped: true, error: '사용자 중지' };
  return { ok: false, error: '타임아웃' };
}

async function waitForCoupangMonthly(tabId, pid) {
  var elapsed = 0;
  var maxWait = 45000;
  while (elapsed < maxWait) {
    if (shouldStop()) return { ok: false, stopped: true, error: '?ъ슜??以묒?' };
    try {
      var res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readCoupangMonthlyPurchase,
        args: [pid]
      });
      var cr = res && res[0] && res[0].result;
      if (cr && cr.ok) return cr;
    } catch(e) {
      return { ok: false, error: '쿠팡 데이터 읽기 실패' };
    }
    await new Promise(r => setTimeout(r, 1000));
    elapsed += 1000;
  }
  return { ok: false, error: '쿠팡 월간 구매 데이터 대기 시간 초과' };
}

async function fetchCoupangMonthlyFromServer(comp) {
  try {
    var res = await apiFetch('/api/coupang/monthly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: comp.id, url: comp.url })
    });
    var data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { ok: false, error: data.error || ('HTTP ' + res.status) };
    }
    return {
      ok: true,
      total: data.total,
      options: data.options || [],
      image_url: data.image_url || '',
      fetched_at: data.fetched_at || ''
    };
  } catch(e) {
    return { ok: false, error: String(e) };
  }
}

async function fetchCoupangMonthlyDirect(comp, parsed) {
  function findSocial(data) {
    var root = Array.isArray(data) ? data[0] : data;
    var modules = root && root.moduleData;
    if (!Array.isArray(modules)) return null;
    return modules.find(function(item) {
      return item &&
        item.viewType === 'PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE' &&
        item.type === 'purchase';
    }) || null;
  }

  function firstMatch(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  var productId = parsed && parsed.pid;
  var itemId = parsed && parsed.itemId;
  var vendorItemId = parsed && parsed.vendorItemId;
  var imageUrl = '';

  try {
    if (!vendorItemId) {
      var pageRes = await fetch(comp.url, {
        credentials: 'include',
        cache: 'no-store'
      });
      var html = await pageRes.text();
      var decoded = html;
      try { decoded = decodeURIComponent(html); } catch(e) {}
      var joined = html + '\n' + decoded;
      var imageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      vendorItemId = firstMatch(joined, [
        /[?&]vendorItemId=(\d+)/,
        /"vendorItemId"\s*:\s*"?(\d+)"?/,
        /\\"vendorItemId\\"\s*:\s*\\"?(\d+)/,
        /vendorItemId["'=:\s]+(\d+)/
      ]) || vendorItemId;
      itemId = itemId || firstMatch(joined, [
        /[?&]itemId=(\d+)/,
        /"itemId"\s*:\s*"?(\d+)"?/,
        /\\"itemId\\"\s*:\s*\\"?(\d+)/,
        /itemId["'=:\s]+(\d+)/
      ]);
      imageUrl = imageMatch ? imageMatch[1] : '';
    }

    if (!productId || !vendorItemId) {
      return { ok: false, error: 'Coupang product identifiers not found' };
    }

    var params = new URLSearchParams({
      productId: productId,
      vendorItemId: vendorItemId,
      deliveryToggle: 'true',
      landingProductId: productId,
      landingVendorItemId: vendorItemId
    });
    if (itemId) params.set('landingItemId', itemId);

    var res = await fetch('https://www.coupang.com/next-api/products/quantity-info?' + params.toString(), {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    if (!res.ok) return { ok: false, error: 'Coupang monthly HTTP ' + res.status };
    var data = await res.json();
    var social = findSocial(data);
    if (!social) return { ok: false, error: 'Coupang monthly sales not found' };
    var count = social.socialProofNumUsers;
    if (count == null) {
      var digits = String(social.highlightText || '').replace(/\D+/g, '');
      count = digits ? Number(digits) : null;
    }
    if (count == null) return { ok: false, error: 'Coupang monthly sales count not found' };
    return {
      ok: true,
      total: Number(count),
      options: [{ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9', qty: Number(count) }],
      image_url: imageUrl
    };
  } catch(e) {
    return { ok: false, error: String(e) };
  }
}

async function waitForCoupangWingViews(tabId, parsed, comp) {
  var keywords = [
    (comp && comp.url) || '',
    (parsed && parsed.pid) || '',
    (comp && comp.name) || ''
  ].filter(Boolean).filter(function(value, index, list) {
    return list.indexOf(value) === index;
  });
  var maxWaitPerKeyword = 12000;
  var lastError = 'Wing views timed out';

  for (var k = 0; k < keywords.length; k++) {
    var elapsed = 0;
    var keyword = keywords[k];
    while (elapsed < maxWaitPerKeyword) {
      if (shouldStop()) return { ok: false, stopped: true, error: 'stopped' };
      try {
        var res = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: readCoupangWingCatalogViews,
          args: [
            keyword,
            (parsed && parsed.pid) || '',
            (comp && comp.url) || '',
            (comp && comp.name) || ''
          ]
        });
        var frameResults = (res || []).map(function(item) { return item && item.result; }).filter(Boolean);
        var cr = frameResults.find(function(item) { return item && item.ok; })
          || frameResults.find(function(item) { return item && item.final; })
          || frameResults.find(function(item) { return item && item.error; });
        if (cr && cr.ok) return cr;
        if (cr && cr.final) {
          lastError = cr.error || lastError;
          break;
        }
        if (cr && cr.error) lastError = cr.error;
      } catch(e) {
        return { ok: false, error: 'Wing views script failed' };
      }
      await new Promise(r => setTimeout(r, 1500));
      elapsed += 1500;
    }
  }
  return { ok: false, error: lastError };
}

async function collectCoupangWingViews(parsed, comp) {
  var tabId = null;
  try {
    tabId = await openTab('https://wing.coupang.com/tenants/seller-web/vendor-inventory/formV2', false);
    currentFetchTabId = tabId;
    return await waitForCoupangWingViews(tabId, parsed, comp);
  } catch(e) {
    return { ok: false, error: String(e) };
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId, () => {});
    if (currentFetchTabId === tabId) currentFetchTabId = null;
  }
}

async function waitForOhouseStock(tabId, pid) {
  var elapsed = 0;
  var maxWait = 45000;
  while (elapsed < maxWait) {
    if (shouldStop()) return { ok: false, stopped: true, error: '?ъ슜??以묒?' };
    try {
      var res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readOhouseStock,
        args: [pid]
      });
      var cr = res && res[0] && res[0].result;
      if (cr && cr.ok) return cr;
      if (cr && cr.error && !String(cr.error).includes('HTTP 403')) return cr;
    } catch(e) {
      return { ok: false, error: '오늘의집 데이터 읽기 실패' };
    }
    await new Promise(r => setTimeout(r, 1000));
    elapsed += 1000;
  }
  return { ok: false, error: '오늘의집 재고 데이터 대기 시간 초과' };
}

async function runFetch(competitors) {
  if (fetchRunning) return;
  fetchRunning = true;
  stopRequested = false;
  currentFetchTabId = null;
  var coupangWingTabId = null;
  var results = [];
  var stopped = false;

  for (var i = 0; i < competitors.length; i++) {
    if (shouldStop()) { stopped = true; break; }
    var comp = competitors[i];
    var market = detectMarket(comp.url);
    var parsed = market === 'coupang'
      ? parseCoupangUrl(comp.url)
      : market === 'ohouse'
        ? parseOhouseUrl(comp.url)
        : parseNaverUrl(comp.url);

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
      var cr;
      if (market === 'coupang') {
        var monthlyPromise = fetchCoupangMonthlyDirect(comp, parsed).then(async function(monthly) {
          return monthly && monthly.ok ? monthly : await fetchCoupangMonthlyFromServer(comp);
        });

        if (coupangWingTabId === null) {
          coupangWingTabId = await openTab('https://wing.coupang.com/tenants/seller-web/vendor-inventory/formV2', false);
          await new Promise(r => setTimeout(r, 1200));
        }
        currentFetchTabId = coupangWingTabId;
        if (shouldStop()) { stopped = true; break; }

        await setStatus({
          running: true,
          current: i + 1,
          total: competitors.length,
          name: comp.name,
          msg: '\uCFE0\uD321 \uC870\uD68C\uC218 \uD655\uC778 \uC911...',
          results
        });

        var wing = await waitForCoupangWingViews(coupangWingTabId, parsed, comp);
        var monthly = await monthlyPromise;
        if (wing && wing.stopped) {
          cr = wing;
        } else if ((wing && wing.ok) || (monthly && monthly.ok)) {
          var views = wing && wing.ok ? Number(wing.views28) || 0 : null;
          var monthlySales = monthly && monthly.ok ? Number(monthly.total) || 0 : null;
          var conversionRate = views && monthlySales !== null ? (monthlySales / views) * 100 : null;
          var options = [];
          if (views !== null) options.push({ name: '\uC870\uD68C\uC218', qty: views });
          if (monthlySales !== null) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9', qty: monthlySales });
          else if (monthly && !monthly.ok) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9 \uC624\uB958', qty: null, text: monthly.error || 'Monthly sales unavailable' });
          if (conversionRate !== null) options.push({ name: '\uC804\uD658\uC728', qty: Number(conversionRate.toFixed(2)) });
          else if (views !== null && monthly && !monthly.ok) options.push({ name: '\uC804\uD658\uC728 \uC624\uB958', qty: null, text: '\uC6D4\uD310\uB9E4\uC218\uB7C9\uC774 \uC5C6\uC5B4 \uACC4\uC0B0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4' });
          cr = {
            ok: true,
            total: monthlySales,
            options: options,
            image_url: (monthly && monthly.image_url) || (wing && wing.image_url) || ''
          };
        } else {
          cr = { ok: false, error: (monthly && monthly.error) || (wing && wing.error) || 'Coupang data not found' };
        }
      } else if (market === 'ohouse') {
        cr = await readOhouseStock(parsed.pid);
      } else {
        tabId = await openTab(comp.url);
        currentFetchTabId = tabId;
        if (shouldStop()) { stopped = true; break; }
        cr = await waitForCache(tabId, parsed.pid, async (msg) => {
          await setStatus({ running: true, current: i + 1, total: competitors.length, name: comp.name, msg, results });
        });
      }

      if (cr && cr.stopped) {
        stopped = true;
        break;
      } else if (cr && cr.ok) {
        results.push({ id: comp.id, name: comp.name, total: cr.total, options: cr.options, image_url: cr.image_url || '', error: null, fetched_at: new Date().toISOString() });
      } else {
        results.push({ id: comp.id, name: comp.name, error: (cr && cr.error) || '데이터 없음' });
      }
    } catch(e) {
      results.push({ id: comp.id, name: comp.name, error: String(e) });
    } finally {
      if (tabId !== null) chrome.tabs.remove(tabId, () => {});
      if (currentFetchTabId === tabId) currentFetchTabId = null;
    }

    if (shouldStop()) { stopped = true; break; }
    if (i < competitors.length - 1) {
      await new Promise(r => setTimeout(r, market === 'naver' ? 3000 : 900));
      if (shouldStop()) { stopped = true; break; }
    }
  }

  // 결과 서버에 저장
  if (coupangWingTabId !== null) {
    try { await chrome.tabs.remove(coupangWingTabId); } catch(e) {}
    if (currentFetchTabId === coupangWingTabId) currentFetchTabId = null;
  }

  if (results.length) {
    try {
      await apiFetch('/api/stock-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results })
      });
    } catch(e) {}
  }

  var okCount = results.filter(r => !r.error).length;
  var errItems = results.filter(r => r.error);
  var msg = stopped ? `⏹ 중지됨. 저장된 결과 ${okCount}/${results.length} 성공` : `✅ 완료! ${okCount}/${results.length} 성공`;
  if (errItems.length) msg += '\n❌ 실패: ' + errItems.map(r => r.name + '(' + r.error + ')').join(', ');

  await setStatus({ running: false, done: !stopped, stopped, msg, results });
  fetchRunning = false;
  stopRequested = false;
  currentFetchTabId = null;

  // 대시보드 탭 새로고침
  var state = await getAuthState();
  chrome.tabs.query({ url: `${state.serverUrl}/*` }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: 'HISTORY_UPDATED' }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_FETCH') {
    (async () => {
      var competitors = msg.competitors || [];
      if (!competitors.length) {
        sendResponse({ ok: false, error: '조회할 상품이 없습니다.' });
        return;
      }
      if (fetchRunning) {
        sendResponse({ ok: false, error: '이미 조회가 진행 중입니다. 먼저 STOP을 눌러주세요.' });
        return;
      }
      var token = await ensureServiceToken(4000);
      if (!token) {
        sendResponse({ ok: false, error: '확장 프로그램에서 서비스 로그인이 필요합니다.' });
        return;
      }
      setStatus({ running: true, current: 0, total: competitors.length, msg: '시작 중...', results: [] });
      runFetch(competitors);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'STOP_FETCH') {
    (async () => {
      await stopCurrentFetch();
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});
