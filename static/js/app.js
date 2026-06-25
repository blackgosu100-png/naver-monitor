const nativeFetch = window.fetch.bind(window);
const COUPANG_LOGIN_URL = 'https://login.coupang.com/login/login.pang?rtnUrl=https%3A%2F%2Fwww.coupang.com%2Fnp%2Fpost%2Flogin%3Fr%3Dhttp%253A%252F%252Fwww.coupang.com%252F';
const CONFIG_CACHE_KEY = 'naverMonitorConfigCache:v2';
const HISTORY_CACHE_KEY = 'naverMonitorHistoryCache:v1';
const HISTORY_MODE_KEY = 'naverMonitorHistoryMode:v1';
const TIME_RANGE_KEY = 'naverMonitorTimeRange:v1';
const MARKET_KEY = 'naverMonitorMarket:v1';
const COMP_FILTER_KEY = 'naverMonitorCompFilter:v1';
const TIME_COLUMN_LIMIT = 10;
const REQUIRED_COUPANG_EXTENSION_VERSION = '5.81';
const MARKETS = ['naver', 'ohouse', 'coupang', 'coupang_stock'];
const MARKET_LABELS = {
  naver: '네이버',
  ohouse: '오늘의집',
  coupang: '쿠팡 판매지표',
  coupang_stock: '쿠팡 재고조회'
};
const COMPETITOR_MARKET_LABELS = {naver:'네이버', ohouse:'오늘의집', coupang:'쿠팡'};
let accessToken = '';
let appConfig = {};
let fetchLogData = [];
let selectedFetchLogId = '';
let selectedDashboardCompetitorIds = new Set();

async function initAuth() {
  accessToken = localStorage.getItem('naverMonitorAccessToken') || '';
  if (!accessToken) {
    location.href = '/login';
    throw new Error('login required');
  }
  window.fetch = authFetch;
}

async function refreshSession() {
  const refreshToken = localStorage.getItem('naverMonitorRefreshToken') || '';
  if (!refreshToken) return false;
  const res = await nativeFetch('/api/auth/refresh', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({refresh_token: refreshToken})
  });
  if (!res.ok) return false;
  const data = await res.json();
  if (!data.access_token) return false;
  localStorage.setItem('naverMonitorAccessToken', data.access_token);
  if (data.refresh_token) localStorage.setItem('naverMonitorRefreshToken', data.refresh_token);
  accessToken = data.access_token;
  return true;
}

async function authFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const isApi = url && (url.startsWith('/api/') || url.startsWith(location.origin + '/api/'));
  if (!isApi || url.includes('/api/auth-config')) return nativeFetch(input, init);

  accessToken = localStorage.getItem('naverMonitorAccessToken') || '';
  if (!accessToken) {
    location.href = '/login';
    throw new Error('login required');
  }

  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  let res = await nativeFetch(input, { ...init, headers });
  if (res.status === 401 && !url.includes('/api/auth/')) {
    const refreshed = await refreshSession();
    if (refreshed) {
      headers.set('Authorization', `Bearer ${accessToken}`);
      res = await nativeFetch(input, { ...init, headers });
    }
  }
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('naverMonitorAccessToken');
    localStorage.removeItem('naverMonitorRefreshToken');
    location.href = '/login';
  }
  return res;
}
// ─── State ───────────────────────────────────────────────────
let historyData = null;
let schedTimer = null;
let expandedRows = new Set();
let chartInstance = null;
let isAdminUser = false;
let extensionRequestSeq = 0;
let historyAutoRefreshTimer = null;
let historyAutoRefreshInFlight = false;
let extensionHistoryRefreshTimer = null;
let fetchProgressTimer = null;
let pendingFetch = null;
let fetchConsoleLines = [];
let fetchConsoleLastKey = '';
const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/%EB%84%A4%EC%9D%B4%EB%B2%84-%EA%B2%BD%EC%9F%81%EC%82%AC-%EB%AA%A8%EB%8B%88%ED%84%B0%EB%A7%81/bihcbfmkldglanbhabgaiiccnhfbnmfk';

function readCache(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function hydrateFromCache() {
  const cfg = readCache(CONFIG_CACHE_KEY);
  if (cfg && cfg.username) applyConfig(cfg);

  const cachedHistory = readCache(HISTORY_CACHE_KEY);
  const days = document.getElementById('days-select').value;
  if (cachedHistory && cachedHistory.days === days && cachedHistory.data) {
    historyData = cachedHistory.data;
    renderTable(historyData);
  }
}

// ─── KPI ─────────────────────────────────────────────────────
function snapshotDate(key) {
  const raw = String(key || '');
  return raw.includes(' ') ? raw.replace(' ', 'T') : raw + 'T00:00:00';
}

function snapshotLabel(key, compact = false) {
  const raw = String(key || '');
  if (!raw) return '—';
  const dt = new Date(snapshotDate(raw));
  const datePart = `${dt.getMonth()+1}/${dt.getDate()}`;
  const hasTime = raw.length > 10;
  if (!hasTime) return datePart;
  const timePart = raw.slice(11, 16);
  return compact ? `${datePart} ${timePart}` : `${datePart}<br>${timePart}`;
}

function productThumb(comp) {
  if (comp.image_url) {
    return `<img class="product-thumb" src="${escHtml(comp.image_url)}" alt="">`;
  }
  return '<span class="product-thumb placeholder">IMG</span>';
}

function snapshotDayKey(key) {
  return String(key || '').slice(0, 10);
}

function currentMinuteKey() {
  const dt = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function currentHistoryMode() {
  return localStorage.getItem(HISTORY_MODE_KEY) === 'time' ? 'time' : 'daily';
}

function showAllTimeColumns() {
  return localStorage.getItem(TIME_RANGE_KEY) === 'all';
}

function currentCoupangMode() {
  return currentMarket() === 'coupang_stock' ? 'stock' : 'sales';
}

function isCoupangMarket(market = currentMarket()) {
  return market === 'coupang' || market === 'coupang_stock';
}

function isCoupangStockMarket(market = currentMarket()) {
  return market === 'coupang_stock';
}

function currentFetchMode() {
  const market = currentMarket();
  if (market === 'coupang_stock') return 'coupang_stock';
  if (market === 'coupang') return 'coupang_sales';
  return '';
}

function syncCoupangModeButtons() {
  const isCoupang = false;
  const mode = currentCoupangMode();
  document.getElementById('coupang-mode-tabs')?.classList.toggle('visible', isCoupang);
  document.getElementById('coupang-mode-sales')?.classList.toggle('active', mode === 'sales');
  document.getElementById('coupang-mode-stock')?.classList.toggle('active', mode === 'stock');
}

function setCoupangMode(mode) {
  setMarket(mode === 'stock' ? 'coupang_stock' : 'coupang');
}

function syncHistoryModeButtons() {
  const mode = currentHistoryMode();
  document.getElementById('history-mode-daily')?.classList.toggle('active', mode === 'daily');
  document.getElementById('history-mode-time')?.classList.toggle('active', mode === 'time');
  syncTimeRangeToggle();
}

function syncTimeRangeToggle(totalColumns = null) {
  const btn = document.getElementById('time-range-toggle');
  if (!btn) return;
  const isTimeMode = currentHistoryMode() === 'time';
  const hasOverflow = totalColumns === null || totalColumns > TIME_COLUMN_LIMIT;
  btn.classList.toggle('visible', isTimeMode && hasOverflow);
  btn.textContent = showAllTimeColumns() ? '최근 10회만 보기' : '전체 시간 보기';
}

function setHistoryMode(mode) {
  localStorage.setItem(HISTORY_MODE_KEY, mode === 'time' ? 'time' : 'daily');
  syncHistoryModeButtons();
  renderTable(historyData);
}

function toggleTimeRange() {
  localStorage.setItem(TIME_RANGE_KEY, showAllTimeColumns() ? 'recent' : 'all');
  syncTimeRangeToggle();
  renderTable(historyData);
}

function historyModeLabel() {
  if (currentHistoryMode() !== 'time') return '일자별 최신 조회값 비교';
  return showAllTimeColumns() ? '시간별 전체 조회값 비교' : `시간별 최근 ${TIME_COLUMN_LIMIT}회 조회값 비교`;
}

function isCoupangSalesDay(day) {
  if (dayFetchMode(day) === 'coupang_stock') return false;
  return !!day && (
    day.error ||
    coupangMetricValue(day, 'views') !== null ||
    coupangMetricValue(day, 'monthly') !== null ||
    coupangMetricValue(day, 'conversion') !== null ||
    coupangMetricError(day, 'views') ||
    coupangMetricError(day, 'monthly') ||
    coupangMetricError(day, 'conversion')
  );
}

function isCoupangStockDay(day) {
  if (dayFetchMode(day) === 'coupang_sales') return false;
  return !!day && (
    day.error ||
    coupangMetricValue(day, 'stock') !== null ||
    coupangMetricError(day, 'stock')
  );
}

function isVisibleHistoryDay(comp, day) {
  if (!day) return false;
  if (competitorMarket(comp) !== 'coupang') return true;
  return isCoupangStockMarket() ? isCoupangStockDay(day) : isCoupangSalesDay(day);
}

function displayValueForDay(comp, day) {
  if (!day || day.error) return null;
  if (competitorMarket(comp) === 'coupang') {
    return isCoupangStockMarket()
      ? coupangMetricValue(day, 'stock')
      : coupangMetricValue(day, 'monthly');
  }
  return day.total !== null && day.total !== undefined ? Number(day.total) : null;
}

function metricDeltaForSortedDates(comp, sortedDates, index) {
  if (competitorMarket(comp) !== 'coupang') return null;
  const current = displayValueForDay(comp, comp.days[sortedDates[index]]);
  if (current === null) return null;
  for (let i = index + 1; i < sortedDates.length; i++) {
    const prev = displayValueForDay(comp, comp.days[sortedDates[i]]);
    if (prev !== null) return current - prev;
  }
  return null;
}

function toDailyHistory(data) {
  if (!data || !Array.isArray(data.dates)) return data;

  const dailyDates = [...new Set(data.dates.map(snapshotDayKey).filter(Boolean))].sort();
  const competitors = (data.competitors || []).map(comp => {
    const entry = {...comp, days: {}};
    let prevTotal = null;

    dailyDates.forEach(dayKey => {
      const keysForDay = data.dates
        .filter(key => snapshotDayKey(key) === dayKey)
        .sort();
      let latest = null;
      for (const key of keysForDay) {
        const row = comp.days ? comp.days[key] : null;
        if (row && isVisibleHistoryDay(comp, row)) latest = row;
      }

      if (!latest) {
        entry.days[dayKey] = null;
        return;
      }

      const total = displayValueForDay(comp, latest);
      const isCoupangDaily = competitorMarket(comp) === 'coupang';
      const sales = (total !== null && prevTotal !== null)
        ? (isCoupangDaily ? total - prevTotal : prevTotal - total)
        : null;
      entry.days[dayKey] = {
        ...latest,
        sales,
      };
      if (total !== null) prevTotal = total;
    });

    return entry;
  });

  return {
    ...data,
    dates: dailyDates,
    competitors,
  };
}

function getDisplayHistory(data) {
  if (!data) return data;
  const competitors = filterByCurrentMarket(data.competitors || []);
  const activeDateSet = new Set();
  let lastFetched = '';
  competitors.forEach(comp => {
    Object.entries(comp.days || {}).forEach(([key, day]) => {
      if (!isVisibleHistoryDay(comp, day)) return;
      activeDateSet.add(key);
      if (day.fetched_at && (!lastFetched || day.fetched_at > lastFetched)) {
        lastFetched = day.fetched_at;
      }
    });
  });
  const filtered = {
    ...data,
    dates: (data.dates || []).filter(key => activeDateSet.has(key)),
    competitors,
    last_fetched: lastFetched,
  };
  return currentHistoryMode() === 'time' ? filtered : toDailyHistory(filtered);
}

function renderKPIs(data) {
  const el = document.getElementById('kpi-grid');
  if (!el) return;
  const { dates, competitors } = data;
  if (!competitors.length) { el.style.display = 'none'; return; }

  const sortedDates = [...dates].sort();
  const latestDate = sortedDates[sortedDates.length - 1];
  const isCoupang = isCoupangMarket();
  const isCoupangStock = isCoupangStockMarket();

  const displayDates = sortedDates.slice().reverse();
  let totalSales = 0, restockCount = 0, errorCount = 0, successCount = 0;
  competitors.forEach(comp => {
    const day = comp.days[latestDate];
    if (!day) return;
    if (day.error) { errorCount++; return; }
    successCount++;
    let delta = day.sales;
    if (isCoupangStock) {
      const latestIndex = sortedDates.indexOf(latestDate);
      delta = metricDeltaForSortedDates(comp, sortedDates.slice().reverse(), sortedDates.length - 1 - latestIndex);
    }
    if (delta !== null) {
      if (isCoupangStock) {
        if (delta < 0) totalSales += Math.abs(delta);
        else if (delta > 0) restockCount++;
      } else {
        if (delta > 0) totalSales += delta;
        else if (delta < 0) restockCount++;
      }
    }
  });
  const successRate = competitors.length > 0 ? Math.round(successCount / competitors.length * 100) : 0;
  const dateLabel = latestDate ? snapshotLabel(latestDate, true) + ' 기준' : '—';

  el.style.display = 'grid';
  el.innerHTML = `
    <div class="kpi-card kpi-accent-green">
      <div class="kpi-label">모니터링 경쟁사</div>
      <div class="kpi-value">${competitors.length}<span style="font-size:14px;font-weight:500;color:var(--text3);margin-left:3px">개</span></div>
      <div class="kpi-sub">등록된 상품 수</div>
    </div>
    <div class="kpi-card kpi-accent-blue">
      <div class="kpi-label">${isCoupangStock ? '재고 감소 추정' : isCoupang ? '월판매량 변화' : '판매 추정'} (${dateLabel})</div>
      <div class="kpi-value blue">${totalSales.toLocaleString()}<span style="font-size:14px;font-weight:500;margin-left:3px">개</span></div>
      <div class="kpi-sub">${isCoupangStock ? '전회 대비 재고 추정 감소 합산' : isCoupang ? '전회 대비 월판매수량 증가 합산' : '전일 대비 재고 감소 합산'}</div>
    </div>
    <div class="kpi-card kpi-accent-amber">
      <div class="kpi-label">${isCoupangStock ? '재고 증가 감지' : isCoupang ? '월판매량 감소' : '재입고 감지'}</div>
      <div class="kpi-value amber">${restockCount}<span style="font-size:14px;font-weight:500;margin-left:3px">건</span></div>
      <div class="kpi-sub">${isCoupangStock ? '전회 대비 재고 추정이 증가한 상품 수' : isCoupang ? '전회 대비 월판매수량이 낮아진 상품 수' : '재고 증가 경쟁사 수'}</div>
    </div>
    <div class="kpi-card ${successRate >= 80 ? 'kpi-accent-green' : 'kpi-accent-red'}">
      <div class="kpi-label">조회 성공률</div>
      <div class="kpi-value ${successRate >= 80 ? 'green' : 'red'}">${successRate}<span style="font-size:14px;font-weight:500;margin-left:2px">%</span></div>
      <div class="kpi-sub">성공 ${successCount}건 · 오류 ${errorCount}건</div>
    </div>`;
}

// ─── Chart ───────────────────────────────────────────────────
const CHART_COLORS = ['#03c75a','#6366f1','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];

function renderChart(data, sortedDates) {
  const canvas = document.getElementById('stock-chart');
  const card = document.getElementById('chart-card');
  if (!canvas || !card) return;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const { competitors } = data;
  if (!competitors.length || sortedDates.length < 2) { card.style.display = 'none'; return; }
  card.style.display = '';

  const labels = sortedDates.map(d => snapshotLabel(d, true));

  const datasets = competitors.map((comp, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    return {
      label: comp.name,
      data: sortedDates.map(d => {
        const day = comp.days[d];
        return (day && !day.error) ? displayValueForDay(comp, day) : null;
      }),
      borderColor: color,
      backgroundColor: color + '18',
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBackgroundColor: color,
      tension: 0.35,
      fill: false,
      spanGaps: true,
    };
  });

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { size: 11, family: 'Inter' }, boxWidth: 10, padding: 14, usePointStyle: true }
        },
        tooltip: {
          backgroundColor: '#18181b',
          titleColor: '#a1a1aa',
          bodyColor: '#fafafa',
          padding: 10,
          cornerRadius: 6,
          titleFont: { size: 11 },
          bodyFont: { size: 12, family: 'JetBrains Mono' },
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y !== null ? ctx.parsed.y.toLocaleString() + '개' : '—'}`
          }
        }
      },
      scales: {
        x: { grid: { color: '#f4f4f5' }, ticks: { font: { size: 10, family: 'Inter' }, color: '#a1a1aa' }, border: { color: '#e4e4e7' } },
        y: { grid: { color: '#f4f4f5' }, ticks: { font: { size: 10, family: 'JetBrains Mono' }, color: '#a1a1aa' }, border: { color: '#e4e4e7' }, beginAtZero: false }
      }
    }
  });
}

// ─── Init ────────────────────────────────────────────────────
async function init() {
  await initAuth();
  syncHistoryModeButtons();
  syncMarketUI();
  hydrateFromCache();
  await Promise.all([loadHistory(), loadConfig()]);
}

function applyConfig(cfg) {
  appConfig = cfg || {};
  document.getElementById('user-info').innerHTML = `<strong>${escHtml(cfg.username)}</strong>로 로그인됨`;
  isAdminUser = !!cfg.is_admin;
  document.getElementById('nav-admin').style.display = isAdminUser ? '' : 'none';
  syncMarketUI();
  renderCompList(cfg.competitors || []);
  renderPlanStatus(cfg);
  renderCompetitorLimit(cfg);
  if (historyData && historyData.competitors) renderTable(historyData);

  if (cfg.schedule) {
    document.getElementById('sched-enabled').checked = cfg.schedule.enabled;
    document.getElementById('sched-hour').value = cfg.schedule.hour;
    document.getElementById('sched-min').value = cfg.schedule.minute;
    const markets = new Set(cfg.schedule.markets || ['naver', 'ohouse', 'coupang_stock']);
    document.getElementById('sched-market-naver').checked = markets.has('naver');
    document.getElementById('sched-market-ohouse').checked = markets.has('ohouse');
    document.getElementById('sched-market-coupang-stock').checked = markets.has('coupang_stock');
  }
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; return; }
    const cfg = await r.json();
    applyConfig(cfg);
    writeCache(CONFIG_CACHE_KEY, cfg);
  } catch (e) {
    console.error(e);
  }
}

// ─── Views ───────────────────────────────────────────────────
function showView(view) {
  if (view === 'admin' && !isAdminUser) view = 'dashboard';
  document.getElementById('view-dashboard').style.display = view === 'dashboard' ? '' : 'none';
  document.getElementById('view-settings').style.display = view === 'settings' ? '' : 'none';
  document.getElementById('view-logs').style.display = view === 'logs' ? '' : 'none';
  document.getElementById('view-admin').style.display = view === 'admin' ? '' : 'none';
  document.getElementById('nav-dashboard').className = 'nav-item' + (view === 'dashboard' ? ' active' : '');
  document.getElementById('nav-settings').className = 'nav-item' + (view === 'settings' ? ' active' : '');
  document.getElementById('nav-logs').className = 'nav-item' + (view === 'logs' ? ' active' : '');
  document.getElementById('nav-admin').className = 'nav-item' + (view === 'admin' ? ' active' : '');
  syncMarketUI();
  if (view === 'settings') {
    renderCompList(appConfig.competitors || []);
    renderCompetitorLimit(appConfig);
    renderPlanStatus(appConfig);
  }
  if (view === 'admin') {
    loadAdminUsers();
    loadAdminFetchLogs();
  }
  if (view === 'logs') {
    loadFetchLogs();
  }
}

// ─── History / Table ─────────────────────────────────────────
async function loadHistory(silent = false) {
  const days = document.getElementById('days-select').value;
  try {
    const r = await fetch(`/api/history?days=${days}`);
    if (r.status === 401) { location.href = '/login'; return; }
    historyData = await r.json();
    writeCache(HISTORY_CACHE_KEY, {days, data: historyData});
    renderTable(historyData);
  } catch (e) {
    if (!silent) showToast('데이터 로드 실패');
  }
}

function refreshHistoryFromExtension() {
  if (extensionHistoryRefreshTimer) clearTimeout(extensionHistoryRefreshTimer);
  extensionHistoryRefreshTimer = setTimeout(async () => {
    extensionHistoryRefreshTimer = null;
    pendingFetch = null;
    await loadHistory(true);
    showToast('조회 결과를 갱신했습니다');
  }, 250);
}

function beginPendingFetch(competitors, fetchMode = currentFetchMode(), market = currentMarket()) {
  pendingFetch = {
    key: currentMinuteKey(),
    ids: new Set((competitors || []).map(comp => comp.id)),
    market,
    fetchMode,
    results: {}
  };
  renderTable(historyData);
}

function clearPendingFetch() {
  pendingFetch = null;
  renderTable(historyData);
}

function isPendingCell(comp, dateKey) {
  return !!(
    pendingFetch &&
    pendingFetch.key === dateKey &&
    pendingFetch.market === currentMarket() &&
    pendingFetch.fetchMode === currentFetchMode() &&
    pendingFetch.ids &&
    pendingFetch.ids.has(comp.id)
  );
}

function pendingDayForCell(comp, dateKey) {
  if (!isPendingCell(comp, dateKey) || !pendingFetch || !pendingFetch.results) return null;
  const result = pendingFetch.results[comp.id];
  if (!result) return null;
  return {
    total: result.total ?? null,
    options: result.options || [],
    error: result.error || null,
    fetched_at: result.fetched_at || new Date().toISOString(),
    pending: true
  };
}

function loadingCell(extraClass = '') {
  return `<span class="cell-loading ${extraClass}" aria-label="조회 중"></span>`;
}

function resetFetchConsole() {
  fetchConsoleLines = [];
  fetchConsoleLastKey = '';
  const el = document.getElementById('fetch-console');
  if (el) el.innerHTML = '';
}

function formatConsoleTime() {
  const now = new Date();
  return now.toLocaleTimeString('ko-KR', {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

function pushFetchConsoleLine(text, tone = '') {
  const el = document.getElementById('fetch-console');
  if (!el || !text) return;
  const key = `${tone}:${text}`;
  if (key === fetchConsoleLastKey) return;
  fetchConsoleLastKey = key;
  fetchConsoleLines.push({ text, tone });
  if (fetchConsoleLines.length > 80) fetchConsoleLines = fetchConsoleLines.slice(-80);
  el.innerHTML = fetchConsoleLines.map(line => {
    const cls = line.tone ? ` ${line.tone}` : '';
    return `<span class="fetch-console-line${cls}">${escHtml(line.text)}</span>`;
  }).join('') + '<span class="fetch-console-line muted">&gt; <span class="fetch-console-cursor"></span></span>';
  el.scrollTop = el.scrollHeight;
}

function updateFetchConsole(status) {
  if (!status) return;
  const current = Number(status.current || 0);
  const total = Number(status.total || 0);
  const done = !status.running && (status.done || status.stopped);
  const prefix = `[${formatConsoleTime()}]`;
  if (!fetchConsoleLines.length) {
    pushFetchConsoleLine(`${prefix} fetch session opened`, 'muted');
  }
  const item = status.name ? ` ${status.name}` : '';
  const count = total ? ` (${Math.min(current, total)}/${total})` : '';
  const msg = status.msg || (done ? '조회 완료' : '상품 데이터를 수집하고 있습니다');
  pushFetchConsoleLine(`${prefix}${count}${item} :: ${msg}`, done ? 'ok' : '');
  if (Array.isArray(status.results)) {
    status.results.slice(-3).forEach(result => {
      if (!result || !result.id) return;
      if (result.error) {
        pushFetchConsoleLine(`${prefix} result ${result.name || result.id} :: ERROR ${shortErrorMessage(result.error)}`, 'err');
      } else if (result.total !== undefined && result.total !== null) {
        pushFetchConsoleLine(`${prefix} result ${result.name || result.id} :: stock=${Number(result.total).toLocaleString()}`, 'ok');
      }
    });
  }
}

function updateFetchProgress(status) {
  const box = document.getElementById('fetch-progress');
  if (!box) return;
  if (fetchProgressTimer) {
    clearTimeout(fetchProgressTimer);
    fetchProgressTimer = null;
  }
  if (!status) {
    box.classList.remove('show');
    resetFetchConsole();
    return;
  }

  const current = Number(status.current || 0);
  const total = Number(status.total || 0);
  const pct = total > 0 ? Math.max(4, Math.min(100, Math.round(current / total * 100))) : 4;
  const done = !status.running && (status.done || status.stopped);
  document.getElementById('fetch-progress-title').textContent = status.name || (done ? '조회 완료' : '조회 진행 중');
  document.getElementById('fetch-progress-count').textContent = total ? `${Math.min(current, total)}/${total}` : '준비 중';
  document.getElementById('fetch-progress-fill').style.width = done ? '100%' : `${pct}%`;
  document.getElementById('fetch-progress-msg').textContent = status.msg || (done ? '결과를 갱신하는 중입니다' : '상품 데이터를 수집하고 있습니다');
  box.classList.add('show');
  updateFetchConsole(status);

  if (pendingFetch && Array.isArray(status.results)) {
    let changed = false;
    status.results.forEach(result => {
      if (!result || !result.id || !pendingFetch.ids || !pendingFetch.ids.has(result.id)) return;
      const prev = pendingFetch.results[result.id];
      const nextKey = JSON.stringify({
        total: result.total ?? null,
        error: result.error || null,
        options: result.options || []
      });
      const prevKey = prev ? JSON.stringify({
        total: prev.total ?? null,
        error: prev.error || null,
        options: prev.options || []
      }) : '';
      if (nextKey !== prevKey) {
        pendingFetch.results[result.id] = result;
        changed = true;
      }
    });
    if (changed) renderTable(historyData);
  }

  if (done) {
    fetchProgressTimer = setTimeout(() => box.classList.remove('show'), 5500);
  }
}

window.addEventListener('message', event => {
  if (event.source !== window) return;
  const msg = event.data || {};
  if (msg.source === 'naver-monitor-extension' && msg.type === 'FETCH_STATUS') {
    updateFetchProgress(msg.status);
  }
  if (msg.source === 'naver-monitor-extension' && msg.type === 'HISTORY_UPDATED') {
    refreshHistoryFromExtension();
  }
});

function startHistoryAutoRefresh(expectedCount = 1) {
  if (historyAutoRefreshTimer) {
    clearTimeout(historyAutoRefreshTimer);
    historyAutoRefreshTimer = null;
  }

  const maxMs = Math.min(10 * 60 * 1000, Math.max(90 * 1000, expectedCount * 55 * 1000 + 20 * 1000));
  const endAt = Date.now() + maxMs;
  // 확장이 HISTORY_UPDATED 이벤트를 보내주므로 폴링은 안전망 역할만 한다.
  // 고정 5초 대신 5→10→20→30초로 점증시켜 서버 부하를 줄임
  let intervalMs = 5000;

  async function refreshOnce() {
    if (historyAutoRefreshInFlight) return;
    historyAutoRefreshInFlight = true;
    try {
      await loadHistory(true);
    } finally {
      historyAutoRefreshInFlight = false;
      if (Date.now() < endAt) {
        intervalMs = Math.min(intervalMs * 2, 30000);
        historyAutoRefreshTimer = setTimeout(refreshOnce, intervalMs);
      } else {
        historyAutoRefreshTimer = null;
      }
    }
  }

  historyAutoRefreshTimer = setTimeout(refreshOnce, 3500);
}

function renderTable(data) {
  if (!data) return;
  data = getDisplayHistory(data);
  const wrap = document.getElementById('table-wrap');
  const { dates, competitors } = data;
  const label = marketLabel();

  if (data.last_fetched) {
    const dt = new Date(data.last_fetched);
    document.getElementById('last-updated').textContent =
      `마지막 조회: ${dt.toLocaleDateString('ko-KR')} ${dt.toLocaleTimeString('ko-KR', {hour:'2-digit',minute:'2-digit'})}`;
  } else {
    document.getElementById('last-updated').textContent = '마지막 조회: —';
  }

  document.getElementById('monitor-count').textContent = `${label} 경쟁사 ${competitors.length}명`;
  document.getElementById('monitor-mode-label').textContent =
    isCoupangMarket()
      ? `${isCoupangStockMarket() ? '재고 조회' : '판매 지표'} · ${historyModeLabel()}`
      : historyModeLabel();
  pruneDashboardSelection();
  updateSelectedStockFetchButton();
  renderKPIs(data);

  if (competitors.length === 0) {
    wrap.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">🔍</div>
      <div class="empty-state-title">${label} 경쟁사를 추가해주세요</div>
      <div class="empty-state-desc">설정에서 모니터링할 ${label} 상품 URL을 추가하세요</div>
    </div>`;
    return;
  }

  let sortedDates = [...dates].sort().reverse();
  if (document.getElementById('hide-fail-cols').checked) {
    sortedDates = sortedDates.filter(d =>
      competitors.some(comp => {
        const day = comp.days[d];
        return day && !day.error && displayValueForDay(comp, day) !== null;
      })
    );
  }
  if (pendingFetch && pendingFetch.market === currentMarket() && pendingFetch.fetchMode === currentFetchMode() && !sortedDates.includes(pendingFetch.key)) {
    sortedDates.unshift(pendingFetch.key);
  }
  const totalTimeColumns = sortedDates.length;
  if (currentHistoryMode() === 'time' && !showAllTimeColumns()) {
    sortedDates = sortedDates.slice(0, TIME_COLUMN_LIMIT);
  }
  syncTimeRangeToggle(totalTimeColumns);

  const dateColTpl = sortedDates.length ? `repeat(${sortedDates.length}, minmax(112px, 124px))` : '';
  const colTpl = `310px ${dateColTpl} 92px`;
  let html = `<div class="monitor-wrap">`;
  const canReorderRows = competitors.length > 1;

  // Header row
  html += `<div class="m-row m-head" style="grid-template-columns:${colTpl}">`;
  const selectionEnabled = dashboardSelectionEnabled();
  const selectableIds = visibleSelectableDashboardCompetitors().map(comp => comp.id);
  const selectedVisibleCount = selectableIds.filter(id => selectedDashboardCompetitorIds.has(id)).length;
  const selectAllHtml = selectionEnabled
    ? `<label class="dashboard-select-wrap" onclick="event.stopPropagation()" title="보이는 상품 전체 선택"><input id="dashboard-select-all" type="checkbox" ${selectableIds.length && selectedVisibleCount === selectableIds.length ? 'checked' : ''} onchange="setDashboardSelectionForVisible(this.checked)"></label>`
    : '';
  html += `<div class="monitor-head-product">${selectAllHtml}<span>URL 바로가기 / ${label} 상품명</span></div>`;
  sortedDates.forEach(d => {
    const dt = new Date(snapshotDate(d));
    const dow = ['일','월','화','수','목','금','토'][dt.getDay()];
    html += `<div class="date-cell"><div class="d-label">${snapshotLabel(d)}<br>${dow}</div><div></div></div>`;
  });
  html += `<div style="text-align:center">조회</div></div>`;

  // Data rows
  competitors.forEach(comp => {
    const isExpanded = expandedRows.has(comp.id);
    const rowCheckHtml = selectionEnabled && competitorMarket(comp) === 'coupang' && isCompetitorFetchAllowed(comp.id)
      ? `<label class="dashboard-select-wrap" onclick="event.stopPropagation()" title="선택 재고조회 대상"><input class="dashboard-row-check" type="checkbox" data-cid="${escHtml(comp.id)}" ${selectedDashboardCompetitorIds.has(comp.id) ? 'checked' : ''} onchange="toggleDashboardSelection('${escJsAttr(comp.id)}', this.checked)"></label>`
      : '';
    html += `<div class="m-row monitor-product-row${isExpanded ? ' m-expanded' : ''}" data-cid="${comp.id}" draggable="false" style="grid-template-columns:${colTpl}" onclick="toggleExpand('${comp.id}')">`;
    html += `<div class="biz-name"><div class="biz-cell">
      ${rowCheckHtml}
      <button class="comp-drag-handle monitor-drag-handle" type="button" draggable="false" ${canReorderRows ? '' : 'disabled'} onclick="event.stopPropagation()" title="${canReorderRows ? '드래그해서 순서 변경' : '순서를 바꿀 상품이 2개 이상 필요합니다'}" aria-label="순서 변경">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg>
      </button>
      <button class="product-link-btn" type="button" onclick="event.stopPropagation(); window.open('${escJsAttr(comp.url)}','_blank')" title="${label} 상품 페이지 열기" aria-label="${label} 상품 페이지 열기">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6.5 3H3.8A1.8 1.8 0 002 4.8v7.4A1.8 1.8 0 003.8 14h7.4a1.8 1.8 0 001.8-1.8V9.5"/><path d="M9 2h5v5"/><path d="M8 8l6-6"/></svg>
      </button>
      ${productThumb(comp)}<div class="biz-cell-main"><span class="biz-dot"></span>${escHtml(comp.name)}<span class="expand-arr">▾</span></div></div></div>`;

    sortedDates.forEach((d, dateIndex) => {
      const day = comp.days[d] || pendingDayForCell(comp, d);
      if (!day && isPendingCell(comp, d)) {
        html += `<div class="date-cell"><div class="d-num">${loadingCell()}</div><div></div></div>`;
      } else if (!day) {
        html += `<div class="date-cell"><div class="d-num mute">—</div><div></div></div>`;
      } else if (day.error) {
        html += `<div class="date-cell"><div class="d-num err" title="${escHtml(day.error)}">실패</div><div class="d-error" title="${escHtml(day.error)}">${escHtml(shortErrorMessage(day.error))}</div></div>`;
      } else {
        const total = displayValueForDay(comp, day);
        const metricDelta = metricDeltaForSortedDates(comp, sortedDates, dateIndex);
        const sales = metricDelta !== null ? metricDelta : day.sales;
        let deltaHtml = '';
        const isCoupangRow = competitorMarket(comp) === 'coupang';
        const isCoupangStock = isCoupangRow && isCoupangStockMarket();
        let totalStr = total !== null ? total.toLocaleString() : '—';
        let cellTitle = '';
        if (total === null && isCoupangStock) {
          // 조회는 성공했지만 추정 한계(5000+/경계 미발견)인 경우 빈칸 대신 라벨 표시
          const limitText = coupangMetricError(day, 'stock');
          if (limitText) {
            totalStr = '5000+';
            cellTitle = '재고 추정 한계 — 실제 재고가 5000개 이상이거나, 로켓배송 등으로 수량 경계가 노출되지 않는 상품입니다';
          }
        }
        if (isCoupangStock) {
          if (sales !== null && sales > 0) {
            deltaHtml = `<div class="d-delta" style="color:#2563EB">[+${sales.toLocaleString()}]</div>`;
          } else if (sales !== null && sales < 0) {
            deltaHtml = `<div class="d-delta">[${sales.toLocaleString()}]</div>`;
          }
        } else if (sales !== null && sales > 0 && isCoupangRow) {
          deltaHtml = `<div class="d-delta" style="color:#2563EB">[+${sales.toLocaleString()}]</div>`;
        } else if (sales !== null && sales > 0) {
          deltaHtml = `<div class="d-delta">[-${sales.toLocaleString()}]</div>`;
        } else if (sales !== null && sales < 0 && isCoupangRow) {
          deltaHtml = `<div class="d-delta">[${sales.toLocaleString()}]</div>`;
        } else if (sales !== null && sales < 0) {
          deltaHtml = `<div class="d-delta" style="color:#2563EB">[+${Math.abs(sales).toLocaleString()}]</div>`;
        }
        html += `<div class="date-cell"><div class="d-num${cellTitle ? ' mute' : ''}"${cellTitle ? ` title="${escHtml(cellTitle)}"` : ''}>${totalStr}</div>${deltaHtml}</div>`;
      }
    });

    const canFetch = isCompetitorFetchAllowed(comp.id);
    const isCoupangRow = competitorMarket(comp) === 'coupang';
    const singleFetchMode = isCoupangRow ? (isCoupangStockMarket() ? 'coupang_stock' : 'coupang_sales') : currentFetchMode();
    const singleFetchMarket = singleFetchMode === 'coupang_stock' ? 'coupang_stock' : (singleFetchMode === 'coupang_sales' ? 'coupang' : currentMarket());
    const singleFetchLabel = isCoupangRow && singleFetchMode === 'coupang_stock' ? '재고조회' : '선택상품조회';
    html += `<div class="m-action" onclick="event.stopPropagation()">
      <button class="btn btn-sm ${canFetch ? '' : 'btn-primary'}" onclick="fetchSingle('${escJsAttr(comp.id)}','${escJsAttr(comp.name)}','${singleFetchMode}','${singleFetchMarket}')" title="${canFetch ? '이 상품만 조회' : '현재 플랜 한도 밖 상품입니다'}">${canFetch ? singleFetchLabel : '연장/업그레이드'}</button>
    </div></div>`;

    html += `<div class="m-detail${isExpanded ? ' open' : ''}" id="opt-${comp.id}">${
      competitorMarket(comp) === 'coupang'
        ? renderCoupangMetricsDetailGrid(comp, sortedDates, colTpl)
        : renderOptionsDetailGrid(comp, sortedDates, colTpl)
    }</div>`;
  });

  html += `</div>`;
  wrap.innerHTML = html;
  setupMonitorDragSort(canReorderRows);
  updateSelectedStockFetchButton();
}

function renderOptionsDetailGrid(comp, sortedDates, colTpl) {
  const optionNames = new Set();
  sortedDates.forEach(d => {
    const day = comp.days[d] || pendingDayForCell(comp, d);
    if (day && day.options) {
      day.options.forEach(o => {
        if (o && o.name && !String(o.name).startsWith('__')) optionNames.add(o.name);
      });
    }
  });

  if (optionNames.size === 0) {
    return '<div style="color:var(--text3);font-size:12px;padding:12px 20px">옵션 데이터 없음</div>';
  }

  let html = '';

  // Options sub-header
  html += `<div class="m-row m-opt-head" style="grid-template-columns:${colTpl}">`;
  html += `<div style="padding-left:20px">옵션명</div>`;
  sortedDates.forEach(d => {
    html += `<div class="date-cell"><div class="d-label">${snapshotLabel(d)}</div><div></div></div>`;
  });
  html += `<div></div></div>`;

  // Option name rows
  optionNames.forEach(name => {
    html += `<div class="m-row m-opt-row" style="grid-template-columns:${colTpl}">`;
    html += `<div class="opt-name">${escHtml(name)}</div>`;
    sortedDates.forEach((d, i) => {
      const day = comp.days[d];
      let qty = null;
      if (day && day.options) {
        const opt = day.options.find(o => o.name === name);
        if (opt != null) qty = opt.qty;
      }
      let deltaHtml = '';
      if (!day && isPendingCell(comp, d)) {
        html += `<div class="date-cell"><div class="d-num">${loadingCell('small')}</div><div></div></div>`;
        return;
      }
      if (qty !== null) {
        for (let j = i + 1; j < sortedDates.length; j++) {
          const prevDay = comp.days[sortedDates[j]];
          if (prevDay && !prevDay.error && prevDay.options) {
            const prevOpt = prevDay.options.find(o => o.name === name);
            if (prevOpt != null) {
              const delta = qty - prevOpt.qty;
              if (delta < 0) {
                deltaHtml = `<div class="d-delta">[-${Math.abs(delta)}]</div>`;
              } else if (delta > 0) {
                deltaHtml = `<div class="d-delta" style="color:#2563EB">[+${delta}]</div>`;
              }
              break;
            }
          }
        }
      }
      html += `<div class="date-cell"><div class="d-num${qty === null ? ' mute' : ''}">${qty !== null ? qty.toLocaleString() : '—'}</div>${deltaHtml}</div>`;
    });
    html += `<div></div></div>`;
  });

  // Total row
  html += `<div class="m-row m-opt-row m-opt-total" style="grid-template-columns:${colTpl}">`;
  html += `<div class="opt-name">합계</div>`;
  sortedDates.forEach(d => {
    const day = comp.days[d];
    const total = day && day.total !== null ? day.total.toLocaleString() : '—';
    html += `<div class="date-cell"><div class="d-num">${total}</div><div></div></div>`;
  });
  html += `<div></div></div>`;

  return html;
}

function getCoupangOptionValue(day, aliases) {
  if (!day || !Array.isArray(day.options)) return null;
  const opt = day.options.find(o => aliases.includes(o.name));
  if (opt == null || opt.qty == null) return null;
  const value = Number(opt.qty);
  return Number.isFinite(value) ? value : null;
}

function dayFetchMode(day) {
  if (!day || !Array.isArray(day.options)) return '';
  const opt = day.options.find(o => o.name === '__fetch_mode');
  return opt && opt.text ? String(opt.text) : '';
}

function coupangMetricValue(day, metric) {
  if (!day || day.error) return null;
  if (metric === 'stock') {
    return getCoupangOptionValue(day, ['재고 추정', '주문 가능 수량']);
  }
  if (metric === 'views') {
    return getCoupangOptionValue(day, ['조회수', '조회수(최근 28일)']);
  }
  if (metric === 'monthly') {
    const optionValue = getCoupangOptionValue(day, ['월판매수량', '월간 구매 신호', '한 달간 구매 추정']);
    if (optionValue !== null) return optionValue;
    return day.total !== null && day.total !== undefined ? Number(day.total) : null;
  }
  if (metric === 'conversion') {
    const optionValue = getCoupangOptionValue(day, ['전환율']);
    if (optionValue !== null) return optionValue;
    const views = coupangMetricValue(day, 'views');
    const monthly = coupangMetricValue(day, 'monthly');
    if (!views || monthly === null) return null;
    return Number(((monthly / views) * 100).toFixed(2));
  }
  if (metric === 'price') {
    return getCoupangOptionValue(day, ['판매가', '판매가격']);
  }
  if (metric === 'reviews') {
    return getCoupangOptionValue(day, ['리뷰수', '상품평수']);
  }
  return null;
}

function previousCoupangMetricValue(comp, sortedDates, index, metric) {
  for (let i = index + 1; i < sortedDates.length; i++) {
    const prev = coupangMetricValue(comp.days[sortedDates[i]], metric);
    if (prev !== null) return prev;
  }
  return null;
}

function coupangMetricValueForCell(comp, sortedDates, index, metric) {
  const day = comp.days[sortedDates[index]] || pendingDayForCell(comp, sortedDates[index]);
  if (metric === 'reviewDelta') {
    const current = coupangMetricValue(day, 'reviews');
    const prev = previousCoupangMetricValue(comp, sortedDates, index, 'reviews');
    return current !== null && prev !== null ? current - prev : null;
  }
  if (metric === 'soldEstimate' || metric === 'revenueEstimate') {
    const currentStock = coupangMetricValue(day, 'stock');
    const prevStock = previousCoupangMetricValue(comp, sortedDates, index, 'stock');
    if (currentStock === null || prevStock === null) return null;
    const sold = Math.max(prevStock - currentStock, 0);
    if (metric === 'soldEstimate') return sold;
    const price = coupangMetricValue(day, 'price');
    return price !== null ? sold * price : null;
  }
  return coupangMetricValue(day, metric);
}

function coupangMetricError(day, metric) {
  if (!day || !Array.isArray(day.options)) return '';
  const names = metric === 'stock'
    ? ['재고 추정 오류']
    : metric === 'monthly'
    ? ['월판매수량 오류']
    : metric === 'conversion'
      ? ['전환율 오류']
      : ['조회수 오류'];
  const opt = day.options.find(o => names.includes(o.name));
  return opt && opt.text ? String(opt.text) : '';
}

function formatCoupangMetric(value, metric) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  if (metric === 'price' || metric === 'revenueEstimate') return `${Number(value).toLocaleString()}원`;
  if (metric === 'reviewDelta') {
    if (Number(value) > 0) return `+${Number(value).toLocaleString()}`;
    return Number(value).toLocaleString();
  }
  if (metric === 'conversion') return `${Number(value).toFixed(2)}%`;
  return Number(value).toLocaleString();
}

function renderCoupangMetricsDetailGrid(comp, sortedDates, colTpl) {
  const rows = isCoupangStockMarket()
    ? [
      { key: 'price', label: '판매가' },
      { key: 'reviews', label: '리뷰수' },
      { key: 'reviewDelta', label: '리뷰 증가' },
      { key: 'revenueEstimate', label: '추정 매출' },
    ]
    : [
      { key: 'views', label: '조회수' },
      { key: 'monthly', label: '월판매수량' },
      { key: 'conversion', label: '전환율' },
      { key: 'price', label: '판매가' },
      { key: 'reviews', label: '리뷰수' },
    ];

  let hasData = false;
  sortedDates.forEach(d => {
    const day = comp.days[d] || pendingDayForCell(comp, d);
    rows.forEach(row => {
      const index = sortedDates.indexOf(d);
      if (coupangMetricValueForCell(comp, sortedDates, index, row.key) !== null || coupangMetricError(day, row.key)) hasData = true;
    });
  });
  if (!hasData) {
    return `<div style="color:var(--text3);font-size:12px;padding:12px 20px">${isCoupangStockMarket() ? '쿠팡 재고 조회 데이터 없음' : '쿠팡 판매 지표 데이터 없음'}</div>`;
  }

  let html = '';
  html += `<div class="m-row m-opt-head" style="grid-template-columns:${colTpl}">`;
  html += `<div style="padding-left:20px">지표</div>`;
  sortedDates.forEach(d => {
    html += `<div class="date-cell"><div class="d-label">${snapshotLabel(d)}</div><div></div></div>`;
  });
  html += `<div></div></div>`;

  rows.forEach(row => {
    html += `<div class="m-row m-opt-row" style="grid-template-columns:${colTpl}">`;
    html += `<div class="opt-name">${row.label}</div>`;
    sortedDates.forEach(d => {
      const day = comp.days[d] || pendingDayForCell(comp, d);
      if (!day && isPendingCell(comp, d)) {
        html += `<div class="date-cell"><div class="d-num">${loadingCell('small')}</div><div></div></div>`;
        return;
      }
      const value = coupangMetricValueForCell(comp, sortedDates, sortedDates.indexOf(d), row.key);
      const err = coupangMetricError(day, row.key);
      if (err) {
        html += `<div class="date-cell"><div class="d-num err" title="${escHtml(err)}">실패</div><div class="d-error" title="${escHtml(err)}">${escHtml(shortErrorMessage(err))}</div></div>`;
      } else {
        html += `<div class="date-cell"><div class="d-num${value === null ? ' mute' : ''}">${formatCoupangMetric(value, row.key)}</div><div></div></div>`;
      }
    });
    html += `<div></div></div>`;
  });

  return html;
}

function toggleExpand(cid) {
  if (expandedRows.has(cid)) {
    expandedRows.delete(cid);
  } else {
    expandedRows.add(cid);
  }
  const expanded = expandedRows.has(cid);
  const compRow = document.querySelector(`.m-row[data-cid="${cid}"]`);
  const detailRow = document.getElementById(`opt-${cid}`);
  if (compRow) compRow.classList.toggle('m-expanded', expanded);
  if (detailRow) detailRow.classList.toggle('open', expanded);
}

// ─── Fetch ───────────────────────────────────────────────────
function latestCoupangStockForComp(comp) {
  if (competitorMarket(comp) !== 'coupang') return null;
  const keys = Object.keys(comp.days || {}).sort().reverse();
  for (const key of keys) {
    const day = comp.days[key];
    if (!day || day.error) continue;
    const mode = dayFetchMode(day);
    if (mode && mode !== 'coupang_stock') continue;
    const value = coupangMetricValue(day, 'stock');
    if (value !== null && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function getDashboardCompetitors() {
  return ((historyData && historyData.competitors) || [])
    .filter(comp => isCompInCurrentMarket(comp))
    .map(comp => ({
      id: comp.id,
      name: comp.name,
      url: comp.url,
      expectedStock: latestCoupangStockForComp(comp)
    }))
    .filter(comp => comp.id && comp.url);
}

function syncMarketUI() {
  const market = currentMarket();
  document.getElementById('nav-market-naver')?.classList.toggle('active', market === 'naver');
  document.getElementById('nav-market-ohouse')?.classList.toggle('active', market === 'ohouse');
  document.getElementById('nav-market-coupang')?.classList.toggle('active', market === 'coupang');
  document.getElementById('nav-market-coupang-stock')?.classList.toggle('active', market === 'coupang_stock');
  syncCoupangModeButtons();
  const title = document.querySelector('#view-dashboard .topbar-title');
  const titleText = isCoupangMarket(market)
    ? (isCoupangStockMarket(market) ? '쿠팡 재고조회 현황' : '쿠팡 판매지표 현황')
    : `${marketLabel()} 재고 현황`;
  if (title) {
    const version = appConfig && appConfig.app_version ? `v${appConfig.app_version}` : '';
    title.innerHTML = `${escHtml(titleText)}${version ? ` <span class="app-version-badge">${escHtml(version)}</span>` : ''}`;
  }
  const fetchBtnLabel = document.getElementById('fetch-btn-label');
  if (fetchBtnLabel) {
    fetchBtnLabel.textContent = isCoupangStockMarket(market) ? '재고 조회' : '전체 조회';
  }
  updateSelectedStockFetchButton();
  const urlInput = document.getElementById('new-comp-url');
  if (urlInput) {
    urlInput.placeholder = market === 'ohouse'
      ? '오늘의집 상품 URL (https://store.ohou.se/goods/...)'
      : isCoupangMarket(market)
        ? '쿠팡 상품 URL (https://www.coupang.com/vp/products/...)'
        : '스마트스토어 상품 URL (https://smartstore.naver.com/...)';
  }
}

function setMarket(market) {
  localStorage.setItem(MARKET_KEY, MARKETS.includes(market) ? market : 'naver');
  showView('dashboard');
  syncMarketUI();
  renderCompList(appConfig.competitors || []);
  renderCompetitorLimit(appConfig);
  renderPlanStatus(appConfig);
  renderTable(historyData);
}

function competitorMarket(comp) {
  if (comp && ['naver', 'ohouse', 'coupang'].includes(comp.market)) return comp.market;
  const url = String((comp && comp.url) || '').toLowerCase();
  if (url.includes('store.ohou.se/goods/')) return 'ohouse';
  if (url.includes('coupang.com/') && url.includes('/products/')) return 'coupang';
  return 'naver';
}

function coupangUrlVendorWarning(url) {
  const value = String(url || '').trim();
  if (!/coupang\.com\/(?:v[pm]\/)?products\/\d+/i.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.get('itemId') && parsed.searchParams.get('vendorItemId')) return '';
  } catch (e) {
    return '';
  }
  return '쿠팡 재고조회는 itemId와 vendorItemId가 포함된 상품 URL을 등록해야 합니다. 쿠팡 상품 페이지에서 옵션을 선택한 뒤 주소창의 전체 URL을 복사해 주세요.';
}

function currentMarket() {
  const market = localStorage.getItem(MARKET_KEY);
  return MARKETS.includes(market) ? market : 'naver';
}

function marketLabel() {
  return MARKET_LABELS[currentMarket()] || '네이버';
}

function isCompInCurrentMarket(comp) {
  const market = currentMarket();
  const compMarket = competitorMarket(comp);
  if (isCoupangMarket(market)) return compMarket === 'coupang';
  return compMarket === market;
}

function filterByCurrentMarket(competitors) {
  return (competitors || []).filter(isCompInCurrentMarket);
}

function currentCompFilter() {
  const saved = localStorage.getItem(COMP_FILTER_KEY);
  if (['all', 'naver', 'ohouse', 'coupang'].includes(saved)) return saved;
  const market = currentMarket();
  return isCoupangMarket(market) ? 'coupang' : market;
}

function setCompFilter(filter) {
  localStorage.setItem(COMP_FILTER_KEY, filter);
  renderCompList(appConfig.competitors || []);
}

function compFilterLabel(filter) {
  return filter === 'all' ? '전체' : (COMPETITOR_MARKET_LABELS[filter] || filter);
}

function getActiveCompetitorIdSet() {
  if (Array.isArray(appConfig.active_competitor_ids)) {
    return new Set(appConfig.active_competitor_ids);
  }
  const competitors = appConfig.competitors || [];
  const limit = appConfig.competitor_limit;
  if (limit === null || limit === undefined) {
    return new Set(competitors.map(comp => comp.id));
  }
  return new Set(competitors.slice(0, limit).map(comp => comp.id));
}

function isCompetitorFetchAllowed(cid) {
  const activeIds = getActiveCompetitorIdSet();
  return activeIds.size === 0 || activeIds.has(cid);
}

function getFetchableDashboardCompetitors() {
  const activeIds = getActiveCompetitorIdSet();
  return getDashboardCompetitors().filter(comp => activeIds.size === 0 || activeIds.has(comp.id));
}

function dashboardSelectionEnabled() {
  return isCoupangStockMarket();
}

function visibleSelectableDashboardCompetitors() {
  if (!dashboardSelectionEnabled()) return [];
  return getFetchableDashboardCompetitors().filter(comp => competitorMarket(comp) === 'coupang');
}

function pruneDashboardSelection() {
  const valid = new Set(visibleSelectableDashboardCompetitors().map(comp => comp.id));
  selectedDashboardCompetitorIds = new Set([...selectedDashboardCompetitorIds].filter(id => valid.has(id)));
}

function updateSelectedStockFetchButton() {
  const btn = document.getElementById('selected-stock-fetch-btn');
  if (!btn) return;
  const enabled = dashboardSelectionEnabled();
  btn.style.display = enabled ? '' : 'none';
  if (!enabled) {
    selectedDashboardCompetitorIds.clear();
    btn.disabled = true;
    btn.textContent = '선택 재고조회';
    return;
  }
  pruneDashboardSelection();
  const count = selectedDashboardCompetitorIds.size;
  btn.disabled = count === 0;
  btn.textContent = count ? `선택 ${count}개 재고조회` : '선택 재고조회';

  const visibleIds = visibleSelectableDashboardCompetitors().map(comp => comp.id);
  const allBox = document.getElementById('dashboard-select-all');
  if (allBox) {
    const checkedCount = visibleIds.filter(id => selectedDashboardCompetitorIds.has(id)).length;
    allBox.checked = visibleIds.length > 0 && checkedCount === visibleIds.length;
    allBox.indeterminate = checkedCount > 0 && checkedCount < visibleIds.length;
  }
}

function toggleDashboardSelection(cid, checked) {
  if (checked) selectedDashboardCompetitorIds.add(cid);
  else selectedDashboardCompetitorIds.delete(cid);
  updateSelectedStockFetchButton();
}

function setDashboardSelectionForVisible(checked) {
  visibleSelectableDashboardCompetitors().forEach(comp => {
    if (checked) selectedDashboardCompetitorIds.add(comp.id);
    else selectedDashboardCompetitorIds.delete(comp.id);
  });
  document.querySelectorAll('.dashboard-row-check').forEach(input => {
    input.checked = checked && selectedDashboardCompetitorIds.has(input.dataset.cid);
  });
  updateSelectedStockFetchButton();
}

function requestExtensionFetch(competitors, fetchMode = currentFetchMode(), market = currentMarket()) {
  return new Promise((resolve, reject) => {
    const requestId = `fetch-${Date.now()}-${++extensionRequestSeq}`;
    const auth = {
      serverUrl: location.origin,
      accessToken: localStorage.getItem('naverMonitorAccessToken') || '',
      refreshToken: localStorage.getItem('naverMonitorRefreshToken') || '',
      loginEmail: (appConfig && appConfig.username) || ''
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('확장 프로그램 연결을 확인할 수 없습니다.'));
    }, 5200);

    function onMessage(event) {
      if (event.source !== window) return;
      const msg = event.data || {};
      if (msg.source !== 'naver-monitor-extension' || msg.type !== 'START_FETCH_RESULT' || msg.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (isCoupangFetchMode(fetchMode) && !isExtensionVersionAtLeast(msg.version, REQUIRED_COUPANG_EXTENSION_VERSION)) {
        const err = new Error(`확장 프로그램 v${REQUIRED_COUPANG_EXTENSION_VERSION} 업데이트가 필요합니다. 현재 설치된 확장 프로그램이 구버전이라 쿠팡 조회를 중단했습니다.`);
        err.noQueue = true;
        reject(err);
        return;
      }
      if (msg.ok) resolve(msg);
      else reject(new Error(msg.error || '확장 프로그램에서 조회를 시작하지 못했습니다.'));
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'naver-monitor-dashboard',
      type: 'START_FETCH',
      requestId,
      auth,
      competitors,
      fetchMode,
      market,
      coupangMode: fetchMode === 'coupang_stock' ? 'stock' : (fetchMode === 'coupang_sales' ? 'sales' : currentCoupangMode())
    }, '*');
  });
}

function isCoupangFetchMode(fetchMode) {
  return ['coupang_stock', 'coupang_sales', 'stock', 'sales'].includes(String(fetchMode || '').toLowerCase());
}

function shouldWarnCoupangLogin(fetchMode, market = currentMarket()) {
  return isCoupangFetchMode(fetchMode) || isCoupangMarket(market);
}

let coupangLoginResolve = null;

function openCoupangLoginUrl() {
  window.open(COUPANG_LOGIN_URL, '_blank', 'noopener');
}

async function openCoupangHelperFolder() {
  const token = localStorage.getItem('naverMonitorAccessToken') || '';
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const endpoints = isLocalHost
    ? ['/api/coupang-helper-folder']
    : ['http://127.0.0.1:5001/api/coupang-helper-folder'];
  let lastError = '';
  const foot = document.getElementById('coupang-login-foot');
  async function postWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const r = await fetch(url, { method: 'POST', headers, signal: controller.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || '도우미 폴더를 열지 못했습니다');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    for (const endpoint of endpoints) {
      try {
        const data = await postWithTimeout(endpoint);
        showToast(data.message || '도우미 폴더를 열었습니다');
        return;
      } catch(e) {
        lastError = e.message || String(e);
        if (endpoint.startsWith('/') && !isLocalHost) break;
      }
    }
    throw new Error(lastError);
  } catch(e) {
    if (foot) {
      foot.textContent = '도우미 없이도 바로 재고 조회를 시작할 수 있습니다. 도우미를 쓰려면 PC에서 네이버 모니터링 앱 폴더의 run_coupang_stock_helper.bat를 실행하세요.';
    }
  }
}

function closeCoupangLoginModal(confirmed = false, event = null) {
  if (event && event.target && event.target.id !== 'coupang-login-modal') return;
  document.getElementById('coupang-login-modal')?.classList.remove('show');
  if (coupangLoginResolve) {
    const resolve = coupangLoginResolve;
    coupangLoginResolve = null;
    resolve(Boolean(confirmed));
  }
}

function confirmCoupangLoginBeforeFetch(fetchMode, market = currentMarket()) {
  if (!shouldWarnCoupangLogin(fetchMode, market)) return Promise.resolve(true);
  const isStock = String(fetchMode || '').toLowerCase() === 'coupang_stock' || String(market || '').toLowerCase() === 'coupang_stock';
  const title = document.getElementById('coupang-login-title');
  const desc = document.getElementById('coupang-login-desc');
  const foot = document.getElementById('coupang-login-foot');
  const loginBtn = document.getElementById('coupang-login-link-btn');
  const helperBtn = document.getElementById('coupang-helper-folder-btn');
  const confirmBtn = document.getElementById('coupang-login-confirm-btn');
  if (title) title.textContent = isStock ? '쿠팡 재고조회 도우미 실행 확인' : '쿠팡 로그인 확인이 필요합니다';
  if (desc) {
    desc.textContent = isStock
      ? '쿠팡 재고조회는 로컬 도우미가 실행되어 있으면 더 빠릅니다. 도우미가 없어도 바로 조회를 시작할 수 있습니다.'
      : '쿠팡 판매가는 로그인, 와우, 쿠폰 세션에 따라 달라질 수 있습니다. 정확한 판매가와 매출 추정을 위해 같은 크롬에서 쿠팡 로그인 상태를 확인해 주세요.';
  }
  if (foot) {
    foot.textContent = isStock
      ? '도우미는 선택 사항입니다. 실행되어 있으면 더 빠르고, 준비가 안 됐어도 바로 조회를 시작할 수 있습니다.'
      : '로그인 바로가기를 누르면 새 탭에서 쿠팡 로그인 페이지가 열립니다. 로그인 완료 후 이 화면으로 돌아와 조회를 시작하면 됩니다.';
  }
  if (loginBtn) loginBtn.style.display = isStock ? 'none' : '';
  if (helperBtn) helperBtn.style.display = isStock ? '' : 'none';
  if (helperBtn) helperBtn.textContent = '도우미 폴더 열기';
  if (confirmBtn) confirmBtn.textContent = isStock ? '바로 재고 조회 시작' : '로그인 완료 · 조회 시작';
  document.getElementById('coupang-login-modal')?.classList.add('show');
  return new Promise(resolve => {
    coupangLoginResolve = resolve;
  });
}

function parseVersionParts(version) {
  return String(version || '').split('.').map(part => parseInt(part, 10) || 0);
}

function isExtensionVersionAtLeast(version, required) {
  const current = parseVersionParts(version);
  const target = parseVersionParts(required);
  const length = Math.max(current.length, target.length);
  for (let i = 0; i < length; i++) {
    const a = current[i] || 0;
    const b = target[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function getExtensionInfo(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const requestId = `info-${Date.now()}-${++extensionRequestSeq}`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    function onMessage(event) {
      if (event.source !== window) return;
      const msg = event.data || {};
      if (msg.source !== 'naver-monitor-extension' || msg.type !== 'EXTENSION_INFO' || msg.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(msg);
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'naver-monitor-dashboard',
      type: 'GET_EXTENSION_INFO',
      requestId
    }, '*');
  });
}

async function ensureCoupangExtensionVersion(fetchMode) {
  if (!isCoupangFetchMode(fetchMode)) return;
  const info = await getExtensionInfo();
  if (!info || !isExtensionVersionAtLeast(info.version, REQUIRED_COUPANG_EXTENSION_VERSION)) {
    const installed = info && info.version ? `현재 v${info.version}` : '현재 버전 확인 불가';
    const err = new Error(`쿠팡 조회는 확장 프로그램 v${REQUIRED_COUPANG_EXTENSION_VERSION} 이상이 필요합니다. ${installed}라서 조회를 시작하지 않았습니다.`);
    err.noQueue = true;
    throw err;
  }
}

function formatPlanDate(value) {
  if (!value) return '—';
  const dt = new Date(`${value}T00:00:00+09:00`);
  return dt.toLocaleDateString('ko-KR');
}

function renderPlanStatus(cfg) {
  const el = document.getElementById('plan-status-card');
  if (!el || !cfg) return;
  const marketCount = filterByCurrentMarket(cfg.competitors || []).length;
  const limit = cfg.competitor_limit == null ? '제한 없음' : `${cfg.competitor_limit}개`;
  const count = cfg.competitor_count ?? ((cfg.competitors || []).length);
  const expired = !!cfg.plan_expired;
  const remaining = cfg.plan_remaining_days;
  const periodText = cfg.plan_expires_at
    ? `시작일 ${formatPlanDate(cfg.plan_started_at)} · 만료일 ${formatPlanDate(cfg.plan_expires_at)} · ${expired ? '만료됨' : `남은 기간 ${remaining}일`}`
    : '무료 플랜은 별도 만료일 없이 바로 사용할 수 있습니다.';
  const overLimitText = limit !== '제한 없음' && count > Number(cfg.competitor_limit)
    ? `<br>등록된 상품은 삭제되지 않으며, 조회는 등록순 상위 ${cfg.competitor_limit}개만 실행됩니다.`
    : '';
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <strong style="color:var(--text)">${escHtml(cfg.plan_label || '무료')} 플랜${expired ? ' · 만료됨' : ''}</strong><br>
        ${periodText}<br>
        경쟁사 상품 ${limit}까지 등록 가능 · 전체 ${count}개 등록 · ${marketLabel()} ${marketCount}개${overLimitText}
      </div>
      ${expired ? '<button class="btn btn-sm btn-primary" onclick="openUpgradeModal(\'이용 기간이 만료되었습니다. 계속 사용하려면 유료 플랜을 다시 신청해주세요.\')">연장 신청</button>' : ''}
    </div>`;
}

function requestExtensionStop() {
  return new Promise((resolve, reject) => {
    const requestId = `stop-${Date.now()}-${++extensionRequestSeq}`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('확장 프로그램 연결을 확인할 수 없습니다.'));
    }, 5200);

    function onMessage(event) {
      if (event.source !== window) return;
      const msg = event.data || {};
      if (msg.source !== 'naver-monitor-extension' || msg.type !== 'STOP_FETCH_RESULT' || msg.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (msg.ok) resolve(msg);
      else reject(new Error(msg.error || '조회 중지에 실패했습니다.'));
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'naver-monitor-dashboard',
      type: 'STOP_FETCH',
      requestId,
    }, '*');
  });
}

function syncExtensionSchedule(schedule) {
  return new Promise((resolve, reject) => {
    const requestId = `schedule-${Date.now()}-${++extensionRequestSeq}`;
    const auth = {
      serverUrl: location.origin,
      accessToken: localStorage.getItem('naverMonitorAccessToken') || '',
      refreshToken: localStorage.getItem('naverMonitorRefreshToken') || '',
      loginEmail: (appConfig && appConfig.username) || ''
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('확장 프로그램 스케줄 동기화 응답이 없습니다.'));
    }, 5200);

    function onMessage(event) {
      if (event.source !== window) return;
      const msg = event.data || {};
      if (msg.source !== 'naver-monitor-extension' || msg.type !== 'SYNC_SCHEDULE_RESULT' || msg.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (msg.ok && msg.hasAuth) resolve(msg);
      else if (msg.ok) reject(new Error('확장 프로그램에 서비스 로그인 정보가 저장되지 않았습니다. 확장 프로그램을 새로고침한 뒤 다시 저장해주세요.'));
      else reject(new Error(msg.error || '확장 프로그램 스케줄 동기화 실패'));
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'naver-monitor-dashboard',
      type: 'SYNC_SCHEDULE',
      requestId,
      auth,
      schedule,
    }, '*');
  });
}

function runExtensionScheduleNow() {
  return new Promise((resolve, reject) => {
    const requestId = `schedule-now-${Date.now()}-${++extensionRequestSeq}`;
    const auth = {
      serverUrl: location.origin,
      accessToken: localStorage.getItem('naverMonitorAccessToken') || '',
      refreshToken: localStorage.getItem('naverMonitorRefreshToken') || '',
      loginEmail: (appConfig && appConfig.username) || ''
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('확장 프로그램 자동조회 테스트 응답이 없습니다.'));
    }, 5200);

    function onMessage(event) {
      if (event.source !== window) return;
      const msg = event.data || {};
      if (msg.source !== 'naver-monitor-extension' || msg.type !== 'RUN_SCHEDULED_FETCH_NOW_RESULT' || msg.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (msg.ok && msg.hasAuth) resolve(msg);
      else if (msg.ok) reject(new Error('확장 프로그램에 서비스 로그인 정보가 저장되지 않았습니다. 스케줄 저장을 다시 눌러주세요.'));
      else reject(new Error(msg.error || '자동조회 테스트 시작 실패'));
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'naver-monitor-dashboard',
      type: 'RUN_SCHEDULED_FETCH_NOW',
      requestId,
      auth,
    }, '*');
  });
}

async function queueFetchForExtension(id = null, fetchMode = currentFetchMode(), market = currentMarket()) {
  const body = id
    ? {id}
    : {ids: getFetchableDashboardCompetitors().map(comp => comp.id)};
  if (fetchMode) body.fetchMode = fetchMode;
  body.market = market;
  const r = await fetch('/api/ext/queue', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '대기 등록 실패');
  return data;
}

async function queueFetchIdsForExtension(ids, fetchMode = currentFetchMode(), market = currentMarket()) {
  const body = {ids: Array.isArray(ids) ? ids.filter(Boolean) : []};
  if (fetchMode) body.fetchMode = fetchMode;
  body.market = market;
  const r = await fetch('/api/ext/queue', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '대기 등록 실패');
  return data;
}

async function stopFetch() {
  try {
    await requestExtensionStop();
    showToast('진행 중인 조회를 중지했습니다');
  } catch (e) {
    showToast(e.message || '조회 중지 실패');
  }
}

async function fetchAll() {
  const fetchLabel = isCoupangStockMarket() ? '재고 조회' : '전체 조회';
  const fetchMode = currentFetchMode();
  const fetchMarket = currentMarket();
  if (!(await confirmCoupangLoginBeforeFetch(fetchMode, fetchMarket))) return;
  showLoading(`크롬 확장 프로그램에 ${fetchLabel} 요청 중...`);
  const btn = document.getElementById('fetch-btn');
  btn.disabled = true;
  try {
    const competitors = getFetchableDashboardCompetitors();
    if (!competitors.length) {
      showToast('조회할 경쟁사가 없습니다');
      return;
    }
    await ensureCoupangExtensionVersion(fetchMode);
    try {
      resetFetchConsole();
      beginPendingFetch(competitors, fetchMode, fetchMarket);
      await requestExtensionFetch(competitors, fetchMode, fetchMarket);
      startHistoryAutoRefresh(competitors.length);
      showToast(`확장 프로그램에서 ${competitors.length}개 상품 ${fetchLabel}를 시작했습니다`);
    } catch (e) {
      clearPendingFetch();
      if (e.noQueue) {
        showToast(e.message);
        return;
      }
      const data = await queueFetchForExtension(null, fetchMode, fetchMarket);
      showToast(`확장 프로그램 업데이트/로그인 확인 필요 — ${data.count || 0}개 대기 등록됨`);
    }
  } catch (e) {
    showToast(e.message || '서버 오류');
  } finally {
    hideLoading();
    btn.disabled = false;
  }
}

async function fetchSelectedStock() {
  const fetchMode = 'coupang_stock';
  const fetchMarket = 'coupang_stock';
  const competitors = visibleSelectableDashboardCompetitors()
    .filter(comp => selectedDashboardCompetitorIds.has(comp.id));

  if (!competitors.length) {
    showToast('재고조회할 상품을 먼저 선택해주세요');
    updateSelectedStockFetchButton();
    return;
  }
  if (!(await confirmCoupangLoginBeforeFetch(fetchMode, fetchMarket))) return;

  const btn = document.getElementById('selected-stock-fetch-btn');
  showLoading(`선택한 ${competitors.length}개 상품 재고조회 요청 중...`);
  if (btn) btn.disabled = true;
  try {
    await ensureCoupangExtensionVersion(fetchMode);
    try {
      resetFetchConsole();
      beginPendingFetch(competitors, fetchMode, fetchMarket);
      await requestExtensionFetch(competitors, fetchMode, fetchMarket);
      startHistoryAutoRefresh(competitors.length);
      showToast(`선택한 ${competitors.length}개 상품 재고조회를 시작했습니다`);
    } catch (e) {
      clearPendingFetch();
      if (e.noQueue) {
        showToast(e.message);
        return;
      }
      const data = await queueFetchIdsForExtension(competitors.map(comp => comp.id), fetchMode, fetchMarket);
      showToast(`확장 프로그램 확인 필요 · ${data.count || competitors.length}개 대기 등록`);
    }
  } catch (e) {
    showToast(e.message || '선택 상품 재고조회 요청 실패');
  } finally {
    hideLoading();
    updateSelectedStockFetchButton();
  }
}

async function fetchSingle(cid, name, forcedFetchMode = currentFetchMode(), forcedMarket = currentMarket()) {
  const fetchMode = forcedFetchMode || currentFetchMode();
  const fetchMarket = forcedMarket || currentMarket();
  const fetchLabel = fetchMode === 'coupang_stock' ? '재고 조회' : '선택상품조회';
  if (!(await confirmCoupangLoginBeforeFetch(fetchMode, fetchMarket))) return;
  showLoading(`${name} ${fetchLabel} 요청 중...`);
  try {
    const comp = getDashboardCompetitors().find(item => item.id === cid);
    if (!comp) {
      showToast('조회할 상품 정보를 찾을 수 없습니다');
      return;
    }
    if (!isCompetitorFetchAllowed(cid)) {
      openUpgradeModal('이 상품은 현재 플랜 한도 밖에 있습니다. 등록된 상품은 보존되지만, 무료 또는 만료 상태에서는 등록순 상위 상품만 조회할 수 있습니다.');
      return;
    }
    await ensureCoupangExtensionVersion(fetchMode);
    try {
      resetFetchConsole();
      beginPendingFetch([comp], fetchMode, fetchMarket);
      await requestExtensionFetch([comp], fetchMode, fetchMarket);
      startHistoryAutoRefresh(1);
      showToast(`${name} ${fetchLabel}를 시작했습니다`);
    } catch (e) {
      clearPendingFetch();
      if (e.noQueue) {
        showToast(e.message);
        return;
      }
      await queueFetchForExtension(cid, fetchMode, fetchMarket);
      showToast(`${name} 대기 등록됨 — 확장 프로그램 업데이트/로그인 확인 필요`);
    }
  } catch (e) {
    showToast(e.message || '서버 오류');
  } finally {
    hideLoading();
  }
}

// ─── Competitors ─────────────────────────────────────────────
function renderCompetitorLimit(cfg) {
  const note = document.getElementById('competitor-limit-note');
  if (!note) return;
  const competitors = (cfg && cfg.competitors) || [];
  const naverCount = competitors.filter(comp => competitorMarket(comp) === 'naver').length;
  const ohouseCount = competitors.filter(comp => competitorMarket(comp) === 'ohouse').length;
  const coupangCount = competitors.filter(comp => competitorMarket(comp) === 'coupang').length;
  const totalCount = competitors.length;
  const limit = cfg ? cfg.competitor_limit : null;
  const planLabel = (cfg && cfg.plan_label) || '무료';
  if (limit === null || limit === undefined) {
    note.textContent = `전체 ${totalCount}개 · 네이버 ${naverCount}개 · 오늘의집 ${ohouseCount}개 · 쿠팡 ${coupangCount}개 · 등록 제한 없음`;
    return;
  }
  if (cfg && cfg.plan_expired) {
    note.textContent = `${planLabel} 플랜 이용 기간이 만료되어 추가 등록은 무료 한도 ${limit}개 기준으로 제한됩니다. 전체 ${totalCount}/${limit}개 · 네이버 ${naverCount}개 · 오늘의집 ${ohouseCount}개 · 쿠팡 ${coupangCount}개`;
    return;
  }
  const remain = Math.max(limit - totalCount, 0);
  note.textContent = `${planLabel} 플랜: 경쟁사 상품 ${limit}개까지 등록 가능 · 전체 ${totalCount}/${limit}개 · 네이버 ${naverCount}개 · 오늘의집 ${ohouseCount}개 · 쿠팡 ${coupangCount}개 · 남은 ${remain}개`;
}

function getPaidPlans() {
  const pricing = Array.isArray(appConfig.pricing) ? appConfig.pricing : [];
  const paid = pricing.filter(plan => ['basic', 'pro', 'business'].includes(plan.id));
  if (paid.length) return paid;
  return [
    {id:'basic', label:'베이직', price:'19,900원', period:'3개월', competitor_limit:10, note:'가볍게 확장'},
    {id:'pro', label:'프로', price:'39,900원', period:'6개월', competitor_limit:20, recommended:true, note:'추천 플랜'},
    {id:'business', label:'비즈니스', price:'149,000원', period:'6개월', competitor_limit:50, note:'상담 후 활성화'},
  ];
}

function openUpgradeModal(reason) {
  const modal = document.getElementById('upgrade-modal');
  const grid = document.getElementById('upgrade-plan-grid');
  const desc = document.getElementById('upgrade-desc');
  const limit = appConfig.competitor_limit || 3;
  const count = (appConfig.competitors || []).length;
  desc.textContent = reason || `현재 ${count}/${limit}개를 등록했습니다. 더 많은 경쟁사 상품을 관리하려면 유료 플랜을 신청해주세요.`;
  grid.innerHTML = getPaidPlans().map(plan => `
    <div class="plan-card ${plan.recommended ? 'recommended' : ''}">
      <div class="plan-chip">${plan.recommended ? '추천' : plan.note || '유료 플랜'}</div>
      <div class="plan-name">${escHtml(plan.label)}</div>
      <div class="plan-price">${escHtml(plan.price)}</div>
      <div class="plan-meta">
        ${plan.period ? `${escHtml(plan.period)} 이용<br>` : ''}
        경쟁사 상품 ${plan.competitor_limit}개까지 등록<br>
        ${plan.id === 'business' ? '많은 상품은 조회 간격을 조절해 운영하는 것을 권장합니다.' : '현재 업무량에 맞춰 바로 확장할 수 있습니다.'}
      </div>
      <button class="btn ${plan.recommended ? 'btn-green' : 'btn-primary'}" onclick="requestPlan('${plan.id}')">${plan.id === 'business' ? '상담 신청' : '플랜 신청'}</button>
    </div>
  `).join('');
  modal.classList.add('show');
}

function closeUpgradeModal(event) {
  if (event && event.target && event.target.id !== 'upgrade-modal') return;
  document.getElementById('upgrade-modal').classList.remove('show');
}

async function requestPlan(plan) {
  try {
    const r = await fetch('/api/plan-request', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({plan})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '플랜 신청 실패');
    closeUpgradeModal();
    showToast(data.message || '플랜 신청이 접수되었습니다');
  } catch (e) {
    showToast(e.message || '플랜 신청 실패');
  }
}

function renderCompList(competitors) {
  const el = document.getElementById('comp-list');
  const summary = document.getElementById('comp-list-summary');
  const tabs = document.getElementById('comp-filter-tabs');
  const searchEl = document.getElementById('comp-filter-search');
  const source = competitors || [];
  const counts = {
    all: source.length,
    naver: source.filter(c => competitorMarket(c) === 'naver').length,
    ohouse: source.filter(c => competitorMarket(c) === 'ohouse').length,
    coupang: source.filter(c => competitorMarket(c) === 'coupang').length,
  };
  const filter = currentCompFilter();
  const search = String((searchEl && searchEl.value) || '').trim().toLowerCase();
  if (tabs) {
    tabs.innerHTML = ['all', 'naver', 'ohouse', 'coupang'].map(key => `
      <button class="comp-filter-btn ${filter === key ? 'active' : ''}" type="button" onclick="setCompFilter('${key}')">${compFilterLabel(key)} ${counts[key]}</button>
    `).join('');
  }
  const filtered = source.filter(c => {
    const marketOk = filter === 'all' || competitorMarket(c) === filter;
    if (!marketOk) return false;
    if (!search) return true;
    return String(c.name || '').toLowerCase().includes(search) || String(c.url || '').toLowerCase().includes(search);
  });
  if (summary) {
    const searchText = search ? ` · 검색 "${escHtml(search)}"` : '';
    const dragText = (!search && filtered.length > 1) ? ' · 손잡이를 드래그해 순서 변경' : '';
    summary.innerHTML = `${compFilterLabel(filter)} ${filtered.length}개 표시 / 전체 ${source.length}개${searchText}${dragText}`;
  }
  if (!source.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:12px 0">아직 등록된 경쟁사가 없습니다</div>';
    return;
  }
  if (!filtered.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:16px 0">조건에 맞는 경쟁사가 없습니다</div>';
    return;
  }
  const canReorder = !search && filtered.length > 1;
  el.innerHTML = filtered.map(c => {
    const canFetch = isCompetitorFetchAllowed(c.id);
    const marketName = COMPETITOR_MARKET_LABELS[competitorMarket(c)] || '네이버';
    const dragTitle = search
      ? '검색 중에는 순서 변경을 잠시 꺼둡니다'
      : (canReorder ? '드래그해서 순서 변경' : '순서를 바꿀 상품이 2개 이상 필요합니다');
    return `
    <div class="comp-list-item" id="cli-${c.id}" data-cid="${c.id}" draggable="false">
      <button class="comp-drag-handle" type="button" draggable="false" ${canReorder ? '' : 'disabled'} title="${dragTitle}" aria-label="순서 변경">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg>
      </button>
      ${productThumb(c)}
      <div class="comp-list-name">${escHtml(c.name)} <span class="badge badge-gray">${marketName}</span>${canFetch ? '' : ' <span class="badge badge-gray">보존됨 · 조회 제한</span>'}</div>
      <div class="comp-list-url" title="${escHtml(c.url)}">${escHtml(c.url)}</div>
      <div class="comp-list-actions">
        <button class="btn btn-sm" onclick="editCompetitor('${escJsAttr(c.id)}','${escJsAttr(c.name)}','${escJsAttr(c.url)}')">수정</button>
        <button class="btn btn-sm btn-danger" onclick="removeCompetitor('${escJsAttr(c.id)}','${escJsAttr(c.name)}')">삭제</button>
      </div>
    </div>`;
  }).join('');
  setupCompetitorDragSort(canReorder);
}

function setupCompetitorDragSort(enabled) {
  const list = document.getElementById('comp-list');
  if (!list || !enabled) return;
  setupPointerDragSort({
    container: list,
    itemSelector: '.comp-list-item',
    handleSelector: '.comp-drag-handle',
    onSave: saveCompetitorOrderFromDom,
  });
}

function setupMonitorDragSort(enabled) {
  const list = document.querySelector('#table-wrap .monitor-wrap');
  if (!list || !enabled) return;
  setupPointerDragSort({
    container: list,
    itemSelector: '.monitor-product-row',
    handleSelector: '.monitor-drag-handle',
    onSave: saveMonitorCompetitorOrderFromDom,
  });
}

function setupPointerDragSort({container, itemSelector, handleSelector, onSave}) {
  let dragged = null;
  let didMove = false;
  container.querySelectorAll(handleSelector).forEach(handle => {
    handle.addEventListener('pointerdown', event => {
      if (handle.disabled || (event.button !== undefined && event.button !== 0)) return;
      const item = handle.closest(itemSelector);
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      dragged = item;
      didMove = false;
      item.classList.add('dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, {once: true});
    });
  });

  function onPointerMove(event) {
    if (!dragged) return;
    event.preventDefault();
    didMove = true;
    const after = getDragAfterElement(container, event.clientY, itemSelector);
    if (!after) container.appendChild(dragged);
    else container.insertBefore(dragged, after);
  }

  function onPointerUp() {
    document.removeEventListener('pointermove', onPointerMove);
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    if (didMove) onSave();
  }
}

function getDragAfterElement(container, y, selector) {
  const items = [...container.querySelectorAll(`${selector}:not(.dragging)`)];
  return items.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return {offset, element: child};
    return closest;
  }, {offset: Number.NEGATIVE_INFINITY, element: null}).element;
}

async function saveCompetitorOrderFromDom() {
  const visibleIds = [...document.querySelectorAll('#comp-list .comp-list-item')]
    .map(item => item.dataset.cid)
    .filter(Boolean);
  await persistCompetitorOrder(visibleIds);
}

async function saveMonitorCompetitorOrderFromDom() {
  const visibleIds = [...document.querySelectorAll('#table-wrap .monitor-product-row')]
    .map(item => item.dataset.cid)
    .filter(Boolean);
  await persistCompetitorOrder(visibleIds);
}

async function persistCompetitorOrder(visibleIds) {
  if (visibleIds.length < 2) return;
  const currentIds = (appConfig.competitors || []).map(comp => comp.id);
  const ids = mergeVisibleOrderIntoFullOrder(currentIds, visibleIds);
  if (ids.join('|') === currentIds.join('|')) return;
  appConfig.competitors = orderItemsByIds(appConfig.competitors || [], ids);
  if (historyData && historyData.competitors) {
    historyData.competitors = orderItemsByIds(historyData.competitors, ids);
    renderTable(historyData);
  }
  try {
    const r = await fetch('/api/competitors/reorder', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ids})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '순서 저장 실패');
    if (Array.isArray(data.ids)) {
      appConfig.competitors = orderItemsByIds(appConfig.competitors || [], data.ids);
      if (historyData && historyData.competitors) historyData.competitors = orderItemsByIds(historyData.competitors, data.ids);
    }
    renderCompetitorLimit(appConfig);
    showToast('상품 순서가 저장되었습니다');
  } catch (e) {
    showToast(e.message || '순서 저장 실패');
    await loadConfig();
    await loadHistory(true);
  }
}

function orderItemsByIds(items, ids) {
  const order = new Map(ids.map((id, index) => [id, index]));
  return [...(items || [])].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : order.size;
    const bi = order.has(b.id) ? order.get(b.id) : order.size;
    return ai - bi;
  });
}

function mergeVisibleOrderIntoFullOrder(currentIds, visibleIds) {
  const visibleSet = new Set(visibleIds);
  const nextVisible = [...visibleIds];
  return currentIds.map(id => visibleSet.has(id) ? nextVisible.shift() : id).filter(Boolean);
}

async function addCompetitor() {
  const name = document.getElementById('new-comp-name').value.trim();
  const url = document.getElementById('new-comp-url').value.trim();
  if (!name || !url) { showToast('이름과 URL을 입력해주세요'); return; }
  const coupangWarning = coupangUrlVendorWarning(url);
  if (coupangWarning) { showToast(coupangWarning); return; }
  const limit = appConfig.competitor_limit;
  const currentCount = (appConfig.competitors || []).length;
  if (limit !== null && limit !== undefined && currentCount >= limit) {
    openUpgradeModal(`${appConfig.plan_label || '현재'} 플랜은 경쟁사 상품을 ${limit}개까지 등록할 수 있습니다. 지금 유료 플랜을 신청하면 더 많은 경쟁사 상품을 추가할 수 있습니다.`);
    return;
  }
  try {
    const r = await fetch('/api/competitors', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name, url})
    });
    const data = await r.json();
    if (r.ok) {
      document.getElementById('new-comp-name').value = '';
      document.getElementById('new-comp-url').value = '';
      showToast(`✅ ${name} 추가됨`);
      await loadConfig();
      await loadHistory();
    } else {
      if (r.status === 403) {
        openUpgradeModal(data.error || '현재 플랜의 등록 한도에 도달했습니다.');
        return;
      }
      showToast(data.error || '추가 실패');
    }
  } catch {
    showToast('서버 오류');
  }
}

function editCompetitor(cid, name, url) {
  const newName = prompt('경쟁사 상품명:', name);
  if (newName === null) return;
  const newUrl = prompt('URL:', url);
  if (newUrl === null) return;
  const coupangWarning = coupangUrlVendorWarning(newUrl);
  if (coupangWarning) { showToast(coupangWarning); return; }
  fetch(`/api/competitors/${cid}`, {
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: newName, url: newUrl})
  }).then(() => {
    showToast('수정됨');
    loadConfig();
    loadHistory();
  });
}

async function removeCompetitor(cid, name) {
  if (!confirm(`"${name}"을(를) 삭제하시겠습니까?`)) return;
  try {
    await fetch(`/api/competitors/${cid}`, {method:'DELETE'});
    showToast(`🗑️ ${name} 삭제됨`);
    await loadConfig();
    await loadHistory();
  } catch {
    showToast('삭제 실패');
  }
}

// ─── Schedule ────────────────────────────────────────────────
function scheduleChanged() {
  showToast('스케줄 저장 버튼을 눌러 적용해주세요');
}

async function saveSchedule() {
  const enabled = document.getElementById('sched-enabled').checked;
  const hour = parseInt(document.getElementById('sched-hour').value);
  const minute = parseInt(document.getElementById('sched-min').value);
  const markets = [];
  const marketLabels = [];
  if (document.getElementById('sched-market-naver').checked) { markets.push('naver'); marketLabels.push('네이버'); }
  if (document.getElementById('sched-market-ohouse').checked) { markets.push('ohouse'); marketLabels.push('오늘의집'); }
  if (document.getElementById('sched-market-coupang-stock').checked) { markets.push('coupang_stock'); marketLabels.push('쿠팡 재고조회'); }
  if (enabled && !markets.length) {
    showToast('자동조회 대상을 하나 이상 선택해주세요');
    return;
  }
  const schedule = {enabled, hour, minute, markets};
  try {
    await fetch('/api/schedule', {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(schedule)
    });
    try {
      await syncExtensionSchedule(schedule);
    } catch (e) {
      showToast('서버에는 저장됨 — 확장 프로그램 새로고침/로그인 후 스케줄이 동기화됩니다');
      return;
    }
    showToast(enabled
      ? `⏰ 자동조회 저장됨: 매일 ${hour}시 ${minute}분 · ${marketLabels.join(', ')}`
      : '자동조회 사용 안 함으로 저장됨');
    if (enabled && markets.includes('coupang_stock')) {
      showToast('쿠팡 재고조회는 도우미를 미리 실행하면 가장 빠르게 저장됩니다');
    }
  } catch {
    showToast('저장 실패');
  }
}

async function runScheduleNow() {
  try {
    await runExtensionScheduleNow();
    showToast('자동조회 테스트를 시작했습니다');
  } catch (e) {
    showToast(e.message || '자동조회 테스트 시작 실패');
  }
}

// ─── Credentials ─────────────────────────────────────────────
async function updateCredentials() {
  const username = document.getElementById('new-username').value.trim();
  const current = document.getElementById('cur-password').value;
  const newPwd = document.getElementById('new-password').value;
  if (!current) { showToast('현재 비밀번호를 입력해주세요'); return; }
  if (!username && !newPwd) { showToast('변경할 내용을 입력해주세요'); return; }
  try {
    const r = await fetch('/api/credentials', {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username, current, new_password: newPwd})
    });
    const data = await r.json();
    if (r.ok) {
      showToast('✅ 계정 정보 변경됨');
      document.getElementById('cur-password').value = '';
      document.getElementById('new-password').value = '';
      document.getElementById('new-username').value = '';
      await loadConfig();
    } else {
      showToast(data.error || '변경 실패');
    }
  } catch {
    showToast('서버 오류');
  }
}

// ─── Extension Guide ─────────────────────────────────────────
function copyStoreUrl() {
  navigator.clipboard.writeText(EXTENSION_STORE_URL).then(() => showToast('설치 URL 복사됨'));
}

function openStoreUrl() {
  window.open(EXTENSION_STORE_URL, '_blank');
}

// ─── Fetch Logs ─────────────────────────────────────────────
function formatLogDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', {
    month:'2-digit',
    day:'2-digit',
    hour12:false,
    hour:'2-digit',
    minute:'2-digit',
    second:'2-digit'
  });
}

function formatLogClock(value) {
  if (!value) return '--:--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('ko-KR', {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

function logSourceLabel(source) {
  source = String(source || '');
  if (source === 'local-helper' || source === 'local-batch') return '로컬헬퍼';
  if (source === 'background-direct') return '빠른경로';
  if (source === 'browser-fallback' || source === 'browser-tab') return '브라우저';
  if (source === 'summary') return '요약';
  return source || '-';
}

async function loadFetchLogs() {
  const listEl = document.getElementById('fetch-log-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty-state"><div class="inline-spinner"></div><div class="empty-state-title">로그를 불러오는 중입니다</div></div>`;
  try {
    const r = await fetch('/api/fetch-logs');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '로그 로드 실패');
    fetchLogData = data.logs || [];
    if (!fetchLogData.length) {
      listEl.innerHTML = '<div class="empty-state"><div class="empty-state-title">아직 조회 로그가 없습니다</div></div>';
      renderFetchLogDetail(null);
      return;
    }
    if (!selectedFetchLogId || !fetchLogData.some(log => log.runId === selectedFetchLogId)) {
      selectedFetchLogId = fetchLogData[0].runId;
    }
    renderFetchLogList();
    renderFetchLogDetail(fetchLogData.find(log => log.runId === selectedFetchLogId) || fetchLogData[0]);
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-state-title">${escHtml(e.message || '로그 로드 실패')}</div></div>`;
  }
}

function renderFetchLogList() {
  const listEl = document.getElementById('fetch-log-list');
  if (!listEl) return;
  listEl.innerHTML = fetchLogData.map(log => {
    const errors = Number(log.errors || 0);
    const ok = Number(log.ok || 0);
    const total = Number(log.total || 0);
    return `
      <button class="log-run-btn ${log.runId === selectedFetchLogId ? 'active' : ''}" type="button" onclick="selectFetchLog('${escJsAttr(log.runId || '')}')">
        <div class="log-run-title">${escHtml(fetchModeLabel(log))} · ${ok}/${total} 성공</div>
        <div class="log-run-meta">${formatLogDate(log.startedAt)} · 총 ${formatElapsed(log.elapsedMs)} · 실패 ${errors}</div>
      </button>
    `;
  }).join('');
}

function selectFetchLog(runId) {
  selectedFetchLogId = runId;
  renderFetchLogList();
  renderFetchLogDetail(fetchLogData.find(log => log.runId === runId) || null);
}

function failedFetchLogItems(log) {
  const items = Array.isArray(log && log.items) ? log.items : [];
  return items.filter(item => item && (item.error || item.status === 'error'));
}

function competitorForLogItem(item) {
  const competitors = appConfig.competitors || [];
  if (!item) return null;
  if (item.id) {
    const byId = competitors.find(comp => comp.id === item.id);
    if (byId) return byId;
  }
  const itemName = String(item.name || '').trim();
  if (!itemName) return null;
  return competitors.find(comp => String(comp.name || '').trim() === itemName) || null;
}

function retryModeFromLog(log, items) {
  const mode = String((log && (log.mode || log.phase)) || '').toLowerCase();
  if (mode === 'coupang_stock' || mode === 'stock') return {fetchMode: 'coupang_stock', market: 'coupang_stock'};
  if (mode === 'coupang_sales' || mode === 'sales' || mode === 'coupang') return {fetchMode: 'coupang_sales', market: 'coupang'};
  const firstMarket = String((items && items[0] && items[0].market) || currentMarket()).toLowerCase();
  if (firstMarket === 'coupang') return {fetchMode: 'coupang_stock', market: 'coupang_stock'};
  return {fetchMode: '', market: firstMarket || currentMarket()};
}

function selectedFailedLogItems(runId) {
  return [...document.querySelectorAll('.failed-log-check')]
    .filter(input => input.dataset.runId === runId && input.checked)
    .map(input => Number(input.dataset.itemIndex))
    .filter(index => Number.isInteger(index));
}

function setFailedLogSelection(runId, checked) {
  document.querySelectorAll('.failed-log-check').forEach(input => {
    if (input.dataset.runId === runId) input.checked = checked;
  });
}

async function retryFailedLogItems(runId, selectedOnly = true) {
  const log = fetchLogData.find(item => item.runId === runId);
  if (!log) {
    showToast('조회 로그를 찾을 수 없습니다');
    return;
  }
  const failedItems = failedFetchLogItems(log);
  const selectedIndexes = selectedOnly ? new Set(selectedFailedLogItems(runId)) : null;
  const chosenItems = failedItems.filter((item, index) => !selectedIndexes || selectedIndexes.has(index));
  const competitors = [];
  const seen = new Set();
  chosenItems.forEach(item => {
    const comp = competitorForLogItem(item);
    if (!comp || seen.has(comp.id)) return;
    if (!isCompetitorFetchAllowed(comp.id)) return;
    competitors.push(comp);
    seen.add(comp.id);
  });
  if (!competitors.length) {
    showToast('다시 조회할 수 있는 실패 상품이 없습니다');
    return;
  }

  const retryMode = retryModeFromLog(log, chosenItems);
  if (!(await confirmCoupangLoginBeforeFetch(retryMode.fetchMode, retryMode.market))) return;

  showLoading(`${competitors.length}개 실패 상품 다시조회 요청 중...`);
  try {
    await ensureCoupangExtensionVersion(retryMode.fetchMode);
    try {
      resetFetchConsole();
      beginPendingFetch(competitors, retryMode.fetchMode, retryMode.market);
      await requestExtensionFetch(competitors, retryMode.fetchMode, retryMode.market);
      startHistoryAutoRefresh(competitors.length);
      showToast(`${competitors.length}개 실패 상품 다시조회를 시작했습니다`);
    } catch (e) {
      clearPendingFetch();
      if (e.noQueue) {
        showToast(e.message);
        return;
      }
      const data = await queueFetchIdsForExtension(competitors.map(comp => comp.id), retryMode.fetchMode, retryMode.market);
      showToast(`확장 프로그램 확인 필요 · ${data.count || competitors.length}개 대기 등록`);
    }
  } catch (e) {
    showToast(e.message || '실패 상품 다시조회 요청 실패');
  } finally {
    hideLoading();
  }
}

function renderLogItemRow(log, item, index) {
  const failed = !!(item && (item.error || item.status === 'error'));
  const retryable = failed && !!competitorForLogItem(item);
  const retryControl = retryable
    ? `<label class="failed-log-check-wrap" title="다시 조회 대상 선택"><input class="failed-log-check" type="checkbox" data-run-id="${escHtml(log.runId || '')}" data-item-index="${index}" checked></label>`
    : '<span class="failed-log-check-spacer"></span>';
  return `
      <div class="log-item-row ${failed ? 'log-item-failed' : ''}" title="${escHtml(item.error || '')}">
        <div class="log-item-name">${retryControl}<span>${escHtml(item.name || '-')}</span></div>
        <div>${formatElapsed(item.elapsedMs)}</div>
        <div>${escHtml(logSourceLabel(item.source))}${item.apiCalls ? ` · ${Number(item.apiCalls)}회` : ''}</div>
        <div>${item.total === null || item.total === undefined ? '-' : Number(item.total).toLocaleString()}</div>
      </div>
  `;
}

function renderFetchLogDetail(log) {
  const title = document.getElementById('fetch-log-detail-title');
  const meta = document.getElementById('fetch-log-detail-meta');
  const detail = document.getElementById('fetch-log-detail');
  if (!detail) return;
  if (!log) {
    if (title) title.textContent = '상세 로그';
    if (meta) meta.textContent = '실행을 선택하면 타임라인이 표시됩니다';
    detail.innerHTML = '<div class="empty-state"><div class="empty-state-title">표시할 로그가 없습니다</div></div>';
    return;
  }
  const events = Array.isArray(log.events) ? log.events : [];
  const items = Array.isArray(log.items) ? log.items : [];
  const failedItems = failedFetchLogItems(log);
  const retryableCount = failedItems.filter(item => competitorForLogItem(item)).length;
  const slowest = [...items].sort((a, b) => Number(b.elapsedMs || 0) - Number(a.elapsedMs || 0))[0];
  if (title) title.textContent = fetchModeLabel(log);
  if (meta) meta.textContent = `${formatLogDate(log.startedAt)} 시작 · ${formatLogDate(log.finishedAt)} 종료`;
  detail.innerHTML = `
    <div class="log-detail-grid">
      <div class="log-metric"><div class="log-metric-label">총 소요</div><div class="log-metric-value">${formatElapsed(log.elapsedMs)}</div></div>
      <div class="log-metric"><div class="log-metric-label">성공</div><div class="log-metric-value">${Number(log.ok || 0)}/${Number(log.total || 0)}</div></div>
      <div class="log-metric"><div class="log-metric-label">실패</div><div class="log-metric-value">${Number(log.errors || 0)}</div></div>
      <div class="log-metric"><div class="log-metric-label">최장 상품</div><div class="log-metric-value" title="${escHtml(slowest && slowest.name || '-')}">${slowest ? formatElapsed(slowest.elapsedMs) : '-'}</div></div>
    </div>
    ${failedItems.length ? `
      <div class="log-retry-panel">
        <div>
          <strong>실패 상품 ${failedItems.length}개</strong>
          <span>${retryableCount ? `${retryableCount}개를 바로 다시 조회할 수 있습니다` : '현재 목록과 연결되는 상품이 없습니다'}</span>
        </div>
        <div class="log-retry-actions">
          <button class="mini-btn" type="button" onclick="setFailedLogSelection('${escJsAttr(log.runId || '')}', true)">전체 선택</button>
          <button class="mini-btn" type="button" onclick="setFailedLogSelection('${escJsAttr(log.runId || '')}', false)">해제</button>
          <button class="mini-btn primary" type="button" onclick="retryFailedLogItems('${escJsAttr(log.runId || '')}', true)">선택 실패상품 다시조회</button>
        </div>
      </div>
    ` : ''}
    <div class="fetch-console log-detail-console">
      ${events.length ? events.map(event => renderFetchLogEvent(event)).join('') : '<span class="fetch-console-line muted">저장된 상세 이벤트가 없습니다. 다음 조회부터 단계별 로그가 기록됩니다.</span>'}
      <span class="fetch-console-line muted">&gt; <span class="fetch-console-cursor"></span></span>
    </div>
    <div class="log-items">
      <div class="log-item-row"><div>상품</div><div>소요</div><div>경로</div><div>재고</div></div>
      ${items.map(item => renderLogItemRow(log, item, failedItems.indexOf(item))).join('') || '<div class="log-item-row"><div class="log-item-name">상품별 로그 없음</div><div>-</div><div>-</div><div>-</div></div>'}
    </div>
  `;
  const consoleEl = detail.querySelector('.log-detail-console');
  if (consoleEl) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function renderFetchLogEvent(event) {
  const level = event.level === 'error' ? 'err' : event.level === 'ok' ? 'ok' : '';
  const count = event.total ? `(${event.current}/${event.total}) ` : '';
  const source = event.source ? ` [${logSourceLabel(event.source)}]` : '';
  const api = event.apiCalls ? ` api=${Number(event.apiCalls)}회` : '';
  const stock = event.stock !== null && event.stock !== undefined ? ` stock=${Number(event.stock).toLocaleString()}` : '';
  const error = event.error ? ` error=${shortErrorMessage(event.error)}` : '';
  const elapsed = event.elapsedMs ? ` +${formatElapsed(event.elapsedMs)}` : '';
  return `<span class="fetch-console-line ${level}">[${formatLogClock(event.at)}]${elapsed} ${count}${escHtml(event.name || '')}${source} :: ${escHtml(event.msg || '')}${api}${stock}${escHtml(error)}</span>`;
}

// ─── Admin ──────────────────────────────────────────────────
const PLAN_LABELS = {free:'무료', basic:'베이직', pro:'프로 추천', business:'비즈니스'};
const PLAN_LIMITS = {free:3, basic:10, pro:20, business:50};
const BUSINESS_LIMITS = [50, 100, 150];

function renderUserPlanBadge(user) {
  if (user.is_admin) return '<span class="badge badge-green">관리자</span>';
  const plan = user.plan || 'free';
  const label = PLAN_LABELS[plan] || user.plan_label || '무료';
  const limit = PLAN_LIMITS[plan] || user.competitor_limit || 3;
  const badgeClass = user.plan_expired ? 'badge-red' : plan === 'pro' ? 'badge-green' : plan === 'business' ? 'badge-red' : plan === 'basic' ? 'badge-green' : 'badge-gray';
  const remain = user.plan_remaining_days;
  const period = user.plan_expires_at ? ` · ${user.plan_expired ? '만료됨' : `${remain}일 남음`}` : '';
  return `<span class="badge ${badgeClass}">${label} · ${limit}개${period}</span>`;
}

function renderPlanRequest(user) {
  const req = user.plan_request;
  if (!req || !req.plan) return '';
  const label = PLAN_LABELS[req.plan] || req.plan_label || req.plan;
  return `<div class="admin-muted" style="margin-top:4px"><span class="badge badge-red">신청: ${escHtml(label.replace(' 추천', ''))}</span></div>`;
}

function renderPlanActions(user) {
  if (user.is_admin) return '';
  return `<div class="plan-actions">
    ${Object.entries(PLAN_LABELS).map(([plan, label]) => `
      <button class="btn btn-sm ${user.plan === plan ? 'btn-primary' : ''}" onclick="setUserPlan('${user.id}', '${plan}')">${label.replace(' 추천', '')}</button>
    `).join('')}
    <span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px">
      ${BUSINESS_LIMITS.map(limit => `
        <button class="btn btn-sm ${user.plan === 'business' && Number(user.competitor_limit) === limit ? 'btn-primary' : ''}" onclick="setUserPlan('${user.id}', 'business', ${limit})">비즈 ${limit}</button>
      `).join('')}
      <button class="btn btn-sm" onclick="setCustomBusinessLimit('${user.id}', ${Number(user.competitor_limit) || 50})">직접</button>
    </span>
  </div>`;
}

function formatElapsed(ms) {
  ms = Number(ms) || 0;
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}초`;
  const min = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  return `${min}분 ${rest}초`;
}

function fetchModeLabel(log) {
  const mode = log.mode || '';
  const phase = log.phase || '';
  if (mode === 'coupang_stock' || phase === 'coupang_stock') return '쿠팡 재고조회';
  if (mode === 'coupang_sales') return '쿠팡 판매지표';
  if (phase === 'ohouse') return '오늘의집';
  if (phase === 'naver') return '네이버';
  return '전체 조회';
}

async function loadAdminFetchLogs() {
  if (!isAdminUser) return;
  const el = document.getElementById('admin-fetch-logs');
  el.innerHTML = `<div class="empty-state"><div class="inline-spinner"></div><div class="empty-state-title">조회 로그를 불러오는 중입니다</div></div>`;
  try {
    const r = await fetch('/api/admin/fetch-logs');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '조회 로그 로드 실패');
    const logs = data.logs || [];
    if (!logs.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-title">아직 조회 로그가 없습니다</div></div>';
      return;
    }
    el.innerHTML = logs.map(log => {
      const items = (log.items || []).slice(0, 12);
      const slowest = [...items].sort((a, b) => Number(b.elapsedMs || 0) - Number(a.elapsedMs || 0)).slice(0, 5);
      const ok = Number(log.ok || 0);
      const errors = Number(log.errors || 0);
      return `
        <div class="fetch-log-row">
          <div class="fetch-log-top">
            <div>
              <div class="fetch-log-title">${escHtml(fetchModeLabel(log))} · ${escHtml(log.email || log.user_id || '-')}</div>
              <div class="fetch-log-meta">${formatAdminDate(log.startedAt)} · 총 ${formatElapsed(log.elapsedMs)} · ${ok}/${log.total || 0} 성공 · 실패 ${errors}</div>
            </div>
            <span class="badge ${errors ? 'badge-red' : 'badge-green'}">${log.scheduled ? '자동' : '수동'}</span>
          </div>
          <div class="fetch-log-items">
            ${slowest.map(item => `
              <div class="fetch-log-item" title="${escHtml(item.error || '')}">
                <div class="fetch-log-item-name">${escHtml(item.name || '-')}</div>
                <div>${formatElapsed(item.elapsedMs)}</div>
                <div><span class="badge ${item.status === 'ok' ? 'badge-green' : 'badge-red'}">${escHtml(item.status || '-')}</span></div>
              </div>
            `).join('') || '<div class="admin-muted">상품별 로그 없음</div>'}
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-title">${escHtml(e.message || '조회 로그 로드 실패')}</div></div>`;
  }
}

async function loadAdminUsers() {
  if (!isAdminUser) return;
  const el = document.getElementById('admin-users');
  el.innerHTML = `<div class="empty-state"><div class="inline-spinner"></div><div class="empty-state-title">회원 목록을 불러오는 중입니다</div></div>`;
  try {
    const r = await fetch('/api/admin/users');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '회원 목록 로드 실패');
    const users = data.users || [];
    if (!users.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-title">회원이 없습니다</div></div>';
      return;
    }
    el.innerHTML = `
      <div class="admin-row admin-head">
        <div>이메일</div><div>가입 상태</div><div>현재 플랜</div><div>플랜 변경</div>
      </div>
      ${users.map(user => `
        <div class="admin-row">
          <div>
            <div class="admin-email" title="${escHtml(user.email)}">${escHtml(user.email || user.id)}</div>
            <div class="admin-muted">가입 ${formatAdminDate(user.created_at)}</div>
            ${renderPlanRequest(user)}
          </div>
          <div><span class="badge badge-green">가입 완료</span></div>
          <div>${renderUserPlanBadge(user)}</div>
          <div>${renderPlanActions(user)}</div>
        </div>
      `).join('')}`;
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-title">${escHtml(e.message || '회원 목록 로드 실패')}</div></div>`;
  }
}

async function setUserPlan(uid, plan, competitorLimit = null) {
  try {
    const body = {plan};
    if (competitorLimit !== null && competitorLimit !== undefined) body.competitor_limit = competitorLimit;
    const r = await fetch(`/api/admin/users/${uid}/plan`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '플랜 변경 실패');
    const limitText = data.competitor_limit ? ` · ${data.competitor_limit}개` : '';
    showToast(`${PLAN_LABELS[plan] || '선택한'} 플랜으로 변경됨${limitText}`);
    await loadAdminUsers();
  } catch (e) {
    showToast(e.message || '플랜 상태 변경 실패');
  }
}

function setCustomBusinessLimit(uid, currentLimit) {
  const value = prompt('비즈니스 상품 수량을 입력하세요 (1~1000):', currentLimit || 50);
  if (value === null) return;
  const limit = parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    showToast('상품 수량은 1개 이상 1000개 이하 숫자로 입력해주세요');
    return;
  }
  setUserPlan(uid, 'business', limit);
}

function formatAdminDate(value) {
  if (!value) return '—';
  const dt = new Date(value);
  return dt.toLocaleDateString('ko-KR') + ' ' + dt.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'});
}

// ─── Logout ──────────────────────────────────────────────────
async function doLogout() {
  await nativeFetch('/api/logout', {method:'POST'});
  localStorage.removeItem('naverMonitorAccessToken');
  localStorage.removeItem('naverMonitorRefreshToken');
  sessionStorage.removeItem(CONFIG_CACHE_KEY);
  sessionStorage.removeItem(HISTORY_CACHE_KEY);
  location.href = '/login';
}

// ─── UI utils ────────────────────────────────────────────────
function showLoading(text) {
  document.getElementById('loading-text').textContent = text || '처리 중...';
  document.getElementById('loading').classList.add('show');
}
function hideLoading() {
  document.getElementById('loading').classList.remove('show');
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// onclick 등 HTML 속성 안의 JS 문자열 리터럴에 넣을 값용.
// &#39;는 속성 디코딩 후 다시 '가 되어 escHtml만으로는 JS 문자열 탈출을 못 막는다.
function escJsAttr(str) {
  return escHtml(String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/\r?\n/g, '\\n'));
}

function shortErrorMessage(error) {
  const text = String(error || '').trim();
  if (!text) return '';
  if (text.includes('Wing') && text.includes('로그인')) return '로그인 필요';
  if (text.includes('Wing') && text.includes('상품을 찾지 못')) return '상품 미발견';
  if (text.includes('post-matching item not found')) return '상품 미발견';
  if (text.includes('post-matching metrics missing')) return '지표 없음';
  if (text.toLowerCase().includes('login')) return '로그인 필요';
  return text.length > 12 ? text.slice(0, 12) + '...' : text;
}

// ─── Start ───────────────────────────────────────────────────
init();
