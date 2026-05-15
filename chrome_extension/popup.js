// ─── 유틸 ─────────────────────────────────────────────────────
function showMsg(id, text, cls) {
  var el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + cls;
  el.style.display = 'block';
}

var DEFAULT_SERVER = 'https://naver-monitor-production.up.railway.app';

function normalizeServerUrl(url) {
  var value = (url || DEFAULT_SERVER).replace(/\/$/, '');
  if (value === 'http://localhost:5000' || value === 'http://localhost:5001') {
    return DEFAULT_SERVER;
  }
  return value;
}

async function getAuthState() {
  var data = await chrome.storage.local.get(['serverUrl', 'accessToken', 'refreshToken', 'loginEmail']);
  var serverUrl = normalizeServerUrl(data.serverUrl);
  if (data.serverUrl !== serverUrl) await chrome.storage.local.set({ serverUrl: serverUrl });
  return {
    serverUrl: serverUrl,
    accessToken: data.accessToken || '',
    refreshToken: data.refreshToken || '',
    loginEmail: data.loginEmail || ''
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

async function apiFetch(path, options) {
  var state = await getAuthState();
  if (!state.accessToken && state.refreshToken) {
    state.accessToken = await refreshServiceToken(state) || '';
  }
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
  if (res.status === 401 || res.status === 403) {
    await setLoggedOutUi();
  }
  return res;
}

async function signInToService() {
  var serverUrl = normalizeServerUrl(document.getElementById('server-url').value.trim());
  var email = document.getElementById('login-email').value.trim();
  var password = document.getElementById('login-password').value;
  if (!email || !password) throw new Error('이메일과 비밀번호를 입력해주세요.');

  var authRes = await fetch(serverUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password })
  });
  var authData = await authRes.json();
  if (!authRes.ok) throw new Error(authData.error || '로그인에 실패했습니다.');
  await chrome.storage.local.set({
    serverUrl: serverUrl,
    accessToken: authData.access_token,
    refreshToken: authData.refresh_token,
    loginEmail: email
  });
  await setLoggedInUi(email);
}

async function setLoggedInUi(email) {
  var stateEl = document.getElementById('login-state');
  var formEl = document.getElementById('login-form');
  var loadingEl = document.getElementById('auth-loading');
  if (loadingEl) loadingEl.style.display = 'none';
  stateEl.innerHTML = '<strong>' + (email || '로그인됨') + '</strong>서비스 로그인 상태입니다.<br><button class="link-btn" id="logout-btn">로그아웃</button>';
  stateEl.style.display = 'block';
  formEl.style.display = 'none';
  document.getElementById('login-msg').style.display = 'none';
  var logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', async function() {
    await chrome.storage.local.remove(['accessToken', 'refreshToken', 'loginEmail']);
    await setLoggedOutUi();
  });
}

async function setLoggedOutUi() {
  var loadingEl = document.getElementById('auth-loading');
  if (loadingEl) loadingEl.style.display = 'none';
  document.getElementById('login-state').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
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

    chrome.tabs.create({ url: url, active: true }, function(tab) {
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

  // 진단: 캐시 변수 자체가 존재하는지
  if (typeof window.__naverStockCache === 'undefined') {
    return { ok: false, error: 'hook미설치 (content.js MAIN world 미실행)' };
  }
  var data = window.__naverStockCache[pid];
  if (!data) return { ok: false, error: '캐시 없음 (SSR/XHR 데이터 미수신)' };
  var imageUrl = getImageUrl(data);

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
  return { ok: true, options: options, total: total, image_url: imageUrl };
}

// ─── 대기 큐 자동 처리 (팝업 열릴 때) ────────────────────────
async function checkAndProcessQueue() {
  var qSec = document.getElementById('queue-section');
  var qBar = document.getElementById('queue-bar');
  var qFill = document.getElementById('queue-fill');
  try {
    var r = await apiFetch('/api/public/queue');
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
        var cr = await waitForCache(tabId, parsed.pid, 15000, function(msg) {
          showMsg('queue-msg', '처리 중 (' + (i + 1) + '/' + queue.length + '): ' + comp.name + ' — ' + msg, 'info');
        });
        if (cr && cr.ok) {
          results.push({ id: comp.id, name: comp.name, total: cr.total, options: cr.options, image_url: cr.image_url || '', error: null, fetched_at: new Date().toISOString() });
        } else {
          results.push({ id: comp.id, name: comp.name, error: (cr && cr.error) || '데이터 없음' });
        }
      } catch(e) {
        results.push({ id: comp.id, name: comp.name, error: String(e) });
      } finally {
        if (tabId !== null) chrome.tabs.remove(tabId, function() {});
      }

      // 상품 사이 3초 대기 — 연속 요청으로 인한 재인증 방지
      if (i < queue.length - 1) await new Promise(function(r) { setTimeout(r, 3000); });
    }

    qFill.style.width = '90%';
    await apiFetch('/api/stock-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: results })
    });

    await apiFetch('/api/public/queue', {
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

    var state = await getAuthState();
    chrome.tabs.query({ url: state.serverUrl + '/*' }, function(tabs) {
      if (tabs.length) chrome.tabs.reload(tabs[0].id);
    });
  } catch(e) {
    // 서버 미실행 등 — 조용히 무시
  }
}

// ─── 경쟁사 재고 조회 버튼 ────────────────────────────────────
// ─── 팝업 열릴 때 백그라운드 상태 폴링 ───────────────────────
var statusPoller = null;

async function pollStatus() {
  var data = await chrome.storage.local.get('fetchStatus');
  var s = data.fetchStatus;
  if (!s) return;

  var bar = document.getElementById('progress-bar');
  var fill = document.getElementById('progress-fill');
  var stopBtn = document.getElementById('stop-btn');

  if (s.running) {
    document.getElementById('fetch-btn').disabled = true;
    stopBtn.style.display = 'block';
    bar.style.display = 'block';
    var pct = s.total > 0 ? Math.round(((s.current - 0.5) / s.total) * 85) : 0;
    fill.style.width = pct + '%';
    var label = s.name ? '조회 중 (' + s.current + '/' + s.total + '): ' + s.name + (s.msg ? ' — ' + s.msg : '') : s.msg || '';
    showMsg('fetch-msg', label, 'info');
  } else if (s.done) {
    document.getElementById('fetch-btn').disabled = false;
    stopBtn.style.display = 'none';
    fill.style.width = '100%';
    var okCount = (s.results || []).filter(function(r) { return !r.error; }).length;
    showMsg('fetch-msg', s.msg || '완료', okCount === (s.results || []).length ? 'ok' : 'info');
    chrome.storage.local.remove('fetchStatus');
    if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
  } else if (s.stopped) {
    document.getElementById('fetch-btn').disabled = false;
    stopBtn.style.display = 'none';
    showMsg('fetch-msg', s.msg || '중지되었습니다', 'info');
    chrome.storage.local.remove('fetchStatus');
    if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
  }
}

chrome.storage.local.get('fetchStatus', function(data) {
  if (data.fetchStatus && data.fetchStatus.running) {
    statusPoller = setInterval(pollStatus, 800);
    pollStatus();
  }
});

// ─── 초기 상태 ───────────────────────────────────────────────
async function initializePopup() {
  var state = await getAuthState();
  document.getElementById('server-url').value = state.serverUrl;
  if (state.loginEmail) document.getElementById('login-email').value = state.loginEmail;

  if (state.accessToken || state.refreshToken) {
    try {
      var r = await apiFetch('/api/config');
      if (r.ok) {
        var cfg = await r.json();
        await setLoggedInUi(cfg.username || state.loginEmail);
      } else {
        await setLoggedOutUi();
      }
    } catch(e) {
      await setLoggedOutUi();
    }
  } else {
    await setLoggedOutUi();
  }
}

initializePopup();

document.getElementById('login-btn').addEventListener('click', async function() {
  var btn = document.getElementById('login-btn');
  btn.disabled = true;
  showMsg('login-msg', '로그인 중...', 'info');
  try {
    await signInToService();
    showMsg('login-msg', '서비스 로그인 완료', 'ok');
  } catch(e) {
    showMsg('login-msg', String(e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('fetch-btn').addEventListener('click', async function() {
  var btn = document.getElementById('fetch-btn');
  var bar = document.getElementById('progress-bar');
  var fill = document.getElementById('progress-fill');

  try {
    var listResp = await apiFetch('/api/public/competitors');
    if (!listResp.ok) throw new Error('앱 서버 연결 실패 — run.bat이 실행 중인지 확인하세요');
    var listData = await listResp.json();
    var competitors = listData.competitors || [];
    if (competitors.length === 0) throw new Error('등록된 경쟁사가 없습니다. 앱 설정에서 추가해주세요.');

    btn.disabled = true;
    document.getElementById('stop-btn').style.display = 'block';
    bar.style.display = 'block';
    fill.style.width = '0%';
    showMsg('fetch-msg', '조회 시작 중... (팝업을 닫아도 계속 실행됩니다)', 'info');

    chrome.runtime.sendMessage({ type: 'START_FETCH', competitors: competitors });

    // 상태 폴링 시작
    if (statusPoller) clearInterval(statusPoller);
    statusPoller = setInterval(pollStatus, 800);

  } catch(e) {
    showMsg('fetch-msg', '❌ ' + e.message, 'err');
    btn.disabled = false;
    document.getElementById('stop-btn').style.display = 'none';
  }
});

document.getElementById('stop-btn').addEventListener('click', function() {
  var stopBtn = document.getElementById('stop-btn');
  stopBtn.disabled = true;
  showMsg('fetch-msg', 'STOP 요청 중...', 'info');
  chrome.runtime.sendMessage({ type: 'STOP_FETCH' }, function(response) {
    stopBtn.disabled = false;
    if (chrome.runtime.lastError || !response || !response.ok) {
      showMsg('fetch-msg', '❌ STOP 실패: ' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : (response && response.error || '알 수 없는 오류')), 'err');
      return;
    }
    stopBtn.style.display = 'none';
    document.getElementById('fetch-btn').disabled = false;
    showMsg('fetch-msg', '조회 중지 요청을 보냈습니다.', 'info');
  });
});

// ─── 캐시 폴링 ────────────────────────────────────────────────
// 인증 페이지 감지 시: 탭 앞으로 + 팝업 메시지 + 타임아웃 카운트 완전 정지
// 상품 페이지로 복귀 시 폴링 재개, 전체 타임아웃 2분
async function waitForCache(tabId, pid, timeout, onStatus) {
  var elapsed = 0;         // 실제 경과 시간 (인증 대기 중엔 누적 안 함)
  var verifying = false;

  while (elapsed < timeout) {
    // 탭이 어느 URL에 있는지 확인
    var tab;
    try { tab = await chrome.tabs.get(tabId); } catch(e) {
      return { ok: false, error: '탭이 닫힘' };
    }
    var currentUrl = tab.url || '';

    // 상품 페이지가 아닌 경우 → 인증/리다이렉트 페이지 (타임아웃 카운트 정지)
    if (!currentUrl.includes('/products/')) {
      if (!verifying) {
        verifying = true;
        chrome.tabs.update(tabId, { active: true }); // 탭 앞으로
        if (onStatus) onStatus('⚠️ 전화번호 입력해주세요 — 완료 후 자동 재개됩니다');
      }
      await new Promise(function(r) { setTimeout(r, 1000); });
      // elapsed 누적 없음 → 타임아웃 카운트 멈춤
      continue;
    }

    // 인증 완료 후 상품 페이지로 돌아온 경우
    if (verifying) {
      verifying = false;
      if (onStatus) onStatus('인증 완료 — 재고 데이터 로딩 중...');
      await new Promise(function(r) { setTimeout(r, 2000); }); // 페이지 로드 여유
      elapsed += 2000;
      continue;
    }

    // 캐시 읽기
    var res;
    try {
      res = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: readStockFromCache,
        args: [pid]
      });
    } catch(e) {
      return { ok: false, error: '스크립트 실행 실패: ' + String(e) };
    }
    var cr = res && res[0] && res[0].result;
    if (cr && cr.ok) return cr;

    await new Promise(function(r) { setTimeout(r, 1000); });
    elapsed += 1000;
  }

  // 타임아웃 — 마지막 결과 그대로 반환
  try {
    var res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: readStockFromCache,
      args: [pid]
    });
    return (res && res[0] && res[0].result) || { ok: false, error: '타임아웃' };
  } catch(e) {
    return { ok: false, error: '타임아웃' };
  }
}

