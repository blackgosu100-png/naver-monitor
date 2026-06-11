// ─── 유틸 ─────────────────────────────────────────────────────
function showMsg(id, text, cls) {
  var el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + cls;
  el.style.display = 'block';
}

var DEFAULT_SERVER = 'https://naver-monitor-production.up.railway.app';

function syncPopupVersion() {
  var el = document.getElementById('extension-version');
  if (!el) return;
  try {
    var manifest = chrome.runtime.getManifest();
    el.textContent = 'v' + (manifest && manifest.version ? manifest.version : '-');
  } catch (e) {
    el.textContent = 'v-';
  }
}

function normalizeServerUrl(url) {
  var value = (url || DEFAULT_SERVER).replace(/\/$/, '');
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

function openServicePage(path) {
  var serverUrl = DEFAULT_SERVER;
  chrome.storage.local.set({ serverUrl: serverUrl });
  chrome.tabs.create({ url: serverUrl + (path || '/login?mode=signup'), active: true });
}

async function setLoggedInUi(email) {
  var stateEl = document.getElementById('login-state');
  var loadingEl = document.getElementById('auth-loading');
  if (loadingEl) loadingEl.style.display = 'none';
  stateEl.innerHTML = '<strong>' + (email || '웹 대시보드 연결됨') + '</strong>웹 로그인 상태를 사용합니다.<br><button class="link-btn" id="open-dashboard-btn">웹앱 열기</button> <button class="link-btn" id="logout-btn">연결 해제</button>';
  stateEl.style.display = 'block';
  document.getElementById('login-msg').style.display = 'none';
  var dashboardBtn = document.getElementById('open-dashboard-btn');
  if (dashboardBtn) dashboardBtn.addEventListener('click', function() {
    openServicePage('/');
  });
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
  showMsg('login-msg', '처음이라면 지금 바로 시작하기로 무료 계정을 만드세요. 경쟁사 3개까지 바로 사용할 수 있습니다.', 'info');
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
    showMsg('queue-msg', '대기 중인 조회 ' + queue.length + '개를 백그라운드에서 시작합니다.', 'info');

    var fetchMode = data.fetchMode || data.fetch_mode || '';
    var isCoupangQueue = false;
    if (fetchMode && queue.some(function(comp) {
      return !/coupang\.com\/(?:v[pm]\/)?products\//i.test(String((comp && comp.url) || ''));
    })) {
      fetchMode = '';
    }
    isCoupangQueue = fetchMode && queue.some(function(comp) {
      return /coupang\.com\/(?:v[pm]\/)?products\//i.test(String((comp && comp.url) || ''));
    });
    if (isCoupangQueue) {
      showMsg('queue-msg', '쿠팡 판매가는 현재 크롬의 쿠팡 로그인/와우/쿠폰 세션 기준으로 조회됩니다.', 'info');
    }
    await new Promise(function(resolve, reject) {
      chrome.runtime.sendMessage({
        type: 'START_FETCH',
        competitors: queue,
        fetchMode: fetchMode,
        queueIds: queue.map(function(c) { return c.id; })
      }, function(response) {
        var error = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
        if (error || !(response && response.ok)) {
          reject(new Error(error || (response && response.error) || '대기 조회 시작 실패'));
          return;
        }
        resolve();
      });
    });

    // 대기 큐 삭제는 background가 조회 완료 후 처리한다 (조회 실패 시 큐 유실 방지)
    qFill.style.width = '100%';
    showMsg('queue-msg', '백그라운드에서 대기 조회를 시작했습니다. 완료되면 대시보드가 새로고침됩니다.', 'ok');
    return;
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

  // 워커 사망 등으로 갱신이 끊긴 stale running 상태는 에러로 전환
  if (s.running && s.updatedAt && (Date.now() - Number(s.updatedAt)) > 3 * 60 * 1000) {
    var fetchBtnStale = document.getElementById('fetch-btn');
    if (fetchBtnStale) fetchBtnStale.disabled = false;
    document.getElementById('stop-btn').style.display = 'none';
    showMsg('fetch-msg', '이전 조회가 중단된 것으로 보입니다. 다시 조회해주세요.', 'err');
    chrome.storage.local.remove('fetchStatus');
    if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
    return;
  }

  if (s.running) {
    var fetchBtn = document.getElementById('fetch-btn');
    if (fetchBtn) fetchBtn.disabled = true;
    stopBtn.style.display = 'block';
    bar.style.display = 'block';
    var pct = s.total > 0 ? Math.round(((s.current - 0.5) / s.total) * 85) : 0;
    fill.style.width = pct + '%';
    var label = s.name ? '조회 중 (' + s.current + '/' + s.total + '): ' + s.name + (s.msg ? ' — ' + s.msg : '') : s.msg || '';
    showMsg('fetch-msg', label, 'info');
  } else if (s.done) {
    var fetchBtnDone = document.getElementById('fetch-btn');
    if (fetchBtnDone) fetchBtnDone.disabled = false;
    stopBtn.style.display = 'none';
    fill.style.width = '100%';
    var okCount = (s.results || []).filter(function(r) { return !r.error; }).length;
    showMsg('fetch-msg', s.msg || '완료', okCount === (s.results || []).length ? 'ok' : 'info');
    chrome.storage.local.remove('fetchStatus');
    if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
  } else if (s.stopped) {
    var fetchBtnStopped = document.getElementById('fetch-btn');
    if (fetchBtnStopped) fetchBtnStopped.disabled = false;
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

syncPopupVersion();
initializePopup();

document.getElementById('open-dashboard-btn-main').addEventListener('click', function() {
  openServicePage('/login?mode=signup');
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
    var fetchBtn = document.getElementById('fetch-btn');
    if (fetchBtn) fetchBtn.disabled = false;
    showMsg('fetch-msg', '조회 중지 요청을 보냈습니다.', 'info');
  });
});

// ─── 캐시 폴링 ────────────────────────────────────────────────
