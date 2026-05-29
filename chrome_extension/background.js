// 백그라운드 서비스 워커 — 팝업이 닫혀도 조회 계속 실행

const DEFAULT_SERVER = 'https://naver-monitor-production.up.railway.app';
const COUPANG_CACHE_KEY = 'coupangMetricCacheV1';
const COUPANG_MONTHLY_TTL = 12 * 60 * 60 * 1000;
const COUPANG_VIEWS_TTL = 24 * 60 * 60 * 1000;
const COUPANG_STOCK_TTL = 3 * 60 * 60 * 1000;
const COUPANG_PB_TTL = 30 * 24 * 60 * 60 * 1000;
const COUPANG_VIEW_FAILURE_TTL = 7 * 24 * 60 * 60 * 1000;
const COUPANG_PB_BRANDS = ['코멧', '곰곰', '탐사', '비타할로', '홈플래닛', '캐럿', '베이스알파', '줌베이직', '줌 베이직'];
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
  var m = (url || '').match(/coupang\.com\/(?:v[pm]\/)?products\/(\d+)/);
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

function coupangCacheKey(parsed) {
  return parsed && parsed.pid ? String(parsed.pid) : '';
}

function coupangStockCacheKey(parsed) {
  if (!parsed || !parsed.pid) return '';
  return [parsed.pid, parsed.vendorItemId || parsed.itemId || ''].join(':');
}

function isFreshCache(entry, ttl) {
  return !!entry && !!entry.ts && Date.now() - entry.ts < ttl;
}

function isLikelyCoupangPb(comp) {
  var name = String((comp && comp.name) || '');
  return COUPANG_PB_BRANDS.some(function(brand) {
    return name.indexOf(brand) >= 0;
  });
}

function emptyCoupangCache() {
  return { monthly: {}, views: {}, stock: {}, pb: {}, viewFailures: {} };
}

async function getCoupangCache() {
  var data = await chrome.storage.local.get(COUPANG_CACHE_KEY);
  var cache = data[COUPANG_CACHE_KEY] || {};
  return Object.assign(emptyCoupangCache(), cache);
}

function pruneCoupangCacheBucket(bucket, limit) {
  var entries = Object.entries(bucket || {});
  if (entries.length <= limit) return bucket || {};
  entries.sort(function(a, b) { return (b[1].ts || 0) - (a[1].ts || 0); });
  return Object.fromEntries(entries.slice(0, limit));
}

async function saveCoupangCache(cache) {
  cache.monthly = pruneCoupangCacheBucket(cache.monthly, 400);
  cache.views = pruneCoupangCacheBucket(cache.views, 400);
  cache.stock = pruneCoupangCacheBucket(cache.stock, 400);
  cache.pb = pruneCoupangCacheBucket(cache.pb, 400);
  cache.viewFailures = pruneCoupangCacheBucket(cache.viewFailures, 400);
  await chrome.storage.local.set({ [COUPANG_CACHE_KEY]: cache });
}

async function getCachedCoupangMetric(kind, key, ttl) {
  if (!key) return null;
  var cache = await getCoupangCache();
  var entry = cache[kind] && cache[kind][key];
  if (!isFreshCache(entry, ttl)) return null;
  return Object.assign({}, entry.data || {}, { source: 'cache' });
}

async function setCachedCoupangMetric(kind, key, data) {
  if (!key || !data || !data.ok) return;
  var cache = await getCoupangCache();
  cache[kind] = cache[kind] || {};
  cache[kind][key] = {
    ts: Date.now(),
    data: {
      ok: true,
      total: data.total,
      options: data.options || [],
      views28: data.views28,
      stock: data.stock,
      image_url: data.image_url || ''
    }
  };
  await saveCoupangCache(cache);
}

async function markCoupangPb(key, reason) {
  if (!key) return;
  var cache = await getCoupangCache();
  cache.pb[key] = { ts: Date.now(), reason: reason || 'PB 상품으로 쿠팡 지표 조회 제외' };
  await saveCoupangCache(cache);
}

async function getCachedCoupangPb(key) {
  if (!key) return null;
  var cache = await getCoupangCache();
  var entry = cache.pb[key];
  return isFreshCache(entry, COUPANG_PB_TTL) ? entry : null;
}

async function recordCoupangViewFailure(key, reason) {
  if (!key) return;
  var cache = await getCoupangCache();
  var prev = cache.viewFailures[key] || {};
  cache.viewFailures[key] = {
    ts: Date.now(),
    failures: (prev.failures || 0) + 1,
    reason: reason || 'Wing 조회수 매칭 실패'
  };
  await saveCoupangCache(cache);
}

async function clearCoupangViewFailure(key) {
  if (!key) return;
  var cache = await getCoupangCache();
  if (cache.viewFailures && cache.viewFailures[key]) {
    delete cache.viewFailures[key];
    await saveCoupangCache(cache);
  }
}

async function getCachedCoupangViewFailure(key) {
  if (!key) return null;
  var cache = await getCoupangCache();
  var entry = cache.viewFailures[key];
  if (!isFreshCache(entry, COUPANG_VIEW_FAILURE_TTL)) return null;
  return entry.failures >= 2 ? entry : null;
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
    var seen = new Set();
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || depth > 14 || seen.has(node)) return null;
      seen.add(node);
      if (
        node.viewType === 'PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE' &&
        node.type === 'purchase' &&
        node.socialProofNumUsers != null
      ) return node;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          var arrFound = visit(node[i], depth + 1);
          if (arrFound) return arrFound;
        }
        return null;
      }
      var keys = Object.keys(node);
      for (var j = 0; j < keys.length; j++) {
        var found = visit(node[keys[j]], depth + 1);
        if (found) return found;
      }
      return null;
    }
    return visit(data, 0);
  }

  function socialFromText(text) {
    if (!text) return null;
    var normalized = text.replace(/\\"/g, '"');
    var patterns = [
      /"viewType"\s*:\s*"PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE"[\s\S]{0,2500}?"type"\s*:\s*"purchase"[\s\S]{0,2500}?"socialProofNumUsers"\s*:\s*(\d+)/,
      /"type"\s*:\s*"purchase"[\s\S]{0,2500}?"viewType"\s*:\s*"PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE"[\s\S]{0,2500}?"socialProofNumUsers"\s*:\s*(\d+)/,
      /PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE[\s\S]{0,2500}?socialProofNumUsers\s*["']?\s*:\s*(\d+)/
    ];
    var countMatch = null;
    for (var i = 0; i < patterns.length && !countMatch; i++) {
      countMatch = normalized.match(patterns[i]);
    }
    if (!countMatch) return null;
    var idx = normalized.indexOf(countMatch[0]);
    var chunk = normalized.slice(Math.max(0, idx - 500), Math.min(normalized.length, idx + countMatch[0].length + 800));
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
    if (stamp.keyword === keyword && stamp.clickedAt) return true;
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
      if (productId && score < 100) return;
      if (!productId && score <= 0) return;
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

  var noResultPatterns = [
    '\uAC80\uC0C9\uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4',
    '\uAC80\uC0C9 \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4',
    '\uAC80\uC0C9\uB41C \uC0C1\uD488\uC774 \uC5C6\uC2B5\uB2C8\uB2E4'
  ];
  var bodyText = text(document.body);
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

  if (stamp.keyword === keyword && noResultPatterns.some(function(pattern) { return bodyText.indexOf(pattern) >= 0; })) {
    return { ok: false, final: true, error: 'Wing search returned no results' };
  }
  if (
    stamp.keyword === keyword &&
    Date.now() - (stamp.clickedAt || 0) > 4500 &&
    bodyText.indexOf('\uC870\uD68C\uC218') >= 0
  ) {
    return { ok: false, final: true, error: 'Wing search returned non-matching results' };
  }
  if (stamp.keyword === keyword && Date.now() - (stamp.clickedAt || 0) > 9000) {
    return { ok: false, final: true, error: 'Wing search produced no matching result' };
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

async function focusSourceTab(options) {
  if (!options) return;
  try {
    if (options.returnFocusWindowId != null) {
      await chrome.windows.update(options.returnFocusWindowId, { focused: true });
    }
    if (options.returnFocusTabId != null) {
      await chrome.tabs.update(options.returnFocusTabId, { active: true });
    }
  } catch(e) {}
}

function scheduleFocusSourceTab(options, delayMs) {
  if (!options || options.returnFocus === false) return;
  if (options.returnFocusTabId == null && options.returnFocusWindowId == null) return;
  setTimeout(function() {
    focusSourceTab(options);
  }, delayMs || 500);
}

async function openTab(url, active, options) {
  if (active === undefined) active = true;
  options = options || {};
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

    function finishWithTab(tab) {
      if (!tab || tab.id == null) {
        clearTimeout(timer);
        reject(new Error('tab create failed'));
        return;
      }
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
      scheduleFocusSourceTab(options, options.focusBackDelayMs || 650);
      if (tab.status === 'complete') {
        if (done) return;
        done = true;
        cleanup();
        resolve(tid);
      }
    }

    if (options.popupWindow) {
      chrome.windows.create({
        url,
        type: 'popup',
        focused: true,
        width: options.width || 430,
        height: options.height || 720,
        left: options.left == null ? 0 : options.left,
        top: options.top == null ? 0 : options.top
      }, (win) => {
        if (chrome.runtime.lastError) { clearTimeout(timer); reject(new Error(chrome.runtime.lastError.message)); return; }
        finishWithTab(win && win.tabs && win.tabs[0]);
      });
      return;
    }

    chrome.tabs.create({ url, active }, (tab) => {
      if (chrome.runtime.lastError) { clearTimeout(timer); reject(new Error(chrome.runtime.lastError.message)); return; }
      finishWithTab(tab);
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

async function collectCoupangMonthlyFromPage(comp, parsed) {
  var tabId = null;
  try {
    tabId = await openTab(comp.url, true);
    currentFetchTabId = tabId;
    return await waitForCoupangMonthly(tabId, parsed.pid);
  } catch(e) {
    return { ok: false, error: String(e) };
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId, () => {});
    if (currentFetchTabId === tabId) currentFetchTabId = null;
  }
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
  function apiError(data) {
    if (!data || Array.isArray(data) || typeof data !== 'object') return '';
    if (!data.rCode && !data.rMessage) return '';
    return [data.rCode, data.rMessage].filter(Boolean).join(': ');
  }

  function findSocial(data) {
    var seen = new Set();
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || depth > 14 || seen.has(node)) return null;
      seen.add(node);
      if (
        node.viewType === 'PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE' &&
        node.type === 'purchase' &&
        node.socialProofNumUsers != null
      ) return node;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          var arrFound = visit(node[i], depth + 1);
          if (arrFound) return arrFound;
        }
        return null;
      }
      var keys = Object.keys(node);
      for (var j = 0; j < keys.length; j++) {
        var found = visit(node[keys[j]], depth + 1);
        if (found) return found;
      }
      return null;
    }
    return visit(data, 0);
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
    var errorMessage = apiError(data);
    if (errorMessage) {
      return { ok: false, skipServer: true, error: 'Coupang monthly API ' + errorMessage };
    }
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

async function readCoupangStockEstimate(productUrl, productId, itemId, vendorItemId, expectedStock) {
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function apiError(data) {
    if (!data || Array.isArray(data) || typeof data !== 'object') return '';
    if (!data.rCode && !data.rMessage) return '';
    return [data.rCode, data.rMessage].filter(Boolean).join(': ');
  }

  function firstMatch(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findPairedVendorItemId(text, currentItemId) {
    if (!currentItemId || !text) return '';
    var item = escapeRegExp(currentItemId);
    return firstMatch(text, [
      new RegExp('itemId=' + item + '[^\\s"\'<>]{0,900}vendorItemId=(\\d+)'),
      new RegExp('vendorItemId=(\\d+)[^\\s"\'<>]{0,900}itemId=' + item),
      new RegExp('"itemId"\\s*:\\s*"?' + item + '"?[\\s\\S]{0,1200}?"vendorItemId"\\s*:\\s*"?(\\d+)"?'),
      new RegExp('\\\\"itemId\\\\"\\s*:\\s*\\\\"?' + item + '[\\s\\S]{0,1200}?\\\\"vendorItemId\\\\"\\s*:\\s*\\\\"?(\\d+)')
    ]);
  }

  function resolveIdsFromPage() {
    var hrefs = [location.href || '', productUrl || ''];
    var html = document.documentElement ? document.documentElement.outerHTML || '' : '';
    var decoded = html;
    try { decoded = decodeURIComponent(html); } catch(e) {}
    var entityDecoded = decoded
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'");
    var joined = hrefs.join('\n') + '\n' + html + '\n' + decoded + '\n' + entityDecoded;
    productId = productId || firstMatch(joined, [
      /coupang\.com\/(?:v[pm]\/)?products\/(\d+)/,
      /"productId"\s*:\s*"?(\d+)"?/,
      /\\"productId\\"\s*:\s*\\"?(\d+)/,
      /productId["'=:\s]+(\d+)/
    ]);
    itemId = itemId || firstMatch(joined, [
      /[?&]itemId=(\d+)/,
      /"itemId"\s*:\s*"?(\d+)"?/,
      /\\"itemId\\"\s*:\s*\\"?(\d+)/,
      /itemId["'=:\s]+(\d+)/
    ]);
    vendorItemId = vendorItemId
      || findPairedVendorItemId(joined, itemId)
      || firstMatch(joined, [
        /[?&]vendorItemId=(\d+)/,
        /"vendorItemId"\s*:\s*"?(\d+)"?/,
        /\\"vendorItemId\\"\s*:\s*\\"?(\d+)/,
        /vendorItemId\\?["']?\s*[:=]\s*\\?["']?(\d+)/,
        /vendor[_-]?item[_-]?id["'=:\s-]+(\d+)/i,
        /vendorItemId["'=:\s]+(\d+)/
      ]);
  }

  function getImageUrl() {
    var meta = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (meta && meta.content) return meta.content;
    var img = document.querySelector('img[src*="coupangcdn.com"]');
    return img && img.src ? img.src : '';
  }

  function stripHtml(value) {
    return String(value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  function normalizeDeliveryText(text) {
    if (!text) return '';
    return stripHtml(text)
      .replace(/\s*\([^)]*내 주문 시[^)]*\)\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findDelivery(data) {
    var item = Array.isArray(data) ? data[0] : data;
    if (item && item.delivery && typeof item.delivery === 'object') return item.delivery;
    if (item && (item.descriptions || item.type || item.speedType || item.extraDataMap)) return item;
    return null;
  }

  function extractDeliveryState(data) {
    var delivery = findDelivery(data);
    if (!delivery) return null;
    var text = delivery.extraDataMap && delivery.extraDataMap.decodeDescriptions
      ? delivery.extraDataMap.decodeDescriptions
      : delivery.descriptions;
    return {
      text: normalizeDeliveryText(text),
      type: delivery.type || null,
      speedType: delivery.speedType || null,
      logistics: typeof delivery.logistics === 'boolean' ? delivery.logistics : null
    };
  }

  function sameDeliveryState(a, b) {
    return !!a && !!b &&
      a.text === b.text &&
      a.type === b.type &&
      a.speedType === b.speedType &&
      a.logistics === b.logistics;
  }

  async function fetchQuantityInfo(quantity) {
    var params = new URLSearchParams({
      productId: productId,
      vendorItemId: vendorItemId,
      quantity: String(quantity)
    });
    var origins = [];
    if (location.origin && /coupang\.com$/i.test(location.hostname)) origins.push(location.origin);
    origins.push('https://www.coupang.com');
    origins = origins.filter(function(origin, index, list) { return origin && list.indexOf(origin) === index; });

    var lastError = '';
    for (var i = 0; i < origins.length; i++) {
      try {
        var res = await fetch(origins[i] + '/next-api/products/quantity-info?' + params.toString(), {
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
          }
        });
        if (!res.ok) {
          lastError = 'quantity-info HTTP ' + res.status + ' (' + origins[i] + ')';
          continue;
        }
        return await res.json();
      } catch(e) {
        lastError = e && e.message ? e.message : String(e);
      }
    }
    throw new Error(lastError || 'quantity-info request failed');
  }

  try {
    resolveIdsFromPage();
    if (!productId || !vendorItemId) {
      return { ok: false, error: 'Coupang product identifiers not found' };
    }

    var probeCache = {};
    async function probeState(quantity, waitBefore) {
      quantity = Math.max(1, Math.floor(Number(quantity) || 1));
      var cacheKey = String(quantity);
      if (Object.prototype.hasOwnProperty.call(probeCache, cacheKey)) return probeCache[cacheKey];
      if (waitBefore) await delay(450);
      var state = extractDeliveryState(await fetchQuantityInfo(quantity));
      probeCache[cacheKey] = state;
      return state;
    }

    var baseline = await probeState(1, false);
    if (!baseline) {
      await delay(1500);
      delete probeCache['1'];
      baseline = await probeState(1, false);
    }
    if (!baseline) return { ok: false, error: 'Coupang delivery state not found' };

    var low = 1;
    var high = null;
    var maxQuantity = 50000;

    async function applyProbe(quantity) {
      var state = await probeState(quantity, true);
      if (sameDeliveryState(baseline, state)) {
        low = Math.max(low, quantity);
        return false;
      }
      high = high == null ? quantity : Math.min(high, quantity);
      return true;
    }

    var expected = Number(expectedStock);
    if (Number.isFinite(expected) && expected > 1) {
      expected = Math.min(maxQuantity, Math.max(2, Math.floor(expected)));
      var expectedState = await probeState(expected, true);
      var step = Math.max(2, Math.ceil(expected * 0.1));
      if (sameDeliveryState(baseline, expectedState)) {
        low = expected;
        var up = Math.min(maxQuantity, expected + step);
        while (up > low && high == null) {
          if (await applyProbe(up)) break;
          step *= 2;
          up = Math.min(maxQuantity, low + step);
          if (up === low) break;
        }
      } else {
        high = expected;
        var down = Math.max(1, expected - step);
        while (down > 1) {
          var downState = await probeState(down, true);
          if (sameDeliveryState(baseline, downState)) {
            low = down;
            break;
          }
          high = Math.min(high, down);
          step *= 2;
          down = Math.max(1, expected - step);
        }
      }
    }

    var probes = [100, 1000, 5000];
    if (high == null) {
      for (var i = 0; i < probes.length; i++) {
        var probe = probes[i];
        if (probe <= low) continue;
        if (await applyProbe(probe)) break;
      }
    }

    if (high == null) {
      return {
        ok: true,
        stock: null,
        overLimit: true,
        reason: '5000개 이상 또는 배송 경계 미발견',
        image_url: getImageUrl(),
        productId: productId,
        itemId: itemId,
        vendorItemId: vendorItemId
      };
    }

    while (high - low > 1) {
      var mid = Math.floor((low + high) / 2);
      var midState = await probeState(mid, true);
      if (sameDeliveryState(baseline, midState)) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return {
      ok: true,
      stock: low,
      options: [{ name: '\uC7AC\uACE0 \uCD94\uC815', qty: low }],
      image_url: getImageUrl(),
      productId: productId,
      itemId: itemId,
      vendorItemId: vendorItemId
    };
  } catch(e) {
    return { ok: false, error: e && e.message ? e.message : String(e), image_url: getImageUrl() };
  }
}

function readCoupangProductIdentity(productUrl, fallbackProductId, fallbackItemId, fallbackVendorItemId) {
  function firstMatch(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findPairedVendorItemId(text, currentItemId) {
    if (!currentItemId || !text) return '';
    var item = escapeRegExp(currentItemId);
    return firstMatch(text, [
      new RegExp('itemId=' + item + '[^\\s"\'<>]{0,900}vendorItemId=(\\d{8,})', 'i'),
      new RegExp('vendorItemId=(\\d{8,})[^\\s"\'<>]{0,900}itemId=' + item, 'i'),
      new RegExp('"itemId"\\s*:\\s*"?' + item + '"?[\\s\\S]{0,1200}?"vendorItemId"\\s*:\\s*"?(\\d{8,})"?', 'i'),
      new RegExp('\\\\"itemId\\\\"\\s*:\\s*\\\\"?' + item + '[\\s\\S]{0,1200}?\\\\"vendorItemId\\\\"\\s*:\\s*\\\\"?(\\d{8,})', 'i')
    ]);
  }

  function getImageUrl() {
    var meta = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (meta && meta.content) return meta.content;
    var img = document.querySelector('img[src*="coupangcdn.com"]');
    return img && img.src ? img.src : '';
  }

  var currentUrl = new URL(location.href);
  var productId = fallbackProductId || '';
  var itemId = currentUrl.searchParams.get('itemId') || fallbackItemId || '';
  var vendorItemId = currentUrl.searchParams.get('vendorItemId') || fallbackVendorItemId || '';
  if (!productId) {
    var parts = currentUrl.pathname.split('/').filter(Boolean);
    var productIndex = parts.indexOf('products');
    if (productIndex >= 0) productId = parts[productIndex + 1] || '';
  }

  if (!vendorItemId) {
    var html = document.documentElement ? document.documentElement.outerHTML || '' : '';
    var decoded = html;
    try { decoded = decodeURIComponent(html); } catch(e) {}
    var entityDecoded = decoded
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'");
    var joined = [location.href || '', productUrl || '', html, decoded, entityDecoded].join('\n');
    vendorItemId = findPairedVendorItemId(joined, itemId) || firstMatch(joined, [
      /[?&]vendorItemId=(\d{8,})/i,
      /vendorItemId["'\\]*\s*[:=]\s*["'\\]*(\d{8,})/i,
      /vendorItemId=(\d{8,})/i,
      /\\"vendorItemId\\"\s*:\s*\\"?(\d{8,})/i,
      /vendor[_-]?item[_-]?id["'=:\s-]+(\d{8,})/i
    ]);
    itemId = itemId || firstMatch(joined, [
      /[?&]itemId=(\d{8,})/i,
      /itemId["'\\]*\s*[:=]\s*["'\\]*(\d{8,})/i
    ]);
  }

  return {
    ok: !!productId && !!vendorItemId,
    productId: productId,
    itemId: itemId || '',
    vendorItemId: vendorItemId || '',
    image_url: getImageUrl(),
    url: location.href,
    error: productId
      ? (vendorItemId ? '' : 'vendorItemId not found in URL or product HTML')
      : 'productId not found in product URL'
  };
}

function buildCoupangQuantityInfoUrl(productId, vendorItemId, quantity, itemId, extended) {
  var url = new URL('https://www.coupang.com/next-api/products/quantity-info');
  url.searchParams.set('productId', productId);
  url.searchParams.set('vendorItemId', vendorItemId);
  url.searchParams.set('quantity', String(quantity));
  if (extended) {
    url.searchParams.set('deliveryToggle', 'true');
    url.searchParams.set('landingProductId', productId);
    url.searchParams.set('landingVendorItemId', vendorItemId);
    if (itemId) {
      url.searchParams.set('itemId', itemId);
      url.searchParams.set('landingItemId', itemId);
    }
  }
  return url.toString();
}

function buildCoupangQuantityInfoUrls(productId, vendorItemId, quantity, itemId) {
  var minimal = buildCoupangQuantityInfoUrl(productId, vendorItemId, quantity, itemId, false);
  var extended = buildCoupangQuantityInfoUrl(productId, vendorItemId, quantity, itemId, true);
  return minimal === extended ? [minimal] : [minimal, extended];
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    var done = false;
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    var timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('tab load timeout'));
    }, timeoutMs || 30000);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      if (done) return;
      done = true;
      cleanup();
      resolve();
    }

    function onRemoved(removedTabId) {
      if (removedTabId !== tabId || done) return;
      done = true;
      cleanup();
      reject(new Error('tab closed during load'));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function navigateTabAndWait(tabId, url, timeoutMs) {
  var waiting = waitForTabComplete(tabId, timeoutMs || 30000);
  await chrome.tabs.update(tabId, { url: url });
  await waiting;
}

async function ensureProductTabReady(tabId, productUrl, parsed) {
  try {
    var tab = await chrome.tabs.get(tabId);
    var current = tab && tab.url ? tab.url : '';
    var currentParsed = parseCoupangUrl(current);
    if (!currentParsed || !parsed || currentParsed.pid !== parsed.pid) {
      await navigateTabAndWait(tabId, productUrl, 30000);
    }
  } catch(e) {
    await navigateTabAndWait(tabId, productUrl, 30000);
  }
  await new Promise(r => setTimeout(r, 3000));
}

function stripHtml(input) {
  return String(input || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function stableDeliveryValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stableDeliveryValue);
  if (typeof value === 'object') {
    var out = {};
    Object.keys(value).sort().forEach(function(key) {
      out[key] = stableDeliveryValue(value[key]);
    });
    return out;
  }
  return value;
}

function flattenDeliveryText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return stripHtml(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenDeliveryText).filter(Boolean).join(' | ');
  }
  if (typeof value === 'object') {
    return Object.keys(value).sort().map(function(key) {
      var text = flattenDeliveryText(value[key]);
      return text ? key + ':' + text : '';
    }).filter(Boolean).join(' | ');
  }
  return '';
}

function normalizeDeliveryText(text) {
  if (!text) return null;
  return String(text)
    .replace(/\s*\([^)]*\uB0B4\s*\uC8FC\uBB38\s*\uC2DC[^)]*\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreCoupangDeliveryNode(node) {
  if (!node || typeof node !== 'object') return 0;
  var score = 0;
  if ('descriptions' in node) score += 3;
  if ('type' in node) score += 2;
  if ('speedType' in node) score += 2;
  if ('logistics' in node) score += 1;
  if (node.extraDataMap && 'decodeDescriptions' in node.extraDataMap) score += 4;
  return score;
}

function findCoupangDeliveryNode(data) {
  var seen = new Set();
  var best = null;
  var bestScore = 0;
  function visit(node, depth) {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (node.delivery && typeof node.delivery === 'object') {
      var deliveryScore = scoreCoupangDeliveryNode(node.delivery);
      if (deliveryScore > bestScore) {
        best = node.delivery;
        bestScore = deliveryScore;
      }
    }
    var selfScore = scoreCoupangDeliveryNode(node);
    if (selfScore > bestScore) {
      best = node;
      bestScore = selfScore;
    }
    Object.keys(node).forEach(function(key) {
      visit(node[key], depth + 1);
    });
  }
  visit(data, 0);
  return bestScore >= 3 ? best : null;
}

function extractCoupangDeliveryState(response) {
  var delivery = findCoupangDeliveryNode(response);
  if (!delivery) return null;
  return {
    text: normalizeDeliveryText(
      (delivery.extraDataMap && typeof delivery.extraDataMap.decodeDescriptions === 'string'
        ? delivery.extraDataMap.decodeDescriptions.trim()
        : '') ||
      flattenDeliveryText(delivery.descriptions) ||
      null
    ),
    type: delivery.type == null ? null : delivery.type,
    speedType: delivery.speedType == null ? null : delivery.speedType,
    logistics: delivery.logistics == null ? null : stableDeliveryValue(delivery.logistics)
  };
}

function sameCoupangDeliveryState(a, b) {
  return !!a && !!b &&
    a.text === b.text &&
    a.type === b.type &&
    a.speedType === b.speedType &&
    JSON.stringify(a.logistics) === JSON.stringify(b.logistics);
}

async function readJsonFromCurrentTab(tabId) {
  var res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: function() {
      var pre = document.querySelector('pre');
      if (pre && pre.textContent) return pre.textContent;
      return document.body ? (document.body.innerText || document.body.textContent || '') : '';
    }
  });
  var text = res && res[0] && res[0].result;
  if (!text) throw new Error('quantity-info response is empty');
  try {
    var json = JSON.parse(text);
    if (json && !Array.isArray(json) && typeof json === 'object' && (json.rCode || json.rMessage)) {
      throw new Error('quantity-info API ' + [json.rCode, json.rMessage].filter(Boolean).join(': '));
    }
    return json;
  } catch(e) {
    if (e && /^quantity-info API /.test(e.message || '')) throw e;
    throw new Error('quantity-info JSON parse failed: ' + String(text).slice(0, 160));
  }
}

async function probeCoupangDeliveryByNavigation(tabId, identity, quantity) {
  var urls = buildCoupangQuantityInfoUrls(identity.productId, identity.vendorItemId, quantity, identity.itemId);
  var lastError = '';
  for (var i = 0; i < urls.length; i++) {
    try {
      await navigateTabAndWait(tabId, urls[i], 30000);
      await new Promise(r => setTimeout(r, 500));
      var json = await readJsonFromCurrentTab(tabId);
      var state = extractCoupangDeliveryState(json);
      if (state) return state;
      lastError = 'delivery state not found';
    } catch(e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }
  if (
    quantity > 1 &&
    /(RET9999|HTTP 403|quantity-info API|system error|시스템 오류)/i.test(lastError)
  ) {
    return {
      text: '__COUPANG_QUANTITY_LIMIT__',
      type: 'QUANTITY_LIMIT',
      speedType: 'BLOCKED',
      logistics: false
    };
  }
  throw new Error(
    'quantity=' + quantity +
    ' failed (' + lastError + ', productId=' + identity.productId +
    ', vendorItemId=' + identity.vendorItemId + ')'
  );
}

async function waitForCoupangStock(tabId, comp, parsed) {
  try {
    await ensureProductTabReady(tabId, (comp && comp.url) || '', parsed);

    var res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readCoupangProductIdentity,
      args: [
        (comp && comp.url) || '',
        (parsed && parsed.pid) || '',
        (parsed && parsed.itemId) || '',
        (parsed && parsed.vendorItemId) || ''
      ]
    });
    var identity = res && res[0] && res[0].result;
    if (!identity || !identity.ok) {
      return { ok: false, error: (identity && identity.error) || 'productId or vendorItemId not found' };
    }

    var baseline = await probeCoupangDeliveryByNavigation(tabId, identity, 1);
    var low = 1;
    var high = null;
    var probes = [100, 1000, 5000];

    for (var i = 0; i < probes.length; i++) {
      if (shouldStop()) return { ok: false, stopped: true, error: 'stopped by user' };
      var q = probes[i];
      var state = await probeCoupangDeliveryByNavigation(tabId, identity, q);
      if (sameCoupangDeliveryState(baseline, state)) {
        low = q;
      } else {
        high = q;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (high == null) {
      return {
        ok: true,
        stock: null,
        overLimit: true,
        reason: '5000+ or delivery boundary not found',
        image_url: identity.image_url || '',
        productId: identity.productId,
        itemId: identity.itemId,
        vendorItemId: identity.vendorItemId
      };
    }

    while (high - low > 1) {
      if (shouldStop()) return { ok: false, stopped: true, error: 'stopped by user' };
      var mid = Math.floor((low + high) / 2);
      var midState = await probeCoupangDeliveryByNavigation(tabId, identity, mid);
      if (sameCoupangDeliveryState(baseline, midState)) {
        low = mid;
      } else {
        high = mid;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    return {
      ok: true,
      stock: low,
      options: [{ name: '\uC7AC\uACE0 \uCD94\uC815', qty: low }],
      image_url: identity.image_url || '',
      productId: identity.productId,
      itemId: identity.itemId,
      vendorItemId: identity.vendorItemId
    };
  } catch(e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function collectCoupangStockFromPage(comp, parsed, requestContext) {
  var tabId = null;
  try {
    tabId = await openTab(comp.url, true, {
      popupWindow: true,
      width: 430,
      height: 720,
      left: 0,
      top: 0,
      returnFocusTabId: requestContext && requestContext.dashboardTabId,
      returnFocusWindowId: requestContext && requestContext.dashboardWindowId
    });
    currentFetchTabId = tabId;
    var last = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (shouldStop()) return { ok: false, stopped: true, error: 'stopped by user' };
      if (attempt > 0) await new Promise(r => setTimeout(r, 2500));

      try {
        var direct = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: readCoupangStockEstimate,
          args: [
            comp.url,
            (parsed && parsed.pid) || '',
            (parsed && parsed.itemId) || '',
            (parsed && parsed.vendorItemId) || '',
            comp && comp.expectedStock != null ? comp.expectedStock : null
          ]
        });
        var directResult = direct && direct[0] && direct[0].result;
        if (directResult && (directResult.ok || directResult.stopped)) return directResult;
        if (directResult && directResult.error) last = directResult;
      } catch(e) {
        last = { ok: false, error: e && e.message ? e.message : String(e) };
      }

      last = await waitForCoupangStock(tabId, comp, parsed);
      if (last && (last.ok || last.stopped)) return last;
      var msg = String((last && last.error) || '');
      if (
        msg.indexOf('identifiers not found') >= 0 ||
        msg.indexOf('delivery state not found') >= 0 ||
        msg.indexOf('HTTP 403') >= 0 ||
        msg.indexOf('RET') >= 0
      ) {
        try { await chrome.tabs.reload(tabId); } catch(e) {}
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    return last || { ok: false, error: 'Coupang stock result not found' };
  } catch(e) {
    return { ok: false, error: String(e) };
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId, () => {});
    if (currentFetchTabId === tabId) currentFetchTabId = null;
  }
}

function collectCoupangWingMetricItems(node, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!node || depth > 12) return out;
  if (Array.isArray(node)) {
    node.forEach(function(item) {
      collectCoupangWingMetricItems(item, out, depth + 1);
    });
    return out;
  }
  if (typeof node !== 'object') return out;

  var hasMetric =
    node.pvLast28Day != null ||
    node.salesLast28d != null ||
    node.salePrice != null ||
    node.ratingCount != null ||
    node.vendorItemId != null ||
    node.productName != null;
  if (hasMetric) out.push(node);

  Object.keys(node).forEach(function(key) {
    collectCoupangWingMetricItems(node[key], out, depth + 1);
  });
  return out;
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  var cleaned = String(value).replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  var n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function pickCoupangWingMetricItem(data, parsed, comp) {
  var items = collectCoupangWingMetricItems(data, [], 0);
  if (!items.length) return null;
  var pid = parsed && parsed.pid ? String(parsed.pid) : '';
  var vendorItemId = parsed && parsed.vendorItemId ? String(parsed.vendorItemId) : '';
  var expectedName = String((comp && comp.name) || '').replace(/\s+/g, '');

  function score(item) {
    var text = JSON.stringify(item);
    var value = 0;
    if (pid && String(item.productId || item.productID || item.coupangProductId || '').indexOf(pid) >= 0) value += 200;
    if (pid && text.indexOf(pid) >= 0) value += 120;
    if (vendorItemId && String(item.vendorItemId || '').indexOf(vendorItemId) >= 0) value += 220;
    if (vendorItemId && text.indexOf(vendorItemId) >= 0) value += 120;
    var name = String(item.productName || item.itemName || item.name || '').replace(/\s+/g, '');
    if (expectedName && name && name.indexOf(expectedName.slice(0, Math.min(8, expectedName.length))) >= 0) value += 20;
    if (item.pvLast28Day != null) value += 10;
    if (item.salesLast28d != null) value += 10;
    return value;
  }

  items.sort(function(a, b) { return score(b) - score(a); });
  return items[0] || null;
}

function coupangWingMetricKeywords(comp, parsed) {
  return [
    (parsed && parsed.pid) || '',
    (parsed && parsed.vendorItemId) || '',
    (comp && comp.url) || ''
  ].filter(Boolean).filter(function(value, index, list) {
    return list.indexOf(value) === index;
  });
}

function readCoupangWingPostMatchingInPage(keyword) {
  return fetch('/tenants/seller-web/post-matching/search', {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    body: JSON.stringify({
      keyword: keyword,
      excludedProductIds: [],
      searchPage: 0,
      searchOrder: 'DEFAULT'
    })
  }).then(async function(res) {
    var contentType = res.headers.get('content-type') || '';
    var text = await res.text();
    if (contentType.indexOf('json') < 0) {
      return { ok: false, status: res.status, authRequired: text.indexOf('Sign in to seller') >= 0, error: 'Wing API returned non-JSON response' };
    }
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) };
    } catch(e) {
      return { ok: false, status: res.status, error: 'Wing API JSON parse failed' };
    }
  }).catch(function(e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  });
}

async function fetchCoupangWingPostMatchingMetricsViaExistingTab(comp, parsed) {
  var tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://wing.coupang.com/*' });
  } catch(e) {
    return { ok: false, error: 'Wing tab lookup failed' };
  }
  var tab = (tabs || []).find(function(item) { return item && item.id != null; });
  if (!tab) return { ok: false, authRequired: true, error: 'Wing login tab not found' };

  var keywords = coupangWingMetricKeywords(comp, parsed);
  var lastError = 'Wing post-matching data not found';
  for (var i = 0; i < keywords.length; i++) {
    if (shouldStop()) return { ok: false, stopped: true, error: 'stopped by user' };
    try {
      var injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: readCoupangWingPostMatchingInPage,
        args: [keywords[i]]
      });
      var payload = injected && injected[0] && injected[0].result;
      if (!payload || !payload.ok) {
        lastError = (payload && payload.error) || lastError;
        continue;
      }
      var item = pickCoupangWingMetricItem(payload.data, parsed, comp);
      if (!item) {
        lastError = 'Wing post-matching item not found';
        continue;
      }
      var views = numOrNull(item.pvLast28Day);
      var sales = numOrNull(item.salesLast28d);
      if (views == null && sales == null) {
        lastError = 'Wing post-matching metrics missing';
        continue;
      }
      return {
        ok: true,
        views28: views,
        monthlySales: sales,
        salePrice: numOrNull(item.salePrice),
        ratingCount: numOrNull(item.ratingCount),
        rating: numOrNull(item.rating),
        vendorItemId: item.vendorItemId || '',
        productName: item.productName || '',
        image_url: item.imageUrl || item.productImageUrl || item.thumbnailUrl || ''
      };
    } catch(e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}

async function fetchCoupangWingPostMatchingMetrics(comp, parsed) {
  var keywords = coupangWingMetricKeywords(comp, parsed);
  var lastError = 'Wing post-matching data not found';
  var authRequired = false;

  for (var i = 0; i < keywords.length; i++) {
    if (shouldStop()) return { ok: false, stopped: true, error: 'stopped by user' };
    var keyword = keywords[i];
    try {
      var res = await fetch('https://wing.coupang.com/tenants/seller-web/post-matching/search', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=UTF-8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Origin': 'https://wing.coupang.com',
          'Referer': 'https://wing.coupang.com/tenants/seller-web/vendor-inventory/formV2'
        },
        body: JSON.stringify({
          keyword: keyword,
          excludedProductIds: [],
          searchPage: 0,
          searchOrder: 'DEFAULT'
        })
      });
      if (!res.ok) {
        lastError = 'Wing post-matching HTTP ' + res.status;
        if (res.status === 401 || res.status === 403) break;
        continue;
      }
      var contentType = res.headers.get('content-type') || '';
      var text = await res.text();
      if (contentType.indexOf('json') < 0) {
        authRequired = authRequired || text.indexOf('Sign in to seller') >= 0;
        lastError = authRequired ? 'Wing login session required' : 'Wing post-matching non-JSON response';
        if (authRequired) break;
        continue;
      }
      var data = JSON.parse(text);
      var item = pickCoupangWingMetricItem(data, parsed, comp);
      if (!item) {
        lastError = 'Wing post-matching item not found';
        continue;
      }
      var views = numOrNull(item.pvLast28Day);
      var sales = numOrNull(item.salesLast28d);
      if (views == null && sales == null) {
        lastError = 'Wing post-matching metrics missing';
        continue;
      }
      return {
        ok: true,
        views28: views,
        monthlySales: sales,
        salePrice: numOrNull(item.salePrice),
        ratingCount: numOrNull(item.ratingCount),
        rating: numOrNull(item.rating),
        vendorItemId: item.vendorItemId || '',
        productName: item.productName || '',
        image_url: item.imageUrl || item.productImageUrl || item.thumbnailUrl || ''
      };
    } catch(e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }
  if (authRequired) {
    var tabResult = await fetchCoupangWingPostMatchingMetricsViaExistingTab(comp, parsed);
    if (tabResult && (tabResult.ok || tabResult.stopped)) return tabResult;
    lastError = tabResult && tabResult.error ? tabResult.error : lastError;
  }
  return { ok: false, error: lastError };
}

async function collectCoupangSalesMetricsFromWingApi(comp, parsed, index, total, results) {
  var salesCacheKey = coupangStockCacheKey(parsed) || coupangCacheKey(parsed);
  var monthly = await getCachedCoupangMetric('monthly', salesCacheKey, COUPANG_MONTHLY_TTL);
  var viewsMetric = await getCachedCoupangMetric('views', salesCacheKey, COUPANG_VIEWS_TTL);
  var apiMetrics = null;

  if (!monthly || !viewsMetric) {
    await setStatus({
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '\uCFE0\uD321 \uD310\uB9E4 \uC9C0\uD45C API \uD655\uC778 \uC911...',
      results
    });

    apiMetrics = await fetchCoupangWingPostMatchingMetrics(comp, parsed);
    if (apiMetrics && apiMetrics.stopped) return apiMetrics;
    if (apiMetrics && apiMetrics.ok) {
      if (apiMetrics.monthlySales !== null && apiMetrics.monthlySales !== undefined) {
        monthly = {
          ok: true,
          total: Number(apiMetrics.monthlySales),
          options: [{ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9', qty: Number(apiMetrics.monthlySales) }],
          image_url: apiMetrics.image_url || ''
        };
        await setCachedCoupangMetric('monthly', salesCacheKey, monthly);
      }
      if (apiMetrics.views28 !== null && apiMetrics.views28 !== undefined) {
        viewsMetric = {
          ok: true,
          views28: Number(apiMetrics.views28),
          name: apiMetrics.productName || '',
          image_url: apiMetrics.image_url || ''
        };
        await setCachedCoupangMetric('views', salesCacheKey, viewsMetric);
      }
    }
  }

  if (!monthly && !viewsMetric) {
    return { ok: false, error: (apiMetrics && apiMetrics.error) || 'Coupang sales metrics not found' };
  }

  var views = viewsMetric && viewsMetric.ok ? Number(viewsMetric.views28) || 0 : null;
  var monthlySales = monthly && monthly.ok ? Number(monthly.total) || 0 : null;
  var conversionRate = views && monthlySales !== null ? (monthlySales / views) * 100 : null;
  var options = [];

  if (views !== null) options.push({ name: '\uC870\uD68C\uC218', qty: views });
  else if (apiMetrics && apiMetrics.error) options.push({ name: '\uC870\uD68C\uC218 \uC624\uB958', qty: null, text: apiMetrics.error });
  if (monthlySales !== null) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9', qty: monthlySales });
  else if (apiMetrics && apiMetrics.error) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9 \uC624\uB958', qty: null, text: apiMetrics.error });
  if (conversionRate !== null) options.push({ name: '\uC804\uD658\uC728', qty: Number(conversionRate.toFixed(2)) });

  return {
    ok: true,
    total: monthlySales,
    options: options,
    image_url: (monthly && monthly.image_url) || (viewsMetric && viewsMetric.image_url) || (apiMetrics && apiMetrics.image_url) || ''
  };
}

async function withTimeout(promise, ms, message) {
  var timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ ok: false, error: message }), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectCoupangMonthlySmart(comp, parsed) {
  var direct = await withTimeout(
    fetchCoupangMonthlyDirect(comp, parsed),
    9000,
    'Coupang background monthly lookup timed out'
  );
  if (direct && direct.ok) {
    direct.source = 'direct';
    return direct;
  }

  var server = null;
  if (!(direct && direct.skipServer)) {
    server = await withTimeout(
      fetchCoupangMonthlyFromServer(comp),
      8000,
      'Coupang server monthly lookup timed out'
    );
    if (server && server.ok) {
      server.source = 'server';
      return server;
    }
  }

  var page = await collectCoupangMonthlyFromPage(comp, parsed);
  if (page && page.ok) page.source = 'page';
  if (page && !page.ok) {
    page.error = page.error || (direct && direct.error) || (server && server.error) || 'Coupang monthly sales not found';
  }
  return page;
}

async function waitForCoupangWingViews(tabId, parsed, comp) {
  var keywords = [
    (comp && comp.url) || '',
    (parsed && parsed.pid) || ''
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

async function runFetch(competitors, fetchMode) {
  if (fetchRunning) return;
  fetchRunning = true;
  stopRequested = false;
  currentFetchTabId = null;
  var results = [];
  var stopped = false;
  var normalizedFetchMode = String(fetchMode || '').toLowerCase();
  var coupangFetchMode = normalizedFetchMode === 'coupang_stock' || normalizedFetchMode === 'stock'
    ? 'stock'
    : normalizedFetchMode === 'coupang_sales' || normalizedFetchMode === 'sales'
      ? 'sales'
      : 'stock';

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
        var cacheKey = coupangCacheKey(parsed);
        if (coupangFetchMode === 'sales') {
          cr = await collectCoupangSalesMetricsFromWingApi(comp, parsed, i, competitors.length, results);
        } else {
        var wantsCoupangStock = coupangFetchMode !== 'sales';
        var wantsCoupangSales = coupangFetchMode !== 'stock';
        var pbCache = await getCachedCoupangPb(cacheKey);
        var isPbProduct = !!pbCache || isLikelyCoupangPb(comp);
        if (isPbProduct && !pbCache) {
          await markCoupangPb(cacheKey, 'PB 브랜드 감지: 쿠팡 지표 조회 제외');
        }

        if (coupangFetchMode === 'stock') {
          var stockOnlyKey = coupangStockCacheKey(parsed);
          var stockOnly = await getCachedCoupangMetric('stock', stockOnlyKey, COUPANG_STOCK_TTL);
          if (!stockOnly) {
            await setStatus({
              running: true,
              current: i + 1,
              total: competitors.length,
              name: comp.name,
              msg: '\uCFE0\uD321 \uC8FC\uBB38 \uAC00\uB2A5 \uC7AC\uACE0 \uCD94\uC815 \uC911...',
              results
            });
            stockOnly = await collectCoupangStockFromPage(comp, parsed);
            if (stockOnly && stockOnly.ok && stockOnly.stock != null) await setCachedCoupangMetric('stock', stockOnlyKey, {
              ok: true,
              stock: Number(stockOnly.stock),
              options: [{ name: '\uC7AC\uACE0 \uCD94\uC815', qty: Number(stockOnly.stock) }],
              image_url: stockOnly.image_url || ''
            });
          }

          if (stockOnly && stockOnly.stopped) {
            cr = stockOnly;
          } else if (stockOnly && stockOnly.ok) {
            var stockOnlyValue = stockOnly.stock != null ? Number(stockOnly.stock) : null;
            var stockOnlyOptions = [];
            if (stockOnlyValue !== null && Number.isFinite(stockOnlyValue)) {
              stockOnlyOptions.push({ name: '\uC7AC\uACE0 \uCD94\uC815', qty: stockOnlyValue });
            } else if (stockOnly.overLimit) {
              stockOnlyOptions.push({ name: '\uC7AC\uACE0 \uCD94\uC815 \uC624\uB958', qty: null, text: stockOnly.reason || '5000+ or delivery boundary not found' });
            }
            cr = {
              ok: true,
              total: stockOnlyValue,
              options: stockOnlyOptions,
              image_url: stockOnly.image_url || ''
            };
          } else {
            cr = { ok: false, error: (stockOnly && stockOnly.error) || 'Coupang stock data not found' };
          }
        } else {
        var monthly = null;
        if (!wantsCoupangSales) {
          monthly = { ok: false, skipped: true, error: '' };
        } else if (isPbProduct) {
          monthly = { ok: false, skipped: true, error: 'PB 상품은 월판매수량을 제공하지 않는 경우가 많아 건너뜀' };
        } else {
          monthly = await getCachedCoupangMetric('monthly', cacheKey, COUPANG_MONTHLY_TTL);
          if (!monthly) {
            await setStatus({
              running: true,
              current: i + 1,
              total: competitors.length,
              name: comp.name,
              msg: '\uCFE0\uD321 \uC6D4\uD310\uB9E4\uC218\uB7C9 \uBC31\uADF8\uB77C\uC6B4\uB4DC \uD655\uC778 \uC911...',
              results
            });
            monthly = await collectCoupangMonthlySmart(comp, parsed);
            if (monthly && monthly.ok) await setCachedCoupangMetric('monthly', cacheKey, monthly);
          }
        }
        if (monthly && monthly.stopped) {
          cr = monthly;
        }
        if (shouldStop()) { stopped = true; break; }

        var stock = null;
        if (wantsCoupangStock) {
          var stockKey = coupangStockCacheKey(parsed);
          stock = await getCachedCoupangMetric('stock', stockKey, COUPANG_STOCK_TTL);
          if (!stock) {
            await setStatus({
              running: true,
              current: i + 1,
              total: competitors.length,
              name: comp.name,
              msg: '\uCFE0\uD321 \uC8FC\uBB38 \uAC00\uB2A5 \uC7AC\uACE0 \uCD94\uC815 \uC911...',
              results
            });
            stock = await collectCoupangStockFromPage(comp, parsed);
            if (stock && stock.ok && stock.stock != null) await setCachedCoupangMetric('stock', stockKey, {
              ok: true,
              stock: Number(stock.stock),
              options: [{ name: '\uC7AC\uACE0 \uCD94\uC815', qty: Number(stock.stock) }],
              image_url: stock.image_url || ''
            });
          }
        } else {
          stock = { ok: false, skipped: true, error: '' };
        }
        if (stock && stock.stopped) {
          cr = stock;
        }
        if (shouldStop()) { stopped = true; break; }

        var wing = null;
        if (!wantsCoupangSales) {
          wing = { ok: false, skipped: true, error: '' };
        } else if (isPbProduct) {
          wing = { ok: false, skipped: true, error: 'PB 상품은 Wing 조회수 조회를 건너뜀' };
        } else {
          wing = await getCachedCoupangMetric('views', cacheKey, COUPANG_VIEWS_TTL);
          var viewFailure = wing ? null : await getCachedCoupangViewFailure(cacheKey);
          if (!wing && viewFailure) {
            wing = { ok: false, skipped: true, error: viewFailure.reason || '이전 Wing 매칭 실패로 조회수 재시도 생략' };
          }
          if (!wing) {
            currentFetchTabId = null;
            if (shouldStop()) { stopped = true; break; }

            await setStatus({
              running: true,
              current: i + 1,
              total: competitors.length,
              name: comp.name,
              msg: '\uCFE0\uD321 \uC870\uD68C\uC218 \uD655\uC778 \uC911...',
              results
            });

            wing = await fetchCoupangWingPostMatchingMetrics(comp, parsed);
            if (wing && wing.ok) {
              if (!monthly && wing.monthlySales !== null && wing.monthlySales !== undefined) {
                monthly = {
                  ok: true,
                  total: Number(wing.monthlySales),
                  options: [{ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9', qty: Number(wing.monthlySales) }],
                  image_url: wing.image_url || ''
                };
                await setCachedCoupangMetric('monthly', cacheKey, monthly);
              }
              await setCachedCoupangMetric('views', cacheKey, wing);
              await clearCoupangViewFailure(cacheKey);
            } else if (wing && !wing.stopped) {
              await recordCoupangViewFailure(cacheKey, wing.error || 'Wing 조회수 매칭 실패');
            }
          }
        }
        if (wing && wing.stopped) {
          cr = wing;
        } else if (
          (wantsCoupangSales && ((wing && wing.ok) || (monthly && monthly.ok) || isPbProduct)) ||
          (wantsCoupangStock && stock && stock.ok)
        ) {
          var views = wing && wing.ok ? Number(wing.views28) || 0 : null;
          var monthlySales = monthly && monthly.ok ? Number(monthly.total) || 0 : null;
          var estimatedStock = stock && stock.ok && stock.stock != null ? Number(stock.stock) : null;
          var conversionRate = views && monthlySales !== null ? (monthlySales / views) * 100 : null;
          var options = [];
          if (wantsCoupangStock) {
            if (estimatedStock !== null && Number.isFinite(estimatedStock)) options.push({ name: '\uC7AC\uACE0 \uCD94\uC815', qty: estimatedStock });
            else if (stock && stock.overLimit) options.push({ name: '\uC7AC\uACE0 \uCD94\uC815 \uC624\uB958', qty: null, text: stock.reason || '5000\uAC1C \uC774\uC0C1 \uB610\uB294 \uBC30\uC1A1 \uACBD\uACC4 \uBBF8\uBC1C\uACAC' });
            else if (stock && stock.error) options.push({ name: '\uC7AC\uACE0 \uCD94\uC815 \uC624\uB958', qty: null, text: stock.error });
          }
          if (wantsCoupangSales) {
            if (views !== null) options.push({ name: '\uC870\uD68C\uC218', qty: views });
            else if (wing && wing.error) options.push({ name: '\uC870\uD68C\uC218 \uC624\uB958', qty: null, text: wing.error });
            if (monthlySales !== null) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9', qty: monthlySales });
            else if (monthly && !monthly.ok) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9 \uC624\uB958', qty: null, text: monthly.error || 'Monthly sales unavailable' });
            if (conversionRate !== null) options.push({ name: '\uC804\uD658\uC728', qty: Number(conversionRate.toFixed(2)) });
            else if (views !== null && monthly && !monthly.ok) options.push({ name: '\uC804\uD658\uC728 \uC624\uB958', qty: null, text: '\uC6D4\uD310\uB9E4\uC218\uB7C9\uC774 \uC5C6\uC5B4 \uACC4\uC0B0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4' });
          }
          cr = {
            ok: true,
            total: wantsCoupangStock && !wantsCoupangSales ? estimatedStock : (wantsCoupangSales ? monthlySales : null),
            options: options,
            image_url: (stock && stock.image_url) || (monthly && monthly.image_url) || (wing && wing.image_url) || ''
          };
        } else {
          cr = { ok: false, error: (stock && stock.error) || (monthly && monthly.error) || (wing && wing.error) || 'Coupang data not found' };
        }
        }
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
  if (results.length) {
    try {
      await apiFetch('/api/stock-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results, fetchMode: coupangFetchMode === 'stock' ? 'coupang_stock' : (coupangFetchMode === 'sales' ? 'coupang_sales' : '') })
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

function normalizeSeparatedFetchMode(fetchMode, requestedMarket) {
  var mode = String(fetchMode || '').toLowerCase();
  var market = String(requestedMarket || '').toLowerCase();
  if (mode === 'coupang_stock' || mode === 'stock' || market === 'coupang_stock') return 'coupang_stock';
  if (mode === 'coupang_sales' || mode === 'sales' || market === 'coupang') return 'coupang_sales';
  return '';
}

async function collectCoupangStockMetricOnly(comp, parsed, index, total, results, requestContext) {
  await setStatus({
    running: true,
    current: index + 1,
    total: total,
    name: comp.name,
    msg: '\uCFE0\uD321 \uC7AC\uACE0\uC870\uD68C\uB9CC \uC2E4\uD589 \uC911...',
    results
  });

  var stock = await collectCoupangStockFromPage(comp, parsed, requestContext);
  if (stock && stock.stopped) return stock;
  if (!stock || !stock.ok) {
    return { ok: false, error: (stock && stock.error) || 'Coupang stock data not found' };
  }

  var value = stock.stock != null ? Number(stock.stock) : null;
  var options = [];
  if (value !== null && Number.isFinite(value)) {
    options.push({ name: '\uC7AC\uACE0 \uCD94\uC815', qty: value });
    await setCachedCoupangMetric('stock', coupangStockCacheKey(parsed), {
      ok: true,
      stock: value,
      options: options,
      image_url: stock.image_url || ''
    });
  } else if (stock.overLimit) {
    options.push({
      name: '\uC7AC\uACE0 \uCD94\uC815 \uC624\uB958',
      qty: null,
      text: stock.reason || '5000\uAC1C \uC774\uC0C1 \uB610\uB294 \uBC30\uC1A1 \uACBD\uACC4 \uBBF8\uBC1C\uACAC'
    });
  }

  return {
    ok: true,
    total: value,
    options: options,
    image_url: stock.image_url || ''
  };
}

async function runFetchSeparated(competitors, fetchMode, requestedMarket, requestContext) {
  if (fetchRunning) return;
  fetchRunning = true;
  stopRequested = false;
  currentFetchTabId = null;

  var results = [];
  var stopped = false;
  var route = normalizeSeparatedFetchMode(fetchMode, requestedMarket);

  try {
    for (var i = 0; i < competitors.length; i++) {
      if (shouldStop()) { stopped = true; break; }

      var comp = competitors[i];
      var market = detectMarket(comp.url);

      if (route && market !== 'coupang') {
        results.push({
          id: comp.id,
          name: comp.name,
          error: '\uD604\uC7AC \uCFE0\uD321 \uD0ED \uC870\uD68C\uC5D0\uC11C \uC81C\uC678\uB41C \uC0C1\uD488\uC785\uB2C8\uB2E4'
        });
        continue;
      }

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
        msg: route === 'coupang_stock'
          ? '\uCFE0\uD321 \uC7AC\uACE0\uC870\uD68C \uC911...'
          : route === 'coupang_sales'
            ? '\uCFE0\uD321 \uD310\uB9E4\uC9C0\uD45C \uC870\uD68C \uC911...'
            : '\uC870\uD68C \uC911...',
        results
      });

      if (!parsed) {
        results.push({ id: comp.id, name: comp.name, error: 'URL \uD615\uC2DD \uC624\uB958' });
        continue;
      }

      var tabId = null;
      try {
        var cr = null;
        if (market === 'coupang') {
          if (route === 'coupang_stock') {
            cr = await collectCoupangStockMetricOnly(comp, parsed, i, competitors.length, results, requestContext);
          } else if (route === 'coupang_sales') {
            cr = await collectCoupangSalesMetricsFromWingApi(comp, parsed, i, competitors.length, results);
          } else {
            cr = { ok: false, error: 'Coupang fetch mode missing' };
          }
        } else if (market === 'ohouse') {
          cr = await readOhouseStock(parsed.pid);
        } else {
          tabId = await openTab(comp.url);
          currentFetchTabId = tabId;
          cr = await waitForCache(tabId, parsed.pid, async (msg) => {
            await setStatus({ running: true, current: i + 1, total: competitors.length, name: comp.name, msg, results });
          });
        }

        if (cr && cr.stopped) {
          stopped = true;
          break;
        } else if (cr && cr.ok) {
          results.push({
            id: comp.id,
            name: comp.name,
            total: cr.total,
            options: cr.options || [],
            image_url: cr.image_url || '',
            error: null,
            fetched_at: new Date().toISOString()
          });
        } else {
          results.push({ id: comp.id, name: comp.name, error: (cr && cr.error) || '\uB370\uC774\uD130 \uC5C6\uC74C' });
        }
      } catch(e) {
        results.push({ id: comp.id, name: comp.name, error: e && e.message ? e.message : String(e) });
      } finally {
        if (tabId !== null) chrome.tabs.remove(tabId, () => {});
        if (currentFetchTabId === tabId) currentFetchTabId = null;
      }

      if (shouldStop()) { stopped = true; break; }
      if (i < competitors.length - 1) {
        await new Promise(r => setTimeout(r, market === 'naver' ? 3000 : 900));
      }
    }

    if (results.length) {
      try {
        await apiFetch('/api/stock-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ results: results, fetchMode: route })
        });
      } catch(e) {}
    }

    var okCount = results.filter(r => !r.error).length;
    var errItems = results.filter(r => r.error);
    var msg = stopped
      ? `STOP\uC73C\uB85C \uC911\uB2E8\uB428. \uC800\uC7A5\uB41C \uACB0\uACFC ${okCount}/${results.length} \uC131\uACF5`
      : `\uC870\uD68C \uC644\uB8CC! ${okCount}/${results.length} \uC131\uACF5`;
    if (errItems.length) msg += '\n\uC2E4\uD328: ' + errItems.map(r => r.name + '(' + r.error + ')').join(', ');

    await setStatus({ running: false, done: !stopped, stopped, msg, results });
  } finally {
    fetchRunning = false;
    stopRequested = false;
    currentFetchTabId = null;
  }

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
      runFetchSeparated(competitors, msg.fetchMode || msg.coupangMode || msg.mode || '', msg.market || '', {
        dashboardTabId: sender && sender.tab ? sender.tab.id : null,
        dashboardWindowId: sender && sender.tab ? sender.tab.windowId : null
      });
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
