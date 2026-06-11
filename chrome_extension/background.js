// 백그라운드 서비스 워커 — 팝업이 닫혀도 조회 계속 실행

const DEFAULT_SERVER = 'https://naver-monitor-production.up.railway.app';
const COUPANG_CACHE_KEY = 'coupangMetricCacheV3';
const MIN_COUPANG_HELPER_VERSION = '1.5.0';
const COUPANG_MONTHLY_TTL = 12 * 60 * 60 * 1000;
const COUPANG_VIEWS_TTL = 24 * 60 * 60 * 1000;
const COUPANG_STOCK_TTL = 3 * 60 * 60 * 1000;
const COUPANG_HELPER_SKIP_TTL = 24 * 60 * 60 * 1000;
const COUPANG_PB_TTL = 30 * 24 * 60 * 60 * 1000;
const COUPANG_VIEW_FAILURE_TTL = 7 * 24 * 60 * 60 * 1000;
const COUPANG_PB_BRANDS = ['코멧', '곰곰', '탐사', '비타할로', '홈플래닛', '캐럿', '베이스알파', '줌베이직', '줌 베이직'];
var stopRequested = false;
var currentFetchTabId = null;
var fetchRunning = false;
var fetchStarting = false; // START_FETCH 수신~runFetchSeparated 진입 사이 이중 시작 방지
// 워커가 죽으면 fetchStatus.running이 영원히 남는다 — updatedAt 기준으로 stale 판정
const FETCH_STATUS_STALE_MS = 3 * 60 * 1000;
const FETCH_KEEPALIVE_INTERVAL_MS = 20 * 1000;
const COUPANG_LOCAL_HELPER_FAILURE_LIMIT = 2;
const COUPANG_STOCK_BLOCK_RULE_BASE = 720000;
const AUTO_FETCH_ALARM = 'naverMonitorAutoFetch';
const AUTO_FETCH_SYNC_ALARM = 'naverMonitorAutoFetchSync';
const AUTO_FETCH_AUTH_WAIT_MS = 10 * 60 * 1000;

function normalizeServerUrl(url) {
  var value = (url || DEFAULT_SERVER).replace(/\/$/, '');
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
    if (state.refreshToken) {
      var refreshed = await refreshServiceToken(state);
      if (refreshed) return refreshed;
    }
    if (state.accessToken) return state.accessToken;
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

async function postFetchLog(log) {
  try {
    await apiFetch('/api/fetch-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log || {})
    });
  } catch(e) {}
}

var PENDING_STOCK_SAVES_KEY = 'pendingStockSaves';

async function postStockResults(results, fetchMode) {
  var res = await apiFetch('/api/stock-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results: results, fetchMode: fetchMode || '' })
  });
  if (!res.ok) throw new Error('서버 응답 ' + res.status);
}

// 수집 결과 저장 실패 시 버리지 않고 재시도 → 최종 실패하면 로컬에 보관
async function saveStockResultsWithRetry(results, fetchMode) {
  var delays = [0, 2000, 5000];
  var lastError = '';
  for (var i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(function(r) { setTimeout(r, delays[i]); });
    try {
      await postStockResults(results, fetchMode);
      return '';
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    }
  }
  try {
    var data = await chrome.storage.local.get(PENDING_STOCK_SAVES_KEY);
    var pending = Array.isArray(data[PENDING_STOCK_SAVES_KEY]) ? data[PENDING_STOCK_SAVES_KEY] : [];
    pending.push({ savedAt: Date.now(), fetchMode: fetchMode || '', results: results });
    if (pending.length > 10) pending = pending.slice(-10);
    var update = {};
    update[PENDING_STOCK_SAVES_KEY] = pending;
    await chrome.storage.local.set(update);
  } catch (e) {}
  return lastError || '알 수 없는 오류';
}

// 이전에 저장 실패해 보관해 둔 결과를 재전송
async function flushPendingStockSaves() {
  try {
    var data = await chrome.storage.local.get(PENDING_STOCK_SAVES_KEY);
    var pending = Array.isArray(data[PENDING_STOCK_SAVES_KEY]) ? data[PENDING_STOCK_SAVES_KEY] : [];
    if (!pending.length) return;
    var remaining = [];
    for (var i = 0; i < pending.length; i++) {
      try {
        await postStockResults(pending[i].results, pending[i].fetchMode);
      } catch (e) {
        remaining.push(pending[i]);
      }
    }
    var update = {};
    update[PENDING_STOCK_SAVES_KEY] = remaining;
    await chrome.storage.local.set(update);
  } catch (e) {}
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

function naverMobileUrl(url) {
  try {
    var u = new URL(url);
    if (u.hostname === 'smartstore.naver.com') u.hostname = 'm.smartstore.naver.com';
    if (u.hostname === 'brand.naver.com') u.hostname = 'm.brand.naver.com';
    return u.toString();
  } catch(e) {
    return url;
  }
}

function nextDailyScheduleTime(hour, minute) {
  var now = new Date();
  var next = new Date(now);
  next.setHours(Number(hour) || 0, Number(minute) || 0, 0, 0);
  if (next.getTime() <= now.getTime() + 30000) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function notifyUser(title, message) {
  try {
    await chrome.notifications.create('', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message
    });
  } catch(e) {}
}

async function applyAutoFetchSchedule(schedule) {
  schedule = schedule || {};
  await chrome.storage.local.set({ autoFetchSchedule: schedule });
  try { await chrome.alarms.clear(AUTO_FETCH_ALARM); } catch(e) {}
  if (!schedule.enabled) return;
  var hour = Math.max(0, Math.min(23, Number(schedule.hour) || 0));
  var minute = Math.max(0, Math.min(59, Number(schedule.minute) || 0));
  await chrome.alarms.create(AUTO_FETCH_ALARM, {
    when: nextDailyScheduleTime(hour, minute),
    periodInMinutes: 24 * 60
  });
}

async function syncAutoFetchScheduleFromServer() {
  try {
    var res = await apiFetch('/api/config');
    if (!res.ok) return;
    var data = await res.json();
    await applyAutoFetchSchedule(data.schedule || {});
  } catch(e) {}
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

function versionAtLeast(version, required) {
  var a = String(version || '').split('.').map(function(part) { return parseInt(part, 10) || 0; });
  var b = String(required || '').split('.').map(function(part) { return parseInt(part, 10) || 0; });
  var len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
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

// 헬퍼로 조회 불가가 확인된 상품(일반배송/품절 등)은 24시간 동안 헬퍼를 건너뛴다
// — 매 조회마다 10초씩 헬퍼 실패를 기다리는 낭비 방지
async function markCoupangHelperSkip(key, reason) {
  if (!key) return;
  var cache = await getCoupangCache();
  cache.helperSkip = cache.helperSkip || {};
  cache.helperSkip[key] = { ts: Date.now(), reason: reason || '' };
  await saveCoupangCache(cache);
}

async function getCoupangHelperSkip(key) {
  if (!key) return null;
  var cache = await getCoupangCache();
  var entry = cache.helperSkip && cache.helperSkip[key];
  return isFreshCache(entry, COUPANG_HELPER_SKIP_TTL) ? entry : null;
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
  if (status && typeof status === 'object') status.updatedAt = Date.now();
  await chrome.storage.local.set({ fetchStatus: status });
}

// 워커 재시작 시 남아있는 running 상태 정리 (조회는 이미 죽었는데 UI만 "조회 중"으로 남는 문제)
async function cleanupStaleFetchStatus() {
  try {
    if (fetchRunning || fetchStarting) return;
    var data = await chrome.storage.local.get('fetchStatus');
    var s = data && data.fetchStatus;
    if (!s || !s.running) return;
    var age = Date.now() - (Number(s.updatedAt) || 0);
    if (!s.updatedAt || age > FETCH_STATUS_STALE_MS) {
      await setStatus({
        running: false,
        done: false,
        stopped: true,
        msg: '이전 조회가 중단된 상태로 발견되어 정리했습니다 (브라우저/확장 재시작). 다시 조회해주세요.',
        results: (s && s.results) || []
      });
    }
  } catch (e) {}
}

async function reportFetchStatus(requestContext, status, detail) {
  if (requestContext && typeof requestContext.statusLogger === 'function') {
    return requestContext.statusLogger(status, detail || {});
  }
  return setStatus(status);
}

function shouldStop() {
  return !!stopRequested;
}

async function stopCurrentFetch() {
  if (!fetchRunning) {
    // 진행 중 조회 없음 — 잔여 상태만 정리
    await setStatus({
      running: false,
      stopped: true,
      msg: 'STOP 요청으로 조회를 중지했습니다.',
      results: []
    });
    return;
  }
  // 최종 stopped 상태는 조회 루프의 종료 경로에서 한 번만 기록한다.
  // (여기서 먼저 기록하면 진행 중 루프가 running 상태로 다시 덮어써 UI가 되돌아감)
  stopRequested = true;
  if (currentFetchTabId !== null) {
    try {
      await chrome.tabs.remove(currentFetchTabId);
    } catch(e) {}
    currentFetchTabId = null;
  }
}

async function runScheduledAutoFetch() {
  if (fetchRunning) {
    await setStatus({
      running: false,
      done: false,
      stopped: false,
      msg: '자동조회 시간이 되었지만 이전 조회가 아직 진행 중입니다.',
      results: []
    });
    return;
  }
  try {
    var scheduleData = await chrome.storage.local.get('autoFetchSchedule');
    var schedule = scheduleData.autoFetchSchedule || {};
    var selectedMarkets = Array.isArray(schedule.markets) && schedule.markets.length
      ? schedule.markets
      : ['naver', 'ohouse', 'coupang_stock'];
    function marketEnabled(name) {
      return selectedMarkets.indexOf(name) >= 0;
    }
    var token = await ensureServiceToken(5000);
    if (!token) {
      await notifyUser('네이버 모니터링 자동조회', '서비스 로그인이 필요해서 자동조회를 시작하지 못했습니다.');
      await setStatus({ running: false, done: false, msg: '자동조회 실패: 서비스 로그인이 필요합니다.', results: [] });
      return;
    }
    var res = await apiFetch('/api/public/competitors');
    if (!res.ok) throw new Error('competitors HTTP ' + res.status);
    var data = await res.json();
    var competitors = data.competitors || [];
    if (!competitors.length) {
      await setStatus({ running: false, done: true, msg: '자동조회: 조회할 상품이 없습니다.', results: [] });
      return;
    }
    await notifyUser('네이버 모니터링 자동조회', competitors.length + '개 상품 자동조회를 시작합니다.');
    var naver = marketEnabled('naver') ? competitors.filter(function(comp) { return detectMarket(comp && comp.url) === 'naver'; }) : [];
    var ohouse = marketEnabled('ohouse') ? competitors.filter(function(comp) { return detectMarket(comp && comp.url) === 'ohouse'; }) : [];
    var coupang = marketEnabled('coupang_stock') ? competitors.filter(function(comp) { return detectMarket(comp && comp.url) === 'coupang'; }) : [];
    if (naver.length) {
      await setStatus({ running: true, current: 0, total: naver.length, msg: 'Auto fetch: Naver start', results: [] });
      await runFetchSeparated(naver, '', 'naver', { scheduled: true, schedulePhase: 'naver' });
    }
    if (ohouse.length) {
      await setStatus({ running: true, current: 0, total: ohouse.length, msg: 'Auto fetch: Ohouse start', results: [] });
      await runFetchSeparated(ohouse, '', 'ohouse', { scheduled: true, schedulePhase: 'ohouse' });
    }
    if (coupang.length) {
      await notifyUser('쿠팡 재고조회 자동조회', '판매가는 현재 크롬의 쿠팡 로그인/와우/쿠폰 세션 기준으로 저장됩니다.');
      await setStatus({ running: true, current: 0, total: coupang.length, msg: '쿠팡 재고조회 시작: 판매가는 크롬 쿠팡 로그인 세션 기준입니다.', results: [] });
      await runFetchSeparated(coupang, 'coupang_stock', 'coupang_stock', { scheduled: true, schedulePhase: 'coupang_stock' });
    }
  } catch(e) {
    var message = e && e.message ? e.message : String(e);
    await notifyUser('네이버 모니터링 자동조회 실패', message.slice(0, 120));
    await setStatus({ running: false, done: false, msg: '자동조회 실패: ' + message, results: [] });
  }
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function coupangStockBlockRuleId(tabId) {
  return COUPANG_STOCK_BLOCK_RULE_BASE + Number(tabId || 0);
}

async function updateDnrSessionRules(payload) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return false;
  return new Promise(resolve => {
    chrome.declarativeNetRequest.updateSessionRules(payload, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

async function enableCoupangStockLightMode(tabId) {
  var ruleId = coupangStockBlockRuleId(tabId);
  await updateDnrSessionRules({ removeRuleIds: [ruleId] });
  return updateDnrSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: { type: 'block' },
      condition: {
        tabIds: [tabId],
        urlFilter: 'http',
        resourceTypes: ['image', 'media', 'font', 'stylesheet']
      }
    }]
  });
}

async function disableCoupangStockLightMode(tabId) {
  if (tabId == null) return;
  await updateDnrSessionRules({ removeRuleIds: [coupangStockBlockRuleId(tabId)] });
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
      // 타임아웃으로 실패해도 이미 만들어진 탭은 닫는다 (탭 누수 방지)
      if (tid !== null) chrome.tabs.remove(tid, () => { void chrome.runtime.lastError; });
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

async function openPopupTabQuick(url, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    chrome.windows.create({
      url: options.lightMode ? 'about:blank' : url,
      type: 'popup',
      focused: true,
      width: options.width || 430,
      height: options.height || 720,
      left: options.left == null ? 0 : options.left,
      top: options.top == null ? 0 : options.top
    }, async (win) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      var tab = win && win.tabs && win.tabs[0];
      if (!tab || tab.id == null) {
        reject(new Error('tab create failed'));
        return;
      }
      currentFetchTabId = tab.id;
      try {
        if (options.lightMode) {
          await enableCoupangStockLightMode(tab.id);
          await chrome.tabs.update(tab.id, { url: url });
        }
      } catch(e) {}
      scheduleFocusSourceTab(options, options.focusBackDelayMs || 650);
      resolve(tab.id);
    });
  });
}

async function waitForTabScriptReady(tabId, timeoutMs) {
  var start = Date.now();
  var lastError = '';
  while (Date.now() - start < (timeoutMs || 7000)) {
    if (shouldStop()) throw new Error('stopped by user');
    try {
      var res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: function() {
          return {
            href: location.href || '',
            readyState: document.readyState || '',
            htmlLength: document.documentElement ? (document.documentElement.outerHTML || '').length : 0
          };
        }
      });
      var info = res && res[0] && res[0].result;
      var href = info && info.href ? String(info.href) : '';
      if (/coupang\.com\/.*\/products\//i.test(href) && info) {
        return info;
      }
      lastError = href || 'waiting for coupang page';
    } catch(e) {
      lastError = e && e.message ? e.message : String(e);
    }
    await delay(250);
  }
  throw new Error('Coupang page script readiness timeout: ' + lastError);
}

async function waitForCache(tabId, pid, onStatus, opts) {
  opts = opts || {};
  var elapsed = 0;
  var verifying = false;
  var maxWait = 120000;
  var authWaitStartedAt = 0;
  var nonProductSinceMs = 0;

  while (elapsed < maxWait) {
    if (shouldStop()) return { ok: false, stopped: true, error: '사용자 중지' };
    var tab;
    try { tab = await chrome.tabs.get(tabId); } catch(e) {
      return { ok: false, error: '탭이 닫힘' };
    }
    var currentUrl = tab.url || '';

    var state = null;
    try {
      var pageState = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: function() {
          var text = document.body ? (document.body.innerText || '') : '';
          return {
            href: location.href || '',
            serviceUnavailable:
              text.indexOf('현재 서비스 접속이 불가합니다') >= 0 ||
              text.indexOf('동시에 접속하는 이용자 수가 많거나') >= 0 ||
              text.indexOf('잠시 후 다시 접속해') >= 0,
            authLike:
              text.indexOf('전화번호') >= 0 ||
              text.indexOf('본인확인') >= 0 ||
              text.indexOf('인증') >= 0
          };
        }
      });
      state = pageState && pageState[0] && pageState[0].result;
      if (state && state.serviceUnavailable) {
        return { ok: false, retryDesktop: true, skipSave: true, error: '네이버 모바일 접속 불가' };
      }
    } catch(e) {}

    if (!currentUrl.includes('/products/')) {
      // 실제 인증 페이지인지 판별 — 상품 삭제로 404/메인 리다이렉트된 경우까지
      // 인증 대기로 오인해 최대 10분 멈추던 문제 방지
      var authLike = /nid\.naver\.com|captcha|login|auth|verify/i.test(currentUrl) || !!(state && state.authLike);
      if (!authLike && !verifying) {
        if (!nonProductSinceMs) nonProductSinceMs = Date.now();
        if (Date.now() - nonProductSinceMs > 15000) {
          return { ok: false, error: '상품 페이지가 아닙니다 (삭제되었거나 다른 페이지로 이동됨)' };
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      nonProductSinceMs = 0;
      if (!verifying) {
        verifying = true;
        authWaitStartedAt = Date.now();
        // 자동조회(무인) 중에는 사용자 포커스를 빼앗지 않는다
        if (!opts.scheduled) chrome.tabs.update(tabId, { active: true });
        if (onStatus) onStatus('⚠️ 인증 필요 — 전화번호 입력 후 자동 재개');
        await notifyUser('네이버 모니터링 인증 필요', '열린 네이버 탭에서 전화번호 인증을 완료하면 조회가 이어집니다.');
      } else if (authWaitStartedAt && Date.now() - authWaitStartedAt > AUTO_FETCH_AUTH_WAIT_MS) {
        return { ok: false, skipSave: true, error: '네이버 인증 필요 - 대기 시간 초과' };
      }
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    nonProductSinceMs = 0;

    if (verifying) {
      verifying = false;
      authWaitStartedAt = 0;
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
    if (shouldStop()) return { ok: false, stopped: true, error: '사용자 중지' };
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

  function numOrNull(value) {
    if (value == null || value === '') return null;
    var cleaned = String(value).replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    var n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function getProductMetrics() {
    var html = document.documentElement ? document.documentElement.outerHTML || '' : '';
    var text = document.body ? document.body.innerText || '' : '';
    function visibleSalePriceFromTextSafe(value) {
      var lines = String(value || '').split(/\n+/).map(function(line) { return line.trim(); }).filter(Boolean);
      var end = lines.findIndex(function(line) {
        return /\uBC30\uC1A1|\uD310\uB9E4\uC790|\uC218\uB7C9|\uC7A5\uBC14\uAD6C\uB2C8|\uBC14\uB85C\uAD6C\uB9E4/.test(line);
      });
      var main = lines.slice(0, end > 0 ? end : Math.min(lines.length, 80));
      var prices = [];
      for (var i = 0; i < main.length; i++) {
        if (/1\s*\uAC1C\uB2F9|\uCE90\uC2DC|\uC801\uB9BD|\uBC30\uC1A1/.test(main[i])) continue;
        var matches = main[i].match(/[0-9][0-9,]{3,}\s*\uC6D0/g) || [];
        for (var j = 0; j < matches.length; j++) {
          var n = numOrNull(matches[j]);
          if (n !== null) prices.push(n);
        }
      }
      return prices.length ? prices[0] : null;
    }
    function firstTextFromSelectors(selectors) {
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el && el.textContent) return el.textContent;
      }
      return '';
    }
    var visibleTextPrice = visibleSalePriceFromTextSafe(text);
    var visibleFinalPrice = firstTextFromSelectors([
      '.prod-coupon-price .total-price strong',
      '.prod-coupon-price .total-price',
      '.prod-sale-price .total-price strong',
      '.prod-sale-price .total-price',
      '.total-price strong',
      '.total-price',
      '[class*="coupon"][class*="price"]',
      '[class*="sale"][class*="price"]'
    ]);
    var salePrice = numOrNull(
      (visibleTextPrice !== null ? visibleTextPrice : '') ||
      visibleFinalPrice ||
      firstMatch(html, [
        /"finalPrice"\s*:\s*"?([0-9,]+)"?/i,
        /"couponPrice"\s*:\s*"?([0-9,]+)"?/i,
        /"discount(?:ed)?Price"\s*:\s*"?([0-9,]+)"?/i,
        /"salePrice"\s*:\s*"?([0-9,]+)"?/i,
        /"price"\s*:\s*"?([0-9,]{4,})"?/i
      ]) ||
      firstMatch(text, [
        /([0-9,]{4,})\s*원\s*\([^)]*1\s*개당/i,
        /[0-9]+\s*%\s*[0-9,]{4,}\s*원[\s\S]{0,120}?([0-9,]{4,})\s*원/i,
        /([0-9,]{4,})\s*원/
      ])
    );
    var ratingCount = numOrNull(
      firstMatch(html, [
        /"ratingCount"\s*:\s*"?([0-9,]+)"?/i,
        /"reviewCount"\s*:\s*"?([0-9,]+)"?/i
      ]) || firstMatch(text, [/상품평\s*([0-9,]+)\s*개/, /리뷰\s*([0-9,]+)\s*개/])
    );
    return { salePrice: salePrice, ratingCount: ratingCount };
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
      if (waitBefore) await delay(220);
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
        var up = Math.min(maxQuantity, expected + 1);
        if (up > low) await applyProbe(up);
        up = high == null ? Math.min(maxQuantity, expected + step) : low;
        while (up > low && high == null) {
          if (await applyProbe(up)) break;
          step *= 2;
          up = Math.min(maxQuantity, low + step);
          if (up === low) break;
        }
      } else {
        high = expected;
        var nearDown = expected - 1;
        if (nearDown > 1) {
          var nearDownState = await probeState(nearDown, true);
          if (sameDeliveryState(baseline, nearDownState)) {
            low = nearDown;
          } else {
            high = Math.min(high, nearDown);
          }
        }
        var down = Math.max(1, expected - step);
        while (down > 1 && low === 1) {
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
      var overLimitMetrics = getProductMetrics();
      return {
        ok: true,
        stock: null,
        overLimit: true,
        reason: '5000개 이상 또는 배송 경계 미발견',
        image_url: getImageUrl(),
        productId: productId,
        itemId: itemId,
        vendorItemId: vendorItemId,
        salePrice: overLimitMetrics.salePrice,
        ratingCount: overLimitMetrics.ratingCount
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

    var metrics = getProductMetrics();
    return {
      ok: true,
      stock: low,
      options: [{ name: '\uC7AC\uACE0 \uCD94\uC815', qty: low }],
      image_url: getImageUrl(),
      productId: productId,
      itemId: itemId,
      vendorItemId: vendorItemId,
      salePrice: metrics.salePrice,
      ratingCount: metrics.ratingCount
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

  function numOrNull(value) {
    if (value == null || value === '') return null;
    var cleaned = String(value).replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    var n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function getProductMetrics() {
    var html = document.documentElement ? document.documentElement.outerHTML || '' : '';
    var text = document.body ? document.body.innerText || '' : '';
    function visibleSalePriceFromTextSafe(value) {
      var lines = String(value || '').split(/\n+/).map(function(line) { return line.trim(); }).filter(Boolean);
      var end = lines.findIndex(function(line) {
        return /\uBC30\uC1A1|\uD310\uB9E4\uC790|\uC218\uB7C9|\uC7A5\uBC14\uAD6C\uB2C8|\uBC14\uB85C\uAD6C\uB9E4/.test(line);
      });
      var main = lines.slice(0, end > 0 ? end : Math.min(lines.length, 80));
      var prices = [];
      for (var i = 0; i < main.length; i++) {
        if (/1\s*\uAC1C\uB2F9|\uCE90\uC2DC|\uC801\uB9BD|\uBC30\uC1A1/.test(main[i])) continue;
        var matches = main[i].match(/[0-9][0-9,]{3,}\s*\uC6D0/g) || [];
        for (var j = 0; j < matches.length; j++) {
          var n = numOrNull(matches[j]);
          if (n !== null) prices.push(n);
        }
      }
      return prices.length ? prices[0] : null;
    }
    function firstTextFromSelectors(selectors) {
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el && el.textContent) return el.textContent;
      }
      return '';
    }
    var visibleFinalPrice = firstTextFromSelectors([
      '.prod-coupon-price .total-price strong',
      '.prod-coupon-price .total-price',
      '.prod-sale-price .total-price strong',
      '.prod-sale-price .total-price',
      '.total-price strong',
      '.total-price',
      '[class*="coupon"][class*="price"]',
      '[class*="sale"][class*="price"]'
    ]);
    var visibleTextPrice = visibleSalePriceFromTextSafe(text);
    var salePrice = numOrNull(
      (visibleTextPrice !== null ? visibleTextPrice : '') ||
      visibleFinalPrice ||
      firstMatch(html, [
        /"finalPrice"\s*:\s*"?([0-9,]+)"?/i,
        /"couponPrice"\s*:\s*"?([0-9,]+)"?/i,
        /"discount(?:ed)?Price"\s*:\s*"?([0-9,]+)"?/i,
        /"salePrice"\s*:\s*"?([0-9,]+)"?/i,
        /"price"\s*:\s*"?([0-9,]{4,})"?/i
      ]) ||
      firstMatch(text, [
        /([0-9,]{4,})\s*원\s*\([^)]*1\s*개당/i,
        /[0-9]+\s*%\s*[0-9,]{4,}\s*원[\s\S]{0,120}?([0-9,]{4,})\s*원/i,
        /([0-9,]{4,})\s*원/
      ])
    );
    var ratingCount = numOrNull(
      firstMatch(html, [
        /"ratingCount"\s*:\s*"?([0-9,]+)"?/i,
        /"reviewCount"\s*:\s*"?([0-9,]+)"?/i
      ]) || firstMatch(text, [/상품평\s*([0-9,]+)\s*개/, /리뷰\s*([0-9,]+)\s*개/])
    );
    return { salePrice: salePrice, ratingCount: ratingCount };
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

  var metrics = getProductMetrics();
  return {
    ok: !!productId && !!vendorItemId,
    productId: productId,
    itemId: itemId || '',
    vendorItemId: vendorItemId || '',
    image_url: getImageUrl(),
    salePrice: metrics.salePrice,
    ratingCount: metrics.ratingCount,
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

function buildCoupangQuantityInfoBackgroundUrl(productId, vendorItemId, quantity) {
  var url = new URL('https://www.coupang.com/next-api/products/quantity-info');
  url.searchParams.set('productId', String(productId || ''));
  url.searchParams.set('vendorItemId', String(vendorItemId || ''));
  url.searchParams.set('quantity', String(quantity || 1));
  return url.toString();
}

function coupangDeepValue(node, path) {
  var current = node;
  for (var i = 0; i < path.length; i++) {
    if (current == null) return null;
    current = current[path[i]];
  }
  return current == null ? null : current;
}

function normalizeCoupangUnitPrice(value, quantity) {
  var n = numOrNull(value);
  if (n === null) return null;
  var q = Math.max(1, Math.floor(Number(quantity) || 1));
  if (q > 1 && n > 1000000 && n % q === 0) return n / q;
  return n;
}

function extractCoupangPriceFromQuantityInfo(data, quantity) {
  var item = Array.isArray(data) ? data[0] : data;
  if (!item || typeof item !== 'object') return null;
  var candidates = [
    ['price', 'finalPrice'],
    ['price', 'couponPrice'],
    ['price', 'salePrice'],
    ['moduleData', 0, 'detailPriceBundle', 'finalPrice', 'price'],
    ['moduleData', 0, 'detailPriceBundle', 'finalPrice', 'displayPrice'],
    ['moduleData', 3, 'priceInfo', 'finalPrice', 'price'],
    ['moduleData', 3, 'priceInfo', 'finalPrice', 'displayPrice'],
    ['priceList', 1, 'priceAmount'],
    ['priceList', 0, 'priceAmount']
  ];
  for (var i = 0; i < candidates.length; i++) {
    var price = normalizeCoupangUnitPrice(coupangDeepValue(item, candidates[i]), quantity);
    if (price !== null && price > 0 && price < 10000000) return price;
  }
  return null;
}

async function fetchCoupangQuantityInfoBackground(productId, vendorItemId, quantity, productUrl) {
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = controller ? setTimeout(function() { controller.abort(); }, 2500) : null;
  try {
    var res = await fetch(buildCoupangQuantityInfoBackgroundUrl(productId, vendorItemId, quantity), {
      credentials: 'include',
      cache: 'no-store',
      referrer: productUrl || 'https://www.coupang.com/',
      referrerPolicy: 'strict-origin-when-cross-origin',
      signal: controller ? controller.signal : undefined,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    if (!res.ok) throw new Error('background quantity-info HTTP ' + res.status);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function estimateCoupangStockInBackground(comp, parsed) {
  if (!parsed || !parsed.pid || !parsed.vendorItemId) {
    return { ok: false, error: 'background direct requires vendorItemId' };
  }

  var productId = parsed.pid;
  var vendorItemId = parsed.vendorItemId;
  var productUrl = (comp && comp.url) || '';
  var probeCache = {};

  async function probeState(quantity, waitBefore) {
    quantity = Math.max(1, Math.floor(Number(quantity) || 1));
    var cacheKey = String(quantity);
    if (Object.prototype.hasOwnProperty.call(probeCache, cacheKey)) return probeCache[cacheKey].state;
    if (waitBefore) await delay(120);
    var data = await fetchCoupangQuantityInfoBackground(productId, vendorItemId, quantity, productUrl);
    var state = extractCoupangDeliveryState(data);
    probeCache[cacheKey] = { state: state, data: data };
    return state;
  }

  try {
    var baseline = await probeState(1, false);
    if (!baseline) return { ok: false, error: 'background delivery state not found' };
    var baselineData = probeCache['1'] && probeCache['1'].data ? probeCache['1'].data : null;
    var salePrice = baselineData ? extractCoupangPriceFromQuantityInfo(baselineData, 1) : null;

    var low = 1;
    var high = null;
    var maxQuantity = 50000;

    async function applyProbe(quantity) {
      var state = await probeState(quantity, true);
      if (sameCoupangDeliveryState(baseline, state)) {
        low = Math.max(low, quantity);
        return false;
      }
      high = high == null ? quantity : Math.min(high, quantity);
      return true;
    }

    var expected = Number(comp && comp.expectedStock);
    if (Number.isFinite(expected) && expected > 1) {
      expected = Math.min(maxQuantity, Math.max(2, Math.floor(expected)));
      var expectedState = await probeState(expected, true);
      if (sameCoupangDeliveryState(baseline, expectedState)) {
        low = expected;
        var next = Math.min(maxQuantity, expected + 1);
        if (next > low) await applyProbe(next);
      } else {
        high = expected;
        var prev = expected - 1;
        if (prev > 1) {
          var prevState = await probeState(prev, true);
          if (sameCoupangDeliveryState(baseline, prevState)) low = prev;
          else high = Math.min(high, prev);
        }
      }
    }

    var probes = [100, 1000, 5000];
    if (high == null) {
      for (var i = 0; i < probes.length; i++) {
        var q = probes[i];
        if (q <= low) continue;
        if (await applyProbe(q)) break;
      }
    }

    if (high == null) {
      return {
        ok: true,
        stock: null,
        overLimit: true,
        reason: '5000+ or delivery boundary not found',
        image_url: '',
        productId: productId,
        vendorItemId: vendorItemId,
        salePrice: salePrice,
        priceSource: salePrice !== null ? 'quantity-info:1' : '',
        backgroundDirect: true
      };
    }

    while (high - low > 1) {
      var mid = Math.floor((low + high) / 2);
      var midState = await probeState(mid, true);
      if (sameCoupangDeliveryState(baseline, midState)) low = mid;
      else high = mid;
    }

    return {
      ok: true,
      stock: low,
      options: [{ name: '\uC7AC\uACE0 \uCD94\uC815', qty: low }],
      image_url: '',
      productId: productId,
      vendorItemId: vendorItemId,
      salePrice: salePrice,
      priceSource: salePrice !== null ? 'quantity-info:1' : '',
      backgroundDirect: true
    };
  } catch(e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function estimateCoupangStockViaLocalHelper(comp, parsed) {
  var urls = [
    'http://127.0.0.1:8765/stock',
    'http://localhost:8765/stock'
  ];
  var payload = {
    productUrl: (comp && comp.url) || '',
    productId: (parsed && parsed.pid) || '',
    itemId: (parsed && parsed.itemId) || '',
    vendorItemId: (parsed && parsed.vendorItemId) || '',
    expectedStock: comp && comp.expectedStock != null ? comp.expectedStock : null,
    fastStockOnly: !!(parsed && parsed.pid && parsed.vendorItemId)
  };
  var lastError = '';
  for (var i = 0; i < urls.length; i++) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function() { controller.abort(); }, 90000) : null;
    try {
      var res = await fetch(urls[i], {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) {
        // 헬퍼는 실패 시 500 + JSON으로 실제 원인(RET9999 등)을 보내준다 — 버리지 말고 보존
        var errBody = null;
        try { errBody = await res.json(); } catch (jsonErr) {}
        lastError = errBody && errBody.error
          ? 'local helper: ' + String(errBody.error)
          : 'local helper HTTP ' + res.status;
        continue;
      }
      var data = await res.json();
      if (data && data.ok) {
        if (!versionAtLeast(data.helperVersion, MIN_COUPANG_HELPER_VERSION)) {
          lastError = 'local helper update required';
          continue;
        }
        return {
          ok: true,
          stock: data.stock,
          overLimit: data.overLimit,
          reason: data.reason,
          options: data.options,
          image_url: data.image_url || '',
          productId: data.productId || payload.productId,
          itemId: data.itemId || payload.itemId,
          vendorItemId: data.vendorItemId || payload.vendorItemId,
          salePrice: data.salePrice,
          priceSource: data.priceSource || '',
          ratingCount: data.ratingCount,
          localHelper: true,
          helperVersion: data.helperVersion || '',
          elapsedMs: data.elapsedMs,
          apiCalls: data.apiCalls
        };
      }
      lastError = (data && data.error) || 'local helper returned no result';
    } catch(e) {
      lastError = e && e.message ? e.message : String(e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError || 'local helper unavailable' };
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

// 수량 1 조회조차 RET9999로 거부된 경우 — 상품 페이지로 돌아가 품절 여부를 확인
async function checkCoupangPageSoldOut(tabId, productUrl) {
  try {
    await navigateTabAndWait(tabId, productUrl, 20000);
    await delay(800);
    var res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: function() {
        var text = document.body ? (document.body.innerText || '') : '';
        var head = text.slice(0, 30000);
        return { soldOut: /(품절|일시\s*품절|판매\s*중지|판매가\s*중지|재입고\s*알림)/.test(head) };
      }
    });
    return !!(res && res[0] && res[0].result && res[0].result.soldOut);
  } catch (e) {
    return false;
  }
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

    var baseline;
    try {
      baseline = await probeCoupangDeliveryByNavigation(tabId, identity, 1);
    } catch (baseErr) {
      var baseMsg = baseErr && baseErr.message ? baseErr.message : String(baseErr);
      if (/RET9999|시스템 오류|system error/i.test(baseMsg)) {
        // 품절/판매중지 상품은 수량 1 조회도 RET9999로 거부됨 — 페이지에서 확인 후 재고 0으로 기록
        var soldOut = await checkCoupangPageSoldOut(tabId, (comp && comp.url) || '');
        if (soldOut) {
          return {
            ok: true,
            stock: 0,
            soldOut: true,
            options: [{ name: '품절', qty: 0 }],
            image_url: identity.image_url || '',
            productId: identity.productId,
            itemId: identity.itemId,
            vendorItemId: identity.vendorItemId,
            salePrice: identity.salePrice,
            ratingCount: identity.ratingCount
          };
        }
        return { ok: false, error: '쿠팡 수량 API 거부(RET9999) — 페이지에 품절 표시는 없음. 일시 차단 가능성, 잠시 후 재시도 필요' };
      }
      throw baseErr;
    }
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
        vendorItemId: identity.vendorItemId,
        salePrice: identity.salePrice,
        ratingCount: identity.ratingCount
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
      vendorItemId: identity.vendorItemId,
      salePrice: identity.salePrice,
      ratingCount: identity.ratingCount
    };
  } catch(e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function collectCoupangStockFromPage(comp, parsed, requestContext) {
  var tabId = null;
  var reusableTab = !!(requestContext && requestContext.reuseCoupangStockTab);
  try {
    if (reusableTab && requestContext.coupangStockTabId != null) {
      try {
        await chrome.tabs.get(requestContext.coupangStockTabId);
        tabId = requestContext.coupangStockTabId;
        currentFetchTabId = tabId;
        await chrome.tabs.update(tabId, { url: comp.url, active: true });
        scheduleFocusSourceTab(requestContext, 650);
      } catch(e) {
        requestContext.coupangStockTabId = null;
      }
    }
    if (tabId == null) {
      tabId = await openPopupTabQuick(comp.url, {
        popupWindow: true,
        lightMode: true,
        width: 430,
        height: 720,
        left: 0,
        top: 0,
        returnFocusTabId: requestContext && requestContext.dashboardTabId,
        returnFocusWindowId: requestContext && requestContext.dashboardWindowId
      });
      if (reusableTab) requestContext.coupangStockTabId = tabId;
    }
    await waitForTabScriptReady(tabId, 7000);
    currentFetchTabId = tabId;
    var last = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (shouldStop()) return { ok: false, stopped: true, error: 'stopped by user' };
      if (attempt > 0) await delay(1200);

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

      if (attempt === 0 && last && /identifiers not found|delivery state not found/i.test(String(last.error || ''))) {
        await delay(1000);
        continue;
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
        await delay(1800);
      }
    }
    return last || { ok: false, error: 'Coupang stock result not found' };
  } catch(e) {
    return { ok: false, error: String(e) };
  } finally {
    if (!reusableTab) {
      await disableCoupangStockLightMode(tabId);
      if (tabId !== null) chrome.tabs.remove(tabId, () => {});
      if (currentFetchTabId === tabId) currentFetchTabId = null;
    }
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

function addCoupangProductMetricOptions(options, source) {
  var trustedSalePrice = !!(source && source.priceSource === 'quantity-info:1' && (source.localHelper || source.backgroundDirect));
  var salePrice = trustedSalePrice ? numOrNull(source && source.salePrice) : null;
  var ratingCount = numOrNull(source && source.ratingCount);
  if (salePrice !== null) options.push({ name: '\uD310\uB9E4\uAC00', qty: salePrice });
  if (ratingCount !== null) options.push({ name: '\uB9AC\uBDF0\uC218', qty: ratingCount });
  if (source && source.localHelper) {
    options.push({ name: '__coupang_source', text: 'local-helper ' + (source.helperVersion || '') + ' ' + (source.priceSource || '') });
  } else if (source && source.backgroundDirect) {
    options.push({ name: '__coupang_source', text: 'background-direct' });
  } else if (source && source.source) {
    options.push({ name: '__coupang_source', text: String(source.source) });
  }
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
  var name = String((comp && comp.name) || '').trim();
  return [
    (parsed && parsed.pid) || '',
    (parsed && parsed.itemId) || '',
    (parsed && parsed.vendorItemId) || '',
    name,
    (comp && comp.url) || ''
  ].map(function(value) {
    return String(value || '').trim();
  }).filter(Boolean).filter(function(value, index, list) {
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

async function openCoupangWingLoginOnce(requestContext) {
  requestContext = requestContext || {};
  if (requestContext.wingLoginPrompted) return null;
  requestContext.wingLoginPrompted = true;

  var tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://wing.coupang.com/*' });
  } catch(e) {}

  var tab = (tabs || []).find(function(item) { return item && item.id != null; });
  if (tab) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch(e) {}
    return tab;
  }

  try {
    return await chrome.tabs.create({ url: 'https://wing.coupang.com/', active: true });
  } catch(e) {
    return null;
  }
}

function coupangWingLoginRequiredResult() {
  return {
    ok: false,
    authRequired: true,
    error: '쿠팡 Wing 로그인이 필요합니다. 열린 Wing 탭에서 로그인한 뒤 대시보드로 돌아와 판매지표 조회를 다시 실행해 주세요.'
  };
}

async function fetchCoupangWingPostMatchingMetricsViaExistingTab(comp, parsed, requestContext) {
  var tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://wing.coupang.com/*' });
  } catch(e) {
    return { ok: false, error: 'Wing tab lookup failed' };
  }
  var tab = (tabs || []).find(function(item) { return item && item.id != null; });
  if (!tab) {
    await openCoupangWingLoginOnce(requestContext);
    return coupangWingLoginRequiredResult();
  }

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
      if (payload && payload.authRequired) {
        await openCoupangWingLoginOnce(requestContext);
        return coupangWingLoginRequiredResult();
      }
      if (!payload || !payload.ok) {
        lastError = (payload && payload.error) || lastError;
        continue;
      }
      var item = pickCoupangWingMetricItem(payload.data, parsed, comp);
      if (!item) {
        lastError = '쿠팡 Wing에서 해당 상품을 찾지 못했습니다. Wing 검색에서 상품명 또는 쿠팡 URL이 검색되는지 확인해 주세요.';
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

async function fetchCoupangWingPostMatchingMetrics(comp, parsed, requestContext) {
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
        lastError = '쿠팡 Wing에서 해당 상품을 찾지 못했습니다. Wing 검색에서 상품명 또는 쿠팡 URL이 검색되는지 확인해 주세요.';
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
    var tabResult = await fetchCoupangWingPostMatchingMetricsViaExistingTab(comp, parsed, requestContext);
    if (tabResult && (tabResult.ok || tabResult.stopped)) return tabResult;
    if (tabResult && tabResult.authRequired) return tabResult;
    lastError = tabResult && tabResult.error ? tabResult.error : lastError;
  }
  return { ok: false, error: lastError };
}

async function collectCoupangSalesMetricsFromWingApi(comp, parsed, index, total, results, requestContext) {
  var salesCacheKey = coupangStockCacheKey(parsed) || coupangCacheKey(parsed);
  var monthly = await getCachedCoupangMetric('monthly', salesCacheKey, COUPANG_MONTHLY_TTL);
  var viewsMetric = await getCachedCoupangMetric('views', salesCacheKey, COUPANG_VIEWS_TTL);
  var apiMetrics = null;
  var monthlyLookup = monthly ? null : collectCoupangMonthlyFast(comp, parsed);

  if (!viewsMetric) {
    await setStatus({
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '\uCFE0\uD321 \uD310\uB9E4 \uC9C0\uD45C API \uD655\uC778 \uC911...',
      results
    });

    apiMetrics = await withTimeout(
      fetchCoupangWingPostMatchingMetrics(comp, parsed, requestContext),
      6500,
      'Wing post-matching lookup timed out'
    );
    if (apiMetrics && apiMetrics.stopped) return apiMetrics;
    if (apiMetrics && apiMetrics.authRequired) {
      await setStatus({
        running: true,
        current: index + 1,
        total: total,
        name: comp.name,
        msg: apiMetrics.error,
        results
      });
    }
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
          salePrice: apiMetrics.salePrice,
          ratingCount: apiMetrics.ratingCount,
          image_url: apiMetrics.image_url || ''
        };
        await setCachedCoupangMetric('views', salesCacheKey, viewsMetric);
      }
    }
  }

  if (!monthly && monthlyLookup) {
    monthly = await monthlyLookup;
    if (monthly && monthly.ok) await setCachedCoupangMetric('monthly', salesCacheKey, monthly);
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
  else if (monthly && monthly.error) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9 \uC624\uB958', qty: null, text: monthly.error });
  else if (apiMetrics && apiMetrics.error) options.push({ name: '\uC6D4\uD310\uB9E4\uC218\uB7C9 \uC624\uB958', qty: null, text: apiMetrics.error });
  if (conversionRate !== null) options.push({ name: '\uC804\uD658\uC728', qty: Number(conversionRate.toFixed(2)) });
  addCoupangProductMetricOptions(options, apiMetrics || viewsMetric);

  return {
    ok: true,
    total: monthlySales,
    options: options,
    image_url: (monthly && monthly.image_url) || (viewsMetric && viewsMetric.image_url) || (apiMetrics && apiMetrics.image_url) || '',
    debugSource: (apiMetrics && apiMetrics.ok ? 'wing-post-matching' : '') + (monthly && monthly.source ? (apiMetrics && apiMetrics.ok ? '+' : '') + 'monthly-' + monthly.source : '')
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

async function collectCoupangMonthlyFast(comp, parsed) {
  var direct = await withTimeout(
    fetchCoupangMonthlyDirect(comp, parsed),
    4500,
    'Coupang background monthly lookup timed out'
  );
  if (direct && direct.ok) {
    direct.source = 'direct';
    return direct;
  }

  if (direct && direct.skipServer) return direct;

  var server = await withTimeout(
    fetchCoupangMonthlyFromServer(comp),
    4500,
    'Coupang server monthly lookup timed out'
  );
  if (server && server.ok) {
    server.source = 'server';
    return server;
  }

  return server || direct || { ok: false, error: 'Coupang monthly sales not found' };
}

async function waitForOhouseStock(tabId, pid) {
  var elapsed = 0;
  var maxWait = 45000;
  while (elapsed < maxWait) {
    if (shouldStop()) return { ok: false, stopped: true, error: '사용자 중지' };
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

function normalizeSeparatedFetchMode(fetchMode, requestedMarket) {
  var mode = String(fetchMode || '').toLowerCase();
  var market = String(requestedMarket || '').toLowerCase();
  if (mode === 'coupang_stock' || mode === 'stock' || market === 'coupang_stock') return 'coupang_stock';
  if (mode === 'coupang_sales' || mode === 'sales' || market === 'coupang') return 'coupang_sales';
  return '';
}

async function collectCoupangStockMetricOnly(comp, parsed, index, total, results, requestContext) {
  await reportFetchStatus(requestContext, {
    running: true,
    current: index + 1,
    total: total,
    name: comp.name,
    msg: '\uCFE0\uD321 \uC7AC\uACE0\uC870\uD68C\uB9CC \uC2E4\uD589 \uC911...',
    results
  }, { source: 'start' });

  if (comp && comp.expectedStock == null) {
    try {
      var cachedHint = await getCachedCoupangMetric('stock', coupangStockCacheKey(parsed), COUPANG_STOCK_TTL);
      if (cachedHint && cachedHint.stock != null && Number.isFinite(Number(cachedHint.stock))) {
        comp = Object.assign({}, comp, { expectedStock: Number(cachedHint.stock) });
      }
    } catch(e) {}
  }

  var stock = null;
  var helperSkipKey = coupangStockCacheKey(parsed);
  var helperSkipEntry = null;
  try { helperSkipEntry = await getCoupangHelperSkip(helperSkipKey); } catch(e) {}
  if (!stock && helperSkipEntry) {
    await reportFetchStatus(requestContext, {
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '헬퍼 미지원 상품으로 기록됨 - 바로 브라우저 조회',
      results
    }, { source: 'local-helper-skip-product', error: helperSkipEntry.reason || '' });
  } else if (!stock && !(requestContext && requestContext.coupangLocalHelperDisabled)) {
    await reportFetchStatus(requestContext, {
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '\uCFE0\uD321 \uB85C\uCEEC \uBE60\uB978 \uD5EC\uD37C \uD655\uC778 \uC911...',
      results
    }, { source: 'local-helper' });
    stock = await estimateCoupangStockViaLocalHelper(comp, parsed);
    if (stock && stock.ok) {
      if (requestContext) requestContext.coupangLocalHelperFailures = 0;
    } else {
      // 상품 자체 문제(품절 등으로 인한 RET9999/quantity 오류)는 헬퍼 장애가 아니므로
      // 연속 실패 카운트에서 제외 — 품절 상품 몇 개 때문에 헬퍼 전체가 꺼지는 것 방지
      var helperErr = String((stock && stock.error) || '');
      if (/RET9999|quantity|시스템 오류/i.test(helperErr)) {
        // 이 상품은 헬퍼로 조회 불가가 확인됨 — 24시간 동안 헬퍼를 건너뛰어 매번 10초 낭비 방지
        try { await markCoupangHelperSkip(helperSkipKey, helperErr.slice(0, 200)); } catch(e) {}
      } else if (requestContext) {
        requestContext.coupangLocalHelperFailures = (requestContext.coupangLocalHelperFailures || 0) + 1;
        if (requestContext.coupangLocalHelperFailures >= COUPANG_LOCAL_HELPER_FAILURE_LIMIT) {
          requestContext.coupangLocalHelperDisabled = true;
        }
      }
    }
  } else if (!stock && requestContext && requestContext.coupangLocalHelperDisabled) {
    await reportFetchStatus(requestContext, {
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '\uCFE0\uD321 \uB85C\uCEEC \uD5EC\uD37C \uC5F0\uC18D \uC2E4\uD328\uB85C \uAC74\uB108\uB6F0\uACE0 \uBE0C\uB77C\uC6B0\uC800 \uACBD\uB85C\uB85C \uC804\uD658',
      results
    }, { source: 'local-helper-skip', error: 'local helper disabled after repeated failures' });
  }
  // \uD5EC\uD37C \uC2E4\uD328\uAC00 \uC0C1\uD488 \uC6D0\uC778(\uD488\uC808 RET9999 \uB4F1)\uC774\uBA74 \uBE60\uB978\uACBD\uB85C\uB3C4 \uAC19\uC740 \uC774\uC720\uB85C \uC2E4\uD328\uD558\uBBC0\uB85C
  // \uAC74\uB108\uB6F0\uACE0 \uBC14\uB85C \uBE0C\uB77C\uC6B0\uC800 \uACBD\uB85C(\uD488\uC808 \uD310\uBCC4 \uAC00\uB2A5)\uB85C \uBCF4\uB0B8\uB2E4
  var helperProductLevelFail = !!(stock && !stock.ok && /RET9999|quantity|\uC2DC\uC2A4\uD15C \uC624\uB958/i.test(String(stock.error || '')));
  if ((!stock || !stock.ok) && !helperProductLevelFail) {
    await reportFetchStatus(requestContext, {
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '\uCFE0\uD321 \uC7AC\uACE0\uC870\uD68C \uBE60\uB978 \uACBD\uB85C \uD655\uC778 \uC911...',
      results
    }, { source: 'background-direct', error: stock && stock.error });
    stock = await estimateCoupangStockInBackground(comp, parsed);
  }
  if (stock && stock.ok && stock.localHelper) {
    await reportFetchStatus(requestContext, {
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '\uCFE0\uD321 \uB85C\uCEEC \uD5EC\uD37C \uC131\uACF5'
        + (stock.elapsedMs ? ' (' + (stock.elapsedMs / 1000).toFixed(1) + '\uCD08' : '')
        + (stock.apiCalls ? ', API ' + stock.apiCalls + '\uD68C' : '')
        + (stock.elapsedMs ? ')' : ''),
      results
    }, { level: 'ok', source: 'local-helper', stock: stock.stock, apiCalls: stock.apiCalls });
  }
  if (!stock || !stock.ok) {
    await reportFetchStatus(requestContext, {
      running: true,
      current: index + 1,
      total: total,
      name: comp.name,
      msg: '\uCFE0\uD321 \uBE0C\uB77C\uC6B0\uC800 \uC138\uC158\uC73C\uB85C \uC7AC\uACE0\uC870\uD68C \uC911...',
      results
    }, { source: 'browser-fallback', error: stock && stock.error });
    stock = await collectCoupangStockFromPage(comp, parsed, requestContext);
  }
  if (stock && stock.stopped) return stock;
  if (!stock || !stock.ok) {
    return { ok: false, error: (stock && stock.error) || 'Coupang stock data not found' };
  }

  var value = stock.stock != null ? Number(stock.stock) : null;
  var options = [];
  if (value !== null && Number.isFinite(value)) {
    options.push({ name: stock.soldOut ? '\uD488\uC808' : '\uC7AC\uACE0 \uCD94\uC815', qty: value });
    addCoupangProductMetricOptions(options, stock);
    await setCachedCoupangMetric('stock', coupangStockCacheKey(parsed), {
      ok: true,
      stock: value,
      options: options,
      salePrice: stock.priceSource === 'quantity-info:1' && (stock.localHelper || stock.backgroundDirect) ? stock.salePrice : null,
      priceSource: stock.priceSource || '',
      ratingCount: stock.ratingCount,
      image_url: stock.image_url || ''
    });
  } else if (stock.overLimit) {
    options.push({
      name: '\uC7AC\uACE0 \uCD94\uC815 \uC624\uB958',
      qty: null,
      text: stock.reason || '5000\uAC1C \uC774\uC0C1 \uB610\uB294 \uBC30\uC1A1 \uACBD\uACC4 \uBBF8\uBC1C\uACAC'
    });
    addCoupangProductMetricOptions(options, stock);
  }

  return {
    ok: true,
    total: value,
    options: options,
    image_url: stock.image_url || '',
    debugSource: stock.localHelper ? 'local-helper' : stock.backgroundDirect ? 'background-direct' : 'browser-fallback',
    debugElapsedMs: stock.elapsedMs || 0,
    debugApiCalls: stock.apiCalls || 0
  };
}

async function runFetchSeparated(competitors, fetchMode, requestedMarket, requestContext) {
  if (fetchRunning) return false;
  fetchRunning = true;
  fetchStarting = false;
  stopRequested = false;
  currentFetchTabId = null;

  // MV3 워커 keep-alive 겸 상태 하트비트:
  // 긴 await(로컬 헬퍼 90초 등) 중에도 워커 idle 종료를 막고 updatedAt을 갱신한다
  var keepAliveTimer = setInterval(function() {
    chrome.storage.local.get('fetchStatus', function(data) {
      var s = data && data.fetchStatus;
      if (s && s.running) {
        s.updatedAt = Date.now();
        chrome.storage.local.set({ fetchStatus: s });
      }
    });
  }, FETCH_KEEPALIVE_INTERVAL_MS);

  var runStartedMs = Date.now();
  var runStartedAt = new Date(runStartedMs).toISOString();
  var runId = runStartedAt + '-' + Math.random().toString(16).slice(2);
  var itemLogs = [];
  var eventLogs = [];
  var results = [];
  var stopped = false;
  var blockSuspected = false;
  var authRequired = false;
  var authMessage = '';
  var route = normalizeSeparatedFetchMode(fetchMode, requestedMarket);
  var queuedMarkets = competitors.map(function(comp) { return detectMarket(comp && comp.url); });
  if (route && queuedMarkets.length && queuedMarkets.every(function(market) { return market !== 'coupang'; })) {
    route = '';
  }
  if (route === 'coupang_stock') {
    requestContext = Object.assign({}, requestContext || {}, { reuseCoupangStockTab: true, coupangStockTabId: null });
  }
  requestContext = requestContext || {};
  requestContext.statusLogger = async function(status, detail) {
    detail = detail || {};
    var msg = status && status.msg ? String(status.msg) : '';
    var event = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - runStartedMs,
      current: Number(status && status.current || 0),
      total: Number(status && status.total || competitors.length || 0),
      name: String(status && status.name || ''),
      level: String(detail.level || (detail.error ? 'error' : 'info')),
      msg: msg,
      source: String(detail.source || ''),
      apiCalls: Number(detail.apiCalls || 0),
      stock: detail.stock != null ? detail.stock : null,
      error: detail.error ? String(detail.error) : ''
    };
    var key = [
      event.current,
      event.name,
      event.msg,
      event.source,
      event.stock,
      event.error
    ].join('|');
    var last = eventLogs[eventLogs.length - 1];
    var lastKey = last ? [last.current, last.name, last.msg, last.source, last.stock, last.error].join('|') : '';
    if (key !== lastKey) eventLogs.push(event);
    status.events = eventLogs.slice(-160);
    await setStatus(status);
  };

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
        itemLogs.push({
          name: comp.name,
          market: market,
          status: 'skipped',
          elapsedMs: 0,
          error: 'Excluded by fetch mode'
        });
        continue;
      }

      var parsed = market === 'coupang'
        ? parseCoupangUrl(comp.url)
        : market === 'ohouse'
          ? parseOhouseUrl(comp.url)
          : parseNaverUrl(comp.url);

      await reportFetchStatus(requestContext, {
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
      }, { source: route || market || 'start' });

      if (!parsed) {
        results.push({ id: comp.id, name: comp.name, error: 'URL \uD615\uC2DD \uC624\uB958' });
        itemLogs.push({
          name: comp.name,
          market: market,
          status: 'error',
          elapsedMs: 0,
          error: 'URL format error'
        });
        continue;
      }

      var tabId = null;
      var itemStartedMs = Date.now();
      try {
        var cr = null;
        if (market === 'coupang') {
          if (route === 'coupang_stock') {
            cr = await collectCoupangStockMetricOnly(comp, parsed, i, competitors.length, results, requestContext);
          } else if (route === 'coupang_sales') {
            cr = await collectCoupangSalesMetricsFromWingApi(comp, parsed, i, competitors.length, results, requestContext);
          } else {
            cr = { ok: false, error: 'Coupang fetch mode missing' };
          }
        } else if (market === 'ohouse') {
          cr = await readOhouseStock(parsed.pid);
        } else {
          tabId = await openTab(comp.url);
          currentFetchTabId = tabId;
          cr = await waitForCache(tabId, parsed.pid, async (msg) => {
            await reportFetchStatus(requestContext, { running: true, current: i + 1, total: competitors.length, name: comp.name, msg, results }, { source: 'browser-tab' });
          }, { scheduled: !!(requestContext && requestContext.scheduled) });
          if (cr && cr.retryDesktop) {
            try { await chrome.tabs.remove(tabId); } catch(e) {}
            if (currentFetchTabId === tabId) currentFetchTabId = null;
            tabId = await openTab(comp.url);
            currentFetchTabId = tabId;
            cr = await waitForCache(tabId, parsed.pid, async (msg) => {
              await reportFetchStatus(requestContext, { running: true, current: i + 1, total: competitors.length, name: comp.name, msg: 'PC URL 재시도 - ' + msg, results }, { source: 'browser-tab' });
            }, { scheduled: !!(requestContext && requestContext.scheduled) });
          }
        }

        if (cr && cr.stopped) {
          stopped = true;
          break;
        } else if (cr && cr.authRequired) {
          authRequired = true;
          authMessage = cr.error || '쿠팡 Wing 로그인이 필요합니다.';
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
        var latest = null;
        for (var li = results.length - 1; li >= 0; li--) {
          if (results[li] && results[li].id === comp.id) {
            latest = results[li];
            break;
          }
        }
        // 쿠팡 일시 차단(Akamai Access Denied 등) 패턴 연속 감지 — 계속 두드리면 차단만 길어진다
        if (route === 'coupang_stock' && requestContext) {
          var blockErrText = latest && latest.error ? String(latest.error) : '';
          if (blockErrText && /Access Denied|RET9999|HTTP 403|quantity=1 failed|vendorItemId not found/i.test(blockErrText)) {
            requestContext.coupangBlockStreak = (requestContext.coupangBlockStreak || 0) + 1;
          } else if (latest && !latest.error) {
            requestContext.coupangBlockStreak = 0;
          }
        }
        itemLogs.push({
          name: comp.name,
          market: market,
          status: latest && !latest.error ? 'ok' : 'error',
          elapsedMs: Date.now() - itemStartedMs,
          total: latest && latest.total != null ? latest.total : null,
          source: cr && cr.debugSource ? cr.debugSource : '',
          apiCalls: cr && cr.debugApiCalls ? cr.debugApiCalls : 0,
          error: latest && latest.error ? latest.error : ''
        });
        await reportFetchStatus(requestContext, {
          running: true,
          current: i + 1,
          total: competitors.length,
          name: comp.name,
          msg: latest && !latest.error ? '\uC870\uD68C \uC644\uB8CC - \uACB0\uACFC \uD45C\uC2DC' : '\uC870\uD68C \uC2E4\uD328 - \uB2E4\uC74C \uC0C1\uD488\uC73C\uB85C \uC774\uB3D9',
          results
        }, {
          level: latest && !latest.error ? 'ok' : 'error',
          source: cr && cr.debugSource ? cr.debugSource : '',
          apiCalls: cr && cr.debugApiCalls ? cr.debugApiCalls : 0,
          stock: latest && latest.total != null ? latest.total : null,
          error: latest && latest.error
        });
      }

      if (shouldStop()) { stopped = true; break; }
      if (route === 'coupang_stock' && requestContext && (requestContext.coupangBlockStreak || 0) >= 3) {
        // 연속 3개가 차단 패턴으로 실패 — 남은 상품을 계속 두드리면 차단이 길어지므로 중단
        blockSuspected = true;
        stopped = true;
        break;
      }
      if (i < competitors.length - 1) {
        await new Promise(r => setTimeout(r, route === 'coupang_sales' ? 200 : (market === 'naver' ? 3000 : 900)));
      }
    }

    var saveResults = results.filter(function(r) { return !r.skipSave; });
    var saveError = '';
    if (saveResults.length) {
      await flushPendingStockSaves();
      saveError = await saveStockResultsWithRetry(saveResults, route);
    }

    // \uD050 \uAE30\uBC18 \uC870\uD68C\uB294 \uC2E4\uC81C \uCC98\uB9AC\uB41C \uD56D\uBAA9\uB9CC \uC11C\uBC84 \uB300\uAE30 \uD050\uC5D0\uC11C \uC81C\uAC70 (\uC870\uD68C \uC2E4\uD328/\uC911\uB2E8 \uC2DC \uD050 \uC720\uC2E4 \uBC29\uC9C0)
    if (requestContext && Array.isArray(requestContext.queueIds) && requestContext.queueIds.length) {
      try {
        var processedIds = {};
        results.forEach(function(r) { if (r && r.id) processedIds[r.id] = true; });
        var doneIds = requestContext.queueIds.filter(function(id) { return processedIds[id]; });
        if (doneIds.length) {
          await apiFetch('/api/public/queue', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: doneIds })
          });
        }
      } catch (e) {}
    }

    var okCount = results.filter(r => !r.error).length;
    var errItems = results.filter(r => r.error);
    var msg = authRequired
      ? authMessage
      : blockSuspected
      ? '⛔ 쿠팡 일시 차단 감지 — 연속 3개 상품이 차단 패턴(Access Denied 등)으로 실패해 조회를 중단했습니다. 30분~1시간 후 다시 시도하세요. 저장된 결과 ' + okCount + '/' + results.length
      : stopped
      ? `STOP\uC73C\uB85C \uC911\uB2E8\uB428. \uC800\uC7A5\uB41C \uACB0\uACFC ${okCount}/${results.length} \uC131\uACF5`
      : `\uC870\uD68C \uC644\uB8CC! ${okCount}/${results.length} \uC131\uACF5`;
    if (errItems.length) msg += '\n\uC2E4\uD328: ' + errItems.map(r => r.name + '(' + r.error + ')').join(', ');
    if (saveError) msg += '\n\u26A0\uFE0F \uC11C\uBC84 \uC800\uC7A5 \uC2E4\uD328(' + saveError + ') \u2014 \uACB0\uACFC\uB294 \uBCF4\uAD00\uB418\uC5B4 \uB2E4\uC74C \uC870\uD68C \uB54C \uC790\uB3D9 \uC7AC\uC804\uC1A1\uB429\uB2C8\uB2E4.';

    await reportFetchStatus(requestContext, { running: false, done: !stopped, stopped, msg, results }, { level: stopped || errItems.length || saveError ? 'error' : 'ok', source: 'summary' });
    await postFetchLog({
      runId: runId,
      mode: route || 'default',
      phase: requestContext && requestContext.schedulePhase ? requestContext.schedulePhase : '',
      scheduled: !!(requestContext && requestContext.scheduled),
      startedAt: runStartedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - runStartedMs,
      total: competitors.length,
      ok: okCount,
      errors: errItems.length,
      stopped: stopped,
      message: msg,
      items: itemLogs,
      events: eventLogs
    });
  } finally {
    clearInterval(keepAliveTimer);
    if (requestContext && requestContext.coupangStockTabId != null) {
      var closeTabId = requestContext.coupangStockTabId;
      await disableCoupangStockLightMode(closeTabId);
      try { await chrome.tabs.remove(closeTabId); } catch(e) {}
      if (currentFetchTabId === closeTabId) currentFetchTabId = null;
      requestContext.coupangStockTabId = null;
    }
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
  if (msg.type === 'SYNC_SCHEDULE') {
    (async () => {
      if (msg.schedule) await applyAutoFetchSchedule(msg.schedule);
      else await syncAutoFetchScheduleFromServer();
      var state = await getAuthState();
      sendResponse({ ok: true, hasAuth: !!(state.accessToken || state.refreshToken) });
    })();
    return true;
  }
  if (msg.type === 'RUN_SCHEDULED_FETCH_NOW') {
    (async () => {
      var state = await getAuthState();
      var hasAuth = !!(state.accessToken || state.refreshToken);
      if (hasAuth) runScheduledAutoFetch();
      sendResponse({ ok: true, hasAuth: hasAuth });
    })();
    return true;
  }
  if (msg.type === 'START_FETCH') {
    if (fetchRunning || fetchStarting) {
      // 동기 구간에서 가드 — await 이후 체크는 거의 동시에 온 두 메시지를 둘 다 통과시킨다
      sendResponse({ ok: false, error: '이미 조회가 진행 중입니다. 먼저 STOP을 눌러주세요.' });
      return false;
    }
    fetchStarting = true;
    (async () => {
      try {
        var competitors = msg.competitors || [];
        if (!competitors.length) {
          fetchStarting = false;
          sendResponse({ ok: false, error: '조회할 상품이 없습니다.' });
          return;
        }
        var token = await ensureServiceToken(4000);
        if (!token) {
          fetchStarting = false;
          sendResponse({ ok: false, error: '확장 프로그램에서 서비스 로그인이 필요합니다.' });
          return;
        }
        setStatus({ running: true, current: 0, total: competitors.length, msg: '시작 중...', results: [] });
        // runFetchSeparated는 진입 즉시 fetchRunning=true, fetchStarting=false로 전환한다
        runFetchSeparated(competitors, msg.fetchMode || msg.coupangMode || msg.mode || '', msg.market || '', {
          dashboardTabId: sender && sender.tab ? sender.tab.id : null,
          dashboardWindowId: sender && sender.tab ? sender.tab.windowId : null,
          queueIds: Array.isArray(msg.queueIds) ? msg.queueIds : []
        });
        sendResponse({ ok: true });
      } catch (e) {
        fetchStarting = false;
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !alarm.name) return;
  if (alarm.name === AUTO_FETCH_ALARM) {
    runScheduledAutoFetch();
  } else if (alarm.name === AUTO_FETCH_SYNC_ALARM) {
    syncAutoFetchScheduleFromServer();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(AUTO_FETCH_SYNC_ALARM, { periodInMinutes: 60 });
  syncAutoFetchScheduleFromServer();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(AUTO_FETCH_SYNC_ALARM, { periodInMinutes: 60 });
  syncAutoFetchScheduleFromServer();
  cleanupStaleFetchStatus();
});

// 워커가 (이벤트로) 깨어날 때마다 stale 상태 점검 — 죽은 조회의 "조회 중" 고착 해소
cleanupStaleFetchStatus();
