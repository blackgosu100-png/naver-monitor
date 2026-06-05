#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.COUPANG_STOCK_HELPER_PORT || 8765);
const DEBUG_PORT = Number(process.env.COUPANG_STOCK_DEBUG_PORT || 9333);
const DEBUG_HOST = '127.0.0.1';
const PROFILE_DIR = process.env.COUPANG_STOCK_PROFILE_DIR ||
  path.resolve(__dirname, '..', '.coupang-stock-helper-profile');
const PAGE_WARMUP_MS = Number(process.env.COUPANG_STOCK_PAGE_WARMUP_MS || 350);
const PROBE_DELAY_MS = Number(process.env.COUPANG_STOCK_PROBE_DELAY_MS || 80);
const MAX_QUANTITY = Number(process.env.COUPANG_STOCK_MAX_QUANTITY || 99999);
const QUANTITY_FETCH_TIMEOUT_MS = Number(process.env.COUPANG_STOCK_QUANTITY_FETCH_TIMEOUT_MS || 4500);
const STOCK_ITEM_TIMEOUT_MS = Number(process.env.COUPANG_STOCK_ITEM_TIMEOUT_MS || 25000);
const AUTO_CLOSE_CHROME = process.env.COUPANG_STOCK_AUTO_CLOSE_CHROME !== '0';
const DEFAULT_STEPS = [100, 1000, 5000];
const HELPER_VERSION = '1.5.3';

let chromeProcess = null;
let helperStartedChrome = false;
let warmupPromise = null;
let sharedPage = null;
let stockQueue = Promise.resolve();
let warmupState = {
  startedAt: null,
  finishedAt: null,
  ok: false,
  error: '',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function findChromeExecutable() {
  const username = process.env.USERNAME || '';
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    username ? `C:\\Users\\${username}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe` : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Google Chrome executable not found');
}

async function fetchJson(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function isDebuggerReady() {
  try {
    await fetchJson(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/version`, {}, 500);
    return true;
  } catch {
    return false;
  }
}

async function waitForDebugger(timeoutMs = 7000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isDebuggerReady()) return true;
    await sleep(150);
  }
  throw new Error('Chrome remote debugging endpoint timeout');
}

async function ensureChrome() {
  if (await isDebuggerReady()) return;

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const chrome = findChromeExecutable();
  const args = [
    `--remote-debugging-address=${DEBUG_HOST}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--disable-features=PrivacySandboxSettings4',
    '--disable-popup-blocking',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--window-size=360,560',
    '--window-position=0,0',
    '--blink-settings=imagesEnabled=false',
    '--disable-infobars',
    '--disable-suggestions-ui',
    'about:blank',
  ];

  chromeProcess = spawn(chrome, args, {
    stdio: 'ignore',
    detached: false,
    windowsHide: false,
  });
  helperStartedChrome = true;
  chromeProcess.on('exit', () => {
    chromeProcess = null;
  });
  await waitForDebugger();
}

function warmupChrome() {
  if (warmupPromise) return warmupPromise;
  warmupState = {
    startedAt: Date.now(),
    finishedAt: null,
    ok: false,
    error: '',
  };
  warmupPromise = ensureChrome()
    .then(() => {
      warmupState.ok = true;
      warmupState.finishedAt = Date.now();
    })
    .catch(error => {
      warmupState.ok = false;
      warmupState.error = error && error.message ? error.message : String(error);
      warmupState.finishedAt = Date.now();
      warmupPromise = null;
    });
  return warmupPromise;
}

async function createTarget() {
  const base = `http://${DEBUG_HOST}:${DEBUG_PORT}/json/new?${encodeURIComponent('about:blank')}`;
  try {
    return await fetchJson(base, { method: 'PUT' }, 2500);
  } catch {
    return await fetchJson(base, {}, 2500);
  }
}

async function closeTarget(targetId) {
  if (!targetId) return;
  try {
    await fetch(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/close/${targetId}`);
  } catch {
    // best effort
  }
}

async function getSharedPage() {
  if (!(await isDebuggerReady())) {
    warmupPromise = null;
    sharedPage = null;
  }
  await warmupChrome();
  if (sharedPage && sharedPage.cdp) {
    try {
      await sharedPage.cdp.evaluate('document.readyState', 1000);
      return sharedPage;
    } catch {
      try { sharedPage.cdp.close(); } catch {}
      try { await closeTarget(sharedPage.targetId); } catch {}
      sharedPage = null;
    }
  }

  const target = await createTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await setupPage(cdp);
  sharedPage = { targetId: target.id, cdp };
  return sharedPage;
}

async function closeSharedPage() {
  if (!sharedPage) return;
  try { sharedPage.cdp.close(); } catch {}
  try { await closeTarget(sharedPage.targetId); } catch {}
  sharedPage = null;
}

async function closeDebugBrowser() {
  if (!helperStartedChrome) return;
  try {
    const version = await fetchJson(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/version`, {}, 500);
    if (version && version.webSocketDebuggerUrl) {
      const cdp = new CdpClient(version.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Browser.close', {}, 1000).catch(() => undefined);
      cdp.close();
      await sleep(350);
    }
  } catch {
    // best effort
  }
}

async function closeChromeAfterJob() {
  if (!AUTO_CLOSE_CHROME) return;
  await closeSharedPage().catch(() => undefined);
  await closeDebugBrowser().catch(() => undefined);
  warmupPromise = null;
  if (chromeProcess && !chromeProcess.killed) {
    chromeProcess.kill();
    chromeProcess = null;
  }
  helperStartedChrome = false;
}

function runStockJob(fn) {
  const job = stockQueue
    .then(fn, fn)
    .finally(() => closeChromeAfterJob());
  stockQueue = job.catch(() => undefined);
  return job;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 5000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', event => {
        clearTimeout(timer);
        reject(new Error(event && event.message ? event.message : 'CDP websocket error'));
      }, { once: true });
      ws.addEventListener('message', event => this.handleMessage(event.data));
      ws.addEventListener('close', () => {
        for (const { reject } of this.pending.values()) reject(new Error('CDP websocket closed'));
        this.pending.clear();
      });
    });
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const item = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) item.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else item.resolve(msg.result);
      return;
    }
    if (msg.method && this.listeners.has(msg.method)) {
      for (const listener of [...this.listeners.get(msg.method)]) listener(msg.params || {});
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const set = this.listeners.get(method) || new Set();
      this.listeners.set(method, set);
      const timer = setTimeout(() => {
        set.delete(onEvent);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      const onEvent = params => {
        clearTimeout(timer);
        set.delete(onEvent);
        resolve(params);
      };
      set.add(onEvent);
    });
  }

  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    }, timeoutMs + 1000);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function normalizeProductUrl(value) {
  let url = String(value || '').trim();
  if (!url) throw new Error('productUrl is required');
  if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, '')}`;
  return url;
}

function parseIdsFromUrl(productUrl) {
  const url = new URL(productUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  const productIndex = parts.indexOf('products');
  return {
    productId: productIndex >= 0 ? parts[productIndex + 1] || '' : '',
    itemId: url.searchParams.get('itemId') || '',
    vendorItemId: url.searchParams.get('vendorItemId') || '',
  };
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }
  return '';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveVendorItemIdFromHtml(html, itemId) {
  const decoded = (() => {
    try { return decodeURIComponent(html); } catch { return html; }
  })();
  const joined = [html, decoded]
    .join('\n')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");

  if (itemId) {
    const item = escapeRegExp(itemId);
    const paired = firstMatch(joined, [
      new RegExp(`itemId=${item}[^\\s"'<>]{0,900}vendorItemId=(\\d{8,})`, 'i'),
      new RegExp(`vendorItemId=(\\d{8,})[^\\s"'<>]{0,900}itemId=${item}`, 'i'),
      new RegExp(`"itemId"\\s*:\\s*"?${item}"?[\\s\\S]{0,1200}?"vendorItemId"\\s*:\\s*"?(\\d{8,})"?`, 'i'),
    ]);
    if (paired) return paired;
  }

  return firstMatch(joined, [
    /[?&]vendorItemId=(\d{8,})/i,
    /vendorItemId["'\\]*\s*[:=]\s*["'\\]*(\d{8,})/i,
    /\\"vendorItemId\\"\s*:\s*\\"?(\d{8,})/i,
    /vendor[_-]?item[_-]?id["'=:\s-]+(\d{8,})/i,
  ]);
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function visibleSalePriceFromText(value) {
  const lines = String(value || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const end = lines.findIndex((line) => /\uBC30\uC1A1|\uD310\uB9E4\uC790|\uC218\uB7C9|\uC7A5\uBC14\uAD6C\uB2C8|\uBC14\uB85C\uAD6C\uB9E4/.test(line));
  const main = lines.slice(0, end > 0 ? end : Math.min(lines.length, 80));
  const prices = [];
  for (const line of main) {
    if (/1\s*\uAC1C\uB2F9|\uCE90\uC2DC|\uC801\uB9BD|\uBC30\uC1A1/.test(line)) continue;
    const matches = line.match(/[0-9][0-9,]{3,}\s*\uC6D0/g) || [];
    for (const found of matches) {
      const n = numOrNull(found);
      if (n !== null) prices.push(n);
    }
  }
  return prices.length ? prices[0] : null;
}

function collectPriceDebugLines(value) {
  return String(value || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && /[0-9][0-9,]{3,}\s*\uC6D0|\uD560\uC778|\uCFE0\uD321\uD310\uB9E4\uAC00|\uD310\uB9E4\uC790/.test(line))
    .slice(0, 30);
}

function extractProductMetricsFromHtml(html, visibleText = '') {
  const source = String(html || '');
  const text = visibleText || stripHtml(source);
  function match(patterns) {
    for (const pattern of patterns) {
      const found = source.match(pattern) || text.match(pattern);
      if (found && found[1]) return found[1];
    }
    return '';
  }
  const visibleTextPrice = visibleSalePriceFromText(text);
  return {
    salePrice: visibleTextPrice !== null ? visibleTextPrice : numOrNull(match([
      /"finalPrice"\s*:\s*"?([0-9,]+)"?/i,
      /"couponPrice"\s*:\s*"?([0-9,]+)"?/i,
      /"discount(?:ed)?Price"\s*:\s*"?([0-9,]+)"?/i,
      /"salePrice"\s*:\s*"?([0-9,]+)"?/i,
      /"price"\s*:\s*"?([0-9,]{4,})"?/i,
      /([0-9,]{4,})\s*원\s*\([^)]*1\s*개당/i,
      /[0-9]+\s*%\s*[0-9,]{4,}\s*원[\s\S]{0,120}?([0-9,]{4,})\s*원/i,
      /([0-9,]{4,})\s*원/
    ])),
    ratingCount: numOrNull(match([
      /"ratingCount"\s*:\s*"?([0-9,]+)"?/i,
      /"reviewCount"\s*:\s*"?([0-9,]+)"?/i,
      /상품평\s*([0-9,]+)\s*개/,
      /리뷰\s*([0-9,]+)\s*개/
    ])),
  };
}

function deepValue(node, path) {
  let current = node;
  for (const part of path) {
    if (current == null) return null;
    current = current[part];
  }
  return current == null ? null : current;
}

function normalizeUnitPrice(value, quantity) {
  const n = numOrNull(value);
  if (n === null) return null;
  const q = Math.max(1, Math.floor(Number(quantity) || 1));
  if (q > 1 && n > 1000000 && n % q === 0) return n / q;
  return n;
}

function extractPriceFromQuantityInfo(data, quantity = 1) {
  const item = Array.isArray(data) ? data[0] : data;
  if (!item || typeof item !== 'object') return null;
  const candidates = [
    ['price', 'finalPrice'],
    ['price', 'couponPrice'],
    ['price', 'salePrice'],
    ['moduleData', 0, 'detailPriceBundle', 'finalPrice', 'price'],
    ['moduleData', 0, 'detailPriceBundle', 'finalPrice', 'displayPrice'],
    ['moduleData', 3, 'priceInfo', 'finalPrice', 'price'],
    ['moduleData', 3, 'priceInfo', 'finalPrice', 'displayPrice'],
    ['priceList', 1, 'priceAmount'],
    ['priceList', 0, 'priceAmount'],
  ];
  for (const path of candidates) {
    const price = normalizeUnitPrice(deepValue(item, path), quantity);
    if (price !== null && price > 0 && price < 10000000) return price;
  }
  return null;
}

async function extractProductMetricsFromPage(cdp, html, visibleText, debug = false) {
  const domMetrics = await cdp.evaluate(`(() => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function numOrNull(value) {
      if (value == null || value === '') return null;
      const cleaned = String(value).replace(/[^0-9.]/g, '');
      if (!cleaned) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    function firstPriceFromSelector(selector) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const el of nodes) {
        if (!visible(el)) continue;
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/1\\s*개당|캐시|적립|배송/.test(text)) continue;
        const matches = text.match(/[0-9][0-9,]{3,}\\s*원/g) || [];
        for (const found of matches) {
          const n = numOrNull(found);
          if (n !== null) return { value: n, selector, text };
        }
      }
      return null;
    }
    const priceSelectors = [
      '.prod-price .total-price strong',
      '.prod-price .total-price',
      '.prod-sale-price .total-price strong',
      '.prod-sale-price .total-price',
      '.prod-coupon-price .total-price strong',
      '.prod-coupon-price .total-price',
      '.total-price strong',
      '.total-price'
    ];
    let price = null;
    for (const selector of priceSelectors) {
      price = firstPriceFromSelector(selector);
      if (price) break;
    }
    const reviewSelectors = [
      '.sdp-review__average__total-star__info-count',
      '.prod-review-count',
      '[class*="review"][class*="count"]'
    ];
    let ratingCount = null;
    for (const selector of reviewSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const el of nodes) {
        if (!visible(el)) continue;
        const text = el.textContent || '';
        const m = text.match(/[0-9][0-9,]*/);
        if (m) {
          ratingCount = numOrNull(m[0]);
          if (ratingCount !== null) break;
        }
      }
      if (ratingCount !== null) break;
    }
    return {
      salePrice: price ? price.value : null,
      priceSource: price ? price.selector : '',
      priceText: price ? price.text : '',
      ratingCount
    };
  })()`, 8000).catch(() => null);

  const fallback = extractProductMetricsFromHtml(html, visibleText);
  return {
    salePrice: domMetrics && domMetrics.salePrice !== null ? domMetrics.salePrice : fallback.salePrice,
    ratingCount: domMetrics && domMetrics.ratingCount !== null ? domMetrics.ratingCount : fallback.ratingCount,
    priceSource: domMetrics && domMetrics.salePrice !== null ? domMetrics.priceSource : 'text-fallback',
    priceText: domMetrics && domMetrics.salePrice !== null ? domMetrics.priceText : '',
    ...(debug ? { fallbackSalePrice: fallback.salePrice } : {}),
  };
}

function normalizeDeliveryText(text) {
  if (!text) return '';
  return stripHtml(text)
    .replace(/\s*\([^)]*내 주문 시[^)]*\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function flattenDeliveryText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return stripHtml(value);
  if (Array.isArray(value)) return value.map(flattenDeliveryText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.values(value).map(flattenDeliveryText).filter(Boolean).join(' ');
  }
  return stripHtml(value);
}

function scoreDeliveryNode(node) {
  if (!node || typeof node !== 'object') return 0;
  let score = 0;
  if ('descriptions' in node) score += 3;
  if ('type' in node) score += 2;
  if ('speedType' in node) score += 2;
  if ('logistics' in node) score += 1;
  if (node.extraDataMap && 'decodeDescriptions' in node.extraDataMap) score += 4;
  return score;
}

function findDeliveryNode(data) {
  const seen = new Set();
  let best = null;
  let bestScore = 0;
  function visit(node, depth) {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (node.delivery && typeof node.delivery === 'object') {
      const score = scoreDeliveryNode(node.delivery);
      if (score > bestScore) {
        best = node.delivery;
        bestScore = score;
      }
    }
    const selfScore = scoreDeliveryNode(node);
    if (selfScore > bestScore) {
      best = node;
      bestScore = selfScore;
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  }
  visit(data, 0);
  return bestScore >= 3 ? best : null;
}

function extractDeliveryState(data) {
  const delivery = findDeliveryNode(data);
  if (!delivery) return null;
  return {
    text: normalizeDeliveryText(
      (delivery.extraDataMap && typeof delivery.extraDataMap.decodeDescriptions === 'string'
        ? delivery.extraDataMap.decodeDescriptions.trim()
        : '') || flattenDeliveryText(delivery.descriptions)
    ),
    type: delivery.type == null ? null : delivery.type,
    speedType: delivery.speedType == null ? null : delivery.speedType,
    logistics: typeof delivery.logistics === 'boolean' ? delivery.logistics : null,
  };
}

function sameDeliveryState(a, b) {
  return !!a && !!b &&
    a.text === b.text &&
    a.type === b.type &&
    a.speedType === b.speedType &&
    a.logistics === b.logistics;
}

function buildQuantityInfoUrl(productId, vendorItemId, quantity) {
  const url = new URL('https://www.coupang.com/next-api/products/quantity-info');
  url.searchParams.set('productId', productId);
  url.searchParams.set('vendorItemId', vendorItemId);
  url.searchParams.set('quantity', String(quantity));
  return url.toString();
}

async function setupPage(cdp) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', {
    urls: [
      '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg',
      '*.css', '*.woff', '*.woff2', '*.ttf', '*.otf',
      '*.mp4', '*.webm', '*.avi',
    ],
  }).catch(() => undefined);
}

async function navigateProductPage(cdp, productUrl) {
  const loadPromise = Promise.race([
    cdp.waitFor('Page.loadEventFired', 10000).catch(() => null),
    cdp.waitFor('Page.domContentEventFired', 6000).catch(() => null),
  ]);
  await cdp.send('Page.navigate', { url: productUrl });
  await loadPromise;
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    const ready = await cdp.evaluate('document.readyState').catch(() => '');
    const href = await cdp.evaluate('location.href').catch(() => '');
    if (String(href).includes('/products/') && ready && ready !== 'loading') break;
    await sleep(120);
  }
  const priceEnd = Date.now() + 2500;
  while (Date.now() < priceEnd) {
    const hasPrice = await cdp.evaluate(`(() => {
      const selectors = [
        '.prod-price .total-price',
        '.prod-sale-price .total-price',
        '.prod-coupon-price .total-price',
        '.total-price',
        '[class*="price"]'
      ];
      return selectors.some((selector) => {
        const el = document.querySelector(selector);
        return el && /[0-9][0-9,]{3,}\\s*원/.test(el.textContent || '');
      });
    })()`).catch(() => false);
    if (hasPrice) break;
    await sleep(120);
  }
  await sleep(PAGE_WARMUP_MS);
}

async function ensureCoupangOriginPage(cdp) {
  const href = await cdp.evaluate('location.href').catch(() => '');
  if (/^https:\/\/(?:www\.)?coupang\.com\//i.test(String(href || ''))) return;
  const loadPromise = Promise.race([
    cdp.waitFor('Page.loadEventFired', 8000).catch(() => null),
    cdp.waitFor('Page.domContentEventFired', 5000).catch(() => null),
  ]);
  await cdp.send('Page.navigate', { url: 'https://www.coupang.com/' });
  await loadPromise;
  await sleep(150);
}

async function fetchQuantityInfo(cdp, productId, vendorItemId, quantity) {
  const requestUrl = buildQuantityInfoUrl(productId, vendorItemId, quantity);
  const expression = `(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ${JSON.stringify(QUANTITY_FETCH_TIMEOUT_MS)});
    try {
      const res = await fetch(${JSON.stringify(requestUrl)}, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (error) {
      return { ok: false, status: 0, text: '', error: error && error.message ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  })()`;
  let lastResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await cdp.evaluate(expression, QUANTITY_FETCH_TIMEOUT_MS + 2500);
    lastResult = result;
    if (result && result.ok && result.text) {
      try {
        return JSON.parse(result.text);
      } catch {
        throw new Error(`quantity-info JSON parse failed (${quantity})`);
      }
    }
    if (attempt < 3 && (!result || !result.text || result.status === 403 || result.status === 429)) {
      await sleep(700 * attempt);
      continue;
    }
    break;
  }
  if (!lastResult || !lastResult.text) throw new Error(`empty quantity-info response (${quantity})`);
  throw new Error(lastResult.error || `quantity-info HTTP ${lastResult.status} (${quantity})`);
}

async function fetchQuantityInfoBatch(cdp, productId, vendorItemId, quantities) {
  const unique = [...new Set(quantities.map((q) => Math.max(1, Math.floor(Number(q) || 1))))];
  if (!unique.length) return [];
  const requests = unique.map((quantity) => ({
    quantity,
    url: buildQuantityInfoUrl(productId, vendorItemId, quantity),
  }));
  const expression = `(async () => {
    const requests = ${JSON.stringify(requests)};
    return await Promise.all(requests.map(async (item) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${JSON.stringify(QUANTITY_FETCH_TIMEOUT_MS)});
      try {
        const res = await fetch(item.url, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
          }
        });
        return { quantity: item.quantity, ok: res.ok, status: res.status, text: await res.text() };
      } catch (error) {
        return { quantity: item.quantity, ok: false, status: 0, text: '', error: error && error.message ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    }));
  })()`;

  const rows = await cdp.evaluate(expression, QUANTITY_FETCH_TIMEOUT_MS + 3500);
  const out = [];
  for (const row of rows || []) {
    if (row && row.ok && row.text) {
      try {
        out.push({ quantity: row.quantity, data: JSON.parse(row.text) });
        continue;
      } catch {
        // Fall through to single retry below.
      }
    }
    out.push({ quantity: row && row.quantity, error: row && (row.error || `HTTP ${row.status}`) });
  }
  return out;
}

function collectQuantityHints(data) {
  const hints = [];
  const seen = new Set();
  const keyPattern = /stock|remain|available|availability|limit|max|min|quantity|qty|count|order/i;
  function walk(node, path, depth) {
    if (node == null || depth > 8 || hints.length >= 80) return;
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.slice(0, 8).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (keyPattern.test(key) && (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')) {
        hints.push({ path: nextPath, value });
      }
      if (value && typeof value === 'object') walk(value, nextPath, depth + 1);
    }
  }
  walk(data, '', 0);
  return hints;
}

function collectTextHints(data) {
  const hints = [];
  const seen = new Set();
  const textPattern = /\d|남음|재고|품절|구매|수량|가능|최대|최소|remaining|stock|available|quantity|limit/i;
  function walk(node, path, depth) {
    if (node == null || depth > 8 || hints.length >= 120) return;
    if (typeof node === 'string') {
      const text = node.replace(/\s+/g, ' ').trim();
      if (text && text.length <= 500 && textPattern.test(text)) hints.push({ path, text });
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.slice(0, 12).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      walk(value, nextPath, depth + 1);
    }
  }
  walk(data, '', 0);
  return hints;
}

async function estimateStock(payload) {
  const startedAt = Date.now();
  const deadline = startedAt + STOCK_ITEM_TIMEOUT_MS;
  const page = await getSharedPage();
  const cdp = page.cdp;

  let apiCalls = 0;
  try {
    const productUrl = normalizeProductUrl(payload.productUrl);
    let { productId, itemId, vendorItemId } = parseIdsFromUrl(productUrl);
    productId = String(payload.productId || productId || '');
    itemId = String(payload.itemId || itemId || '');
    vendorItemId = String(payload.vendorItemId || vendorItemId || '');

    const fastStockOnly = !!payload.fastStockOnly && productId && vendorItemId;
    let productHtml = '';
    let productText = '';
    let productMetrics = { salePrice: null, ratingCount: null, priceSource: '', priceText: '' };
    let debugMetrics = null;
    if (fastStockOnly) {
      await ensureCoupangOriginPage(cdp);
    } else {
      await navigateProductPage(cdp, productUrl);
      if (!vendorItemId) {
        productHtml = await cdp.evaluate('document.documentElement ? document.documentElement.outerHTML : ""', 8000);
        const html = productHtml;
        vendorItemId = resolveVendorItemIdFromHtml(String(html || ''), itemId);
      }
      if (!productHtml) {
        productHtml = await cdp.evaluate('document.documentElement ? document.documentElement.outerHTML : ""', 8000).catch(() => '');
      }
      productText = await cdp.evaluate('document.body ? document.body.innerText : ""', 8000).catch(() => '');
      productMetrics = await extractProductMetricsFromPage(cdp, productHtml, productText, !!payload.debug);
      debugMetrics = payload.debug ? {
        priceLines: collectPriceDebugLines(productText),
        textSalePrice: visibleSalePriceFromText(productText),
        priceSource: productMetrics.priceSource || '',
        priceText: productMetrics.priceText || '',
        fallbackSalePrice: productMetrics.fallbackSalePrice,
      } : null;
    }
    if (!productId || !vendorItemId) {
      throw new Error('productId or vendorItemId not found');
    }

    const cache = new Map();
    async function probe(quantity, baseline) {
      if (Date.now() > deadline) throw new Error('stock item timeout');
      quantity = Math.max(1, Math.floor(Number(quantity) || 1));
      if (cache.has(quantity)) return cache.get(quantity);
      if (apiCalls > 0) await sleep(PROBE_DELAY_MS);
      apiCalls += 1;
      const json = await fetchQuantityInfo(cdp, productId, vendorItemId, quantity);
      const state = extractDeliveryState(json);
      const result = {
        quantity,
        data: json,
        state,
        sameAsBaseline: baseline ? sameDeliveryState(baseline, state) : false,
      };
      cache.set(quantity, result);
      return result;
    }

    async function probeMany(quantities, baseline) {
      if (Date.now() > deadline) throw new Error('stock item timeout');
      const wanted = [...new Set(quantities
        .map((q) => Math.max(1, Math.floor(Number(q) || 1)))
        .filter((q) => !cache.has(q)))];
      if (wanted.length) {
        if (apiCalls > 0) await sleep(PROBE_DELAY_MS);
        apiCalls += wanted.length;
        const rows = await fetchQuantityInfoBatch(cdp, productId, vendorItemId, wanted);
        for (const row of rows) {
          const quantity = Math.max(1, Math.floor(Number(row.quantity) || 1));
          if (!quantity || cache.has(quantity) || !row.data) continue;
          const state = extractDeliveryState(row.data);
          cache.set(quantity, {
            quantity,
            data: row.data,
            state,
            sameAsBaseline: baseline ? sameDeliveryState(baseline, state) : false,
          });
        }
        for (const quantity of wanted) {
          if (cache.has(quantity)) continue;
          const json = await fetchQuantityInfo(cdp, productId, vendorItemId, quantity);
          const state = extractDeliveryState(json);
          cache.set(quantity, {
            quantity,
            data: json,
            state,
            sameAsBaseline: baseline ? sameDeliveryState(baseline, state) : false,
          });
        }
      }
      return [...new Set(quantities.map((q) => Math.max(1, Math.floor(Number(q) || 1))))]
        .map((q) => cache.get(q))
        .filter(Boolean)
        .sort((a, b) => a.quantity - b.quantity);
    }

    let baselineProbe = await probe(1);
    if (!baselineProbe.state) {
      cache.delete(1);
      await sleep(1200);
      baselineProbe = await probe(1);
    }
    if (!baselineProbe.state) throw new Error('baseline delivery state not found');
    const baseline = baselineProbe.state;
    const quantityPrice = extractPriceFromQuantityInfo(baselineProbe.data, 1);
    if (quantityPrice !== null) {
      productMetrics.salePrice = quantityPrice;
      productMetrics.priceSource = 'quantity-info:1';
      productMetrics.priceText = String(quantityPrice);
    }
    if (debugMetrics) {
      debugMetrics.quantityInfoUnitPrice = quantityPrice;
      debugMetrics.priceSource = productMetrics.priceSource || debugMetrics.priceSource || '';
      debugMetrics.priceText = productMetrics.priceText || debugMetrics.priceText || '';
      try {
        const highJson = await fetchQuantityInfo(cdp, productId, vendorItemId, MAX_QUANTITY);
        debugMetrics.highQuantity = MAX_QUANTITY;
        debugMetrics.highQuantityHints = collectQuantityHints(highJson);
        debugMetrics.highTextHints = collectTextHints(highJson);
        debugMetrics.highDeliveryState = extractDeliveryState(highJson);
      } catch (error) {
        debugMetrics.highQuantityError = error && error.message ? error.message : String(error);
      }
    }

    let low = 1;
    let high = null;
    async function applyProbe(quantity) {
      const tested = await probe(quantity, baseline);
      if (tested.sameAsBaseline) {
        low = Math.max(low, quantity);
        return false;
      }
      high = high == null ? quantity : Math.min(high, quantity);
      return true;
    }

    let expected = Number(payload.expectedStock);
    if (Number.isFinite(expected) && expected > 1) {
      expected = Math.min(MAX_QUANTITY, Math.max(2, Math.floor(expected)));
      const next = Math.min(MAX_QUANTITY, expected + 1);
      const expectedPair = await probeMany(next > expected ? [expected, next] : [expected], baseline);
      const expectedProbe = expectedPair.find((item) => item.quantity === expected) || await probe(expected, baseline);
      if (expectedProbe.sameAsBaseline) {
        low = expected;
        const nextProbe = expectedPair.find((item) => item.quantity === next);
        if (nextProbe) {
          if (nextProbe.sameAsBaseline) low = Math.max(low, nextProbe.quantity);
          else high = high == null ? nextProbe.quantity : Math.min(high, nextProbe.quantity);
        } else if (next > low) {
          await applyProbe(next);
        }
      } else {
        high = expected;
        const nearOffsets = [1, 2, 3, 5, 8, 13, 21, 34];
        const nearQuantities = nearOffsets
          .map((offset) => expected - offset)
          .filter((quantity) => quantity > 1);
        const nearProbes = await probeMany(nearQuantities, baseline);
        for (const nearProbe of nearProbes.sort((a, b) => b.quantity - a.quantity)) {
          if (nearProbe.sameAsBaseline) {
            low = nearProbe.quantity;
            break;
          }
          high = Math.min(high, nearProbe.quantity);
        }
        let step = Math.max(55, Math.ceil(expected * 0.18));
        let candidate = Math.max(1, expected - step);
        while (candidate > 1 && low === 1) {
          const tested = await probe(candidate, baseline);
          if (tested.sameAsBaseline) {
            low = candidate;
            break;
          }
          high = Math.min(high, candidate);
          step *= 2;
          candidate = Math.max(1, expected - step);
        }
      }
    }

    if (high == null) {
      const firstWave = [100, 1000, 3000, 10000, 30000, MAX_QUANTITY]
        .filter((step) => step > low && step <= MAX_QUANTITY);
      const waveProbes = await probeMany(firstWave, baseline);
      for (const tested of waveProbes) {
        if (tested.sameAsBaseline) {
          low = Math.max(low, tested.quantity);
        } else {
          high = high == null ? tested.quantity : Math.min(high, tested.quantity);
          break;
        }
      }
    }

    if (high == null) {
      return {
        ok: true,
        stock: null,
        overLimit: true,
        reason: '5000+ or delivery boundary not found',
        productId,
        itemId,
        vendorItemId,
        salePrice: productMetrics.salePrice,
        priceSource: productMetrics.priceSource || '',
        ratingCount: productMetrics.ratingCount,
        apiCalls,
        elapsedMs: Date.now() - startedAt,
        source: 'local-cdp-helper',
        helperVersion: HELPER_VERSION,
        ...(debugMetrics ? { debug: debugMetrics } : {}),
      };
    }

    while (high - low > 1) {
      if (Date.now() > deadline) throw new Error('stock item timeout');
      const span = high - low;
      const mids = [
        low + Math.floor(span / 4),
        low + Math.floor(span / 2),
        low + Math.floor((span * 3) / 4),
      ].filter((q) => q > low && q < high);
      const midProbes = await probeMany(mids.length ? mids : [Math.floor((low + high) / 2)], baseline);
      for (const midProbe of midProbes) {
        if (midProbe.sameAsBaseline) {
          low = Math.max(low, midProbe.quantity);
        } else {
          high = Math.min(high, midProbe.quantity);
          break;
        }
      }
    }

    return {
      ok: true,
      stock: low,
      options: [{ name: '재고 추정', qty: low }],
      productId,
      itemId,
      vendorItemId,
      salePrice: productMetrics.salePrice,
      priceSource: productMetrics.priceSource || '',
      ratingCount: productMetrics.ratingCount,
      apiCalls,
      elapsedMs: Date.now() - startedAt,
      source: 'local-cdp-helper',
      helperVersion: HELPER_VERSION,
      ...(debugMetrics ? { debug: debugMetrics } : {}),
    };
  } catch (error) {
    try { await closeSharedPage(); } catch {}
    throw error;
  }
}

async function estimateStockBatch(payload) {
  const startedAt = Date.now();
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const results = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const itemStartedAt = Date.now();
    try {
      const result = await estimateStock(item);
      results.push({
        index,
        id: item.id || '',
        name: item.name || '',
        ok: !!(result && result.ok),
        elapsedMs: Date.now() - itemStartedAt,
        ...result,
      });
    } catch (error) {
      results.push({
        index,
        id: item.id || '',
        name: item.name || '',
        ok: false,
        elapsedMs: Date.now() - itemStartedAt,
        error: error && error.message ? error.message : String(error),
      });
    }
  }
  return {
    ok: true,
    source: 'local-cdp-helper-batch',
    helperVersion: HELPER_VERSION,
    total: items.length,
    elapsedMs: Date.now() - startedAt,
    results,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    jsonResponse(res, 200, { ok: true });
    return;
  }
  try {
    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, {
        ok: true,
        service: 'coupang-stock-helper',
        version: HELPER_VERSION,
        port: PORT,
        debugPort: DEBUG_PORT,
        autoCloseChrome: AUTO_CLOSE_CHROME,
        sharedPageReady: !!sharedPage,
        warmup: {
          ...warmupState,
          elapsedMs: warmupState.startedAt
            ? ((warmupState.finishedAt || Date.now()) - warmupState.startedAt)
            : null,
        },
      });
      return;
    }
    if ((req.method === 'GET' || req.method === 'POST') && req.url === '/shutdown') {
      jsonResponse(res, 200, { ok: true, message: 'shutting down' });
      setTimeout(() => {
        closeSharedPage()
          .catch(() => undefined)
          .finally(() => {
            if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
            server.close(() => process.exit(0));
          });
      }, 50);
      return;
    }
    if (req.method === 'POST' && req.url === '/stock') {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const result = await runStockJob(() => estimateStock(payload));
      jsonResponse(res, 200, result);
      return;
    }
    if (req.method === 'POST' && req.url === '/stock/batch') {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const result = await runStockJob(() => estimateStockBatch(payload));
      jsonResponse(res, 200, result);
      return;
    }
    jsonResponse(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    jsonResponse(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[coupang-stock-helper] listening on http://127.0.0.1:${PORT}`);
  console.log(`[coupang-stock-helper] chrome debug port ${DEBUG_PORT}`);
  console.log('[coupang-stock-helper] warming up Chrome...');
  warmupChrome()
    .then(() => getSharedPage())
    .then(() => {
      const elapsed = warmupState.finishedAt - warmupState.startedAt;
      console.log(`[coupang-stock-helper] Chrome ready (${elapsed}ms), shared page ready`);
    })
    .catch(error => {
      console.error('[coupang-stock-helper] Chrome warmup failed:', error && error.message ? error.message : error);
    });
});

process.on('SIGINT', () => {
  closeSharedPage()
    .catch(() => undefined)
    .finally(() => {
      if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
      process.exit(0);
    });
});
