(function() {
  if (window.__naverMonitorCoupangOverlayLoaded) return;
  window.__naverMonitorCoupangOverlayLoaded = true;

  var MAX_PRODUCTS_PER_SCAN = 24;
  var CONCURRENCY = 2;
  var button = null;
  var retryButton = null;
  var overlayEnabled = false;
  var queuedKeys = new Set();
  var finishedKeys = new Set();
  var resultCache = new Map();
  var pendingCardsByKey = new Map();
  var queue = [];
  var activeWorkers = 0;
  var totalQueued = 0;
  var totalDone = 0;
  var scanTimer = null;

  function fmtNumber(value) {
    if (value === null || value === undefined || value === '') return '-';
    var n = Number(value);
    if (!Number.isFinite(n)) return '-';
    return n.toLocaleString();
  }

  function fmtNumberWithBound(value, lowerBound) {
    var text = fmtNumber(value);
    return text === '-' ? text : text + (lowerBound ? '+' : '');
  }

  function priceNumber(text) {
    var m = String(text || '').replace(/,/g, '').match(/(\d{3,})/);
    return m ? Number(m[1]) : null;
  }

  function isVisibleNode(node) {
    if (!node || !node.getBoundingClientRect) return false;
    var r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isOldPriceNode(node) {
    var current = node;
    for (var i = 0; i < 4 && current; i++) {
      var className = String(current.className || '');
      if (/base|origin|original|list|strike|through|discount-rate|discountRate/i.test(className)) return true;
      try {
        var deco = getComputedStyle(current).textDecorationLine || '';
        if (/line-through/i.test(deco)) return true;
      } catch(e) {}
      current = current.parentElement;
    }
    return false;
  }

  function parseCurrentPrice(card) {
    function addLineCandidate(list, value, score, order, originalIndex) {
      if (value === null) return;
      list.push({ value: value, score: score, order: order, originalIndex: originalIndex || 0 });
    }

    var text = card.innerText || '';
    var lines = text.split(/\n+/).map(function(line) { return line.trim(); }).filter(Boolean);
    function priceValuesFromLine(line) {
      return (String(line || '').match(/[\d,]{3,}\s*원/g) || [])
        .map(function(match) { return priceNumber(match); })
        .filter(function(value) { return value !== null; });
    }
    var lineCandidates = [];
    lines.forEach(function(line, index) {
      if (/최대|적립|도착|배송|무료배송|로켓|리뷰|상품평|모레|내일|오늘/i.test(line)) return;
      var matches = line.match(/[\d,]{3,}\s*원/g) || [];
      if (!matches.length) return;
      var score = 10;
      var hasPercent = /%/.test(line);
      if (hasPercent && matches.length > 1) score += 45;
      if (/판매가|쿠폰|와우|즉시|할인가|최종|타임할인/i.test(line)) score += 35;
      if (/정가|할인\s*$/i.test(line)) score -= 45;
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
    if (lineCandidates.length) {
      lineCandidates.sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (b.order !== a.order) return b.order - a.order;
        return a.value - b.value;
      });
      return lineCandidates[0].value;
    }

    var selectors = [
      '[class*="price-value"]',
      '[class*="sales-price"]',
      '[class*="sale-price"]',
      '[class*="discount-price"]'
    ];
    var candidates = [];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = Array.from(card.querySelectorAll(selectors[i]));
      for (var j = 0; j < nodes.length; j++) {
        if (!isVisibleNode(nodes[j])) continue;
        var text = String(nodes[j].textContent || '').trim();
        if (!text || /%/.test(text) || isOldPriceNode(nodes[j])) continue;
        var n = priceNumber(text);
        if (n !== null) {
          var className = String(nodes[j].className || '');
          var score = 10;
          if (/sales|sale|final|price-value/i.test(className)) score += 20;
          candidates.push({ value: n, score: score });
        }
      }
    }
    if (candidates.length) {
      candidates.sort(function(a, b) { return b.score - a.score; });
      return candidates[0].value;
    }
    return null;
  }

  function parsePublicMonthlyFromText(text) {
    if (!text) return null;
    var normalized = String(text)
      .replace(/\\u([0-9a-fA-F]{4})/g, function(_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      })
      .replace(/\\"/g, '"')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    var patterns = [
      { re: /한\s*달(?:간)?\s*([0-9,]+)\s*명\s*이상\s*구매/, lowerBound: true },
      { re: /한\s*달(?:간)?\s*([0-9,]+)\s*명\s*구매/, lowerBound: true },
      { re: /월\s*([0-9,]+)\s*명\s*이상\s*구매/, lowerBound: true },
      { re: /socialProofNumUsers\s*["']?\s*:\s*(\d+)/, lowerBound: true }
    ];
    for (var i = 0; i < patterns.length; i++) {
      var match = normalized.match(patterns[i].re);
      if (match && match[1]) {
        return {
          total: Number(String(match[1]).replace(/,/g, '')),
          lowerBound: patterns[i].lowerBound
        };
      }
    }
    return null;
  }

  async function fetchPublicMonthlyFromProductPage(url) {
    var controller = null;
    var timer = null;
    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timer = setTimeout(function() { controller.abort(); }, 8000);
      }
      var res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      var text = await res.text();
      return parsePublicMonthlyFromText(text);
    } catch(e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function parseProductName(card, anchor, img) {
    var alt = String((img && img.alt) || '').trim();
    if (alt && alt.length >= 4 && !/image|이미지|thumbnail/i.test(alt)) return alt.slice(0, 120);

    var nameNode = card.querySelector('[class*="name"], [class*="title"]');
    var name = String((nameNode && nameNode.textContent) || '').trim();
    if (name && name.length <= 140 && !/원|%|무료배송|로켓/.test(name)) return name;

    var anchorText = String((anchor && anchor.textContent) || '').trim();
    if (anchorText && anchorText.length <= 140 && !/원|%|무료배송|로켓/.test(anchorText)) return anchorText;

    var lines = String(card.innerText || '').split(/\n+/).map(function(line) { return line.trim(); }).filter(Boolean);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.length < 4 || line.length > 120) continue;
      if (/원|%|로켓|무료배송|도착|적립|광고|BEST|쿠팡추천|타임할인|^\(?\d[\d,]*\)?$/.test(line)) continue;
      return line;
    }
    return '쿠팡 상품';
  }

  function productIdFromUrl(url) {
    var m = String(url || '').match(/\/products\/(\d+)/);
    return m ? m[1] : '';
  }

  function productKeyFromUrl(url) {
    try {
      var u = new URL(url, location.href);
      return [
        productIdFromUrl(u.href),
        u.searchParams.get('itemId') || '',
        u.searchParams.get('vendorItemId') || ''
      ].join(':');
    } catch(e) {
      return productIdFromUrl(url) || String(url || '').split(/[?#]/)[0];
    }
  }

  function refineProductKey(key, name, price) {
    var value = String(key || '');
    if (!/^\d+::$/.test(value)) return value;
    return value + ':' + String(price || '') + ':' + String(name || '').replace(/\s+/g, '').slice(0, 40);
  }

  function visibleEnough(el) {
    var r = el.getBoundingClientRect();
    return r.width > 160 && r.height > 180 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  function isMainProductCard(card, img) {
    if (!card || !img) return false;
    var cardRect = card.getBoundingClientRect();
    var imgRect = img.getBoundingClientRect();
    if (cardRect.width < 180 || cardRect.height < 220) return false;
    if (cardRect.width > 430 || cardRect.height > 680) return false;
    if (imgRect.width < 110 || imgRect.height < 110) return false;
    if (cardRect.left > window.innerWidth - 260 && cardRect.width < 260) return false;
    var text = card.innerText || '';
    return /원/.test(text) && /\/products\//.test(card.innerHTML || '');
  }

  function cardFromAnchor(anchor) {
    var node = anchor;
    var fallback = null;
    for (var i = 0; i < 6 && node && node !== document.body; i++) {
      if (node.querySelector && visibleEnough(node)) {
        var img = node.querySelector('img');
        if (isMainProductCard(node, img)) return node;
        if (!fallback && img && node.matches('li, [class*="search-product"], [class*="ProductUnit"]')) fallback = node;
      }
      node = node.parentElement;
    }
    return fallback || anchor.closest('li, [class*="search-product"], [class*="ProductUnit"]') || anchor.parentElement;
  }

  function scanProducts() {
    var seenCards = new Set();
    var items = [];
    var anchors = Array.from(document.querySelectorAll('a[href*="/products/"]'));
    anchors.forEach(function(anchor) {
      if (items.length >= MAX_PRODUCTS_PER_SCAN) return;
      var href = anchor.href || '';
      var pid = productIdFromUrl(href);
      if (!pid) return;
      var card = cardFromAnchor(anchor);
      if (!card || !visibleEnough(card)) return;
      if (seenCards.has(card)) return;
      var img = card.querySelector('img');
      if (!isMainProductCard(card, img)) return;
      seenCards.add(card);
      var name = parseProductName(card, anchor, img);
      var price = parseCurrentPrice(card);
      items.push({
        key: refineProductKey(productKeyFromUrl(href), name, price),
        pid: pid,
        url: href,
        name: name,
        price: price,
        card: card
      });
    });
    return items;
  }

  function ensureCardPosition(card) {
    var style = getComputedStyle(card);
    if (style.position === 'static') card.style.position = 'relative';
  }

  function setOverlay(card, state, data) {
    ensureCardPosition(card);
    var box = card.querySelector(':scope > .nm-coupang-overlay');
    if (!box) {
      box = document.createElement('div');
      box.className = 'nm-coupang-overlay';
      card.appendChild(box);
    }
    box.dataset.nmKey = data && data.__key ? data.__key : '';
    if (state === 'loading') {
      box.innerHTML = '<div class="nm-title">분석중</div><div class="nm-line">쿠팡 지표 조회...</div>';
      box.classList.remove('nm-error');
      return;
    }
    var retryHtml = data && data.__retryable
      ? '<button class="nm-card-retry" type="button" data-nm-key="' + escapeHtml(data.__key || '') + '">재조회</button>'
      : '';
    if (state === 'error') {
      box.classList.add('nm-error');
      box.innerHTML = '<div class="nm-title">조회실패</div><div class="nm-line">' + escapeHtml(friendlyError((data && data.error) || '데이터 없음')) + '</div>' + retryHtml;
      return;
    }
    var monthly = data && data.monthlySales != null ? Number(data.monthlySales) : null;
    var views = data && data.views28 != null ? Number(data.views28) : null;
    var cvr = data && data.cvr != null ? Number(data.cvr) : null;
    var revenue = data && data.monthlyRevenue != null ? Number(data.monthlyRevenue) : null;
    var price = data && data.salePrice != null ? Number(data.salePrice) : null;
    var monthlyLowerBound = !!(data && data.monthlySalesLowerBound);
    box.classList.remove('nm-error');
    box.innerHTML =
      '<div class="nm-title">' + (data && data.partial ? '예상(월) · 부분조회' : '예상(월)') + '</div>' +
      '<div class="nm-price">판매가 ' + fmtNumber(price) + '</div>' +
      '<div class="nm-line">월판매 <b>' + fmtNumberWithBound(monthly, monthlyLowerBound) + '</b></div>' +
      '<div class="nm-line">월매출 <b>' + fmtNumberWithBound(revenue, monthlyLowerBound) + '</b></div>' +
      '<div class="nm-line">조회수 <b>' + fmtNumber(views) + '</b></div>' +
      '<div class="nm-cvr">CVR ' + (cvr == null ? '-' : cvr.toFixed(2) + '%' + (monthlyLowerBound ? '+' : '')) + '</div>' +
      retryHtml;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function(ch) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
    });
  }

  function friendlyError(error) {
    var text = String(error || '');
    if (/Cannot read properties of null|Cannot read properties of undefined|reading 't|reading "t/i.test(text)) return 'Wing lookup temporary error';
    if (/Wing 검색 결과 없음/i.test(text)) return 'Wing 검색 결과 없음';
    if (/Wing|post-matching|해당 상품|찾지 못/i.test(text)) return 'Wing 상품 매칭 실패';
    if (/login|session|401|403/i.test(text)) return 'Wing 로그인 필요';
    if (/timed out|timeout/i.test(text)) return '조회 시간 초과';
    if (/metrics not found|monthly/i.test(text)) return '판매 지표 없음';
    return text.slice(0, 42);
  }

  function injectStyle() {
    if (document.getElementById('nm-coupang-overlay-style')) return;
    var style = document.createElement('style');
    style.id = 'nm-coupang-overlay-style';
    style.textContent = [
      '.nm-coupang-button{position:fixed;right:18px;bottom:22px;z-index:2147483647;border:0;border-radius:8px;background:#0f172a;color:#fff;font:700 13px/1.2 Arial,sans-serif;padding:11px 13px;box-shadow:0 8px 24px rgba(15,23,42,.24);cursor:pointer}',
      '.nm-coupang-button[disabled]{opacity:.7;cursor:wait}',
      '.nm-coupang-retry-button{bottom:66px;background:#14532d}',
      '.nm-coupang-retry-button[disabled]{background:#334155}',
      '.nm-coupang-overlay{position:absolute;left:8px;top:8px;z-index:2147483646;min-width:150px;max-width:210px;border-radius:6px;background:rgba(15,23,42,.86);color:#fff;font:700 12px/1.35 Arial,sans-serif;padding:7px 9px;box-shadow:0 6px 18px rgba(15,23,42,.24);pointer-events:auto}',
      '.nm-coupang-overlay.nm-error{background:rgba(127,29,29,.88)}',
      '.nm-coupang-overlay .nm-title{font-size:11px;color:#dbeafe;margin-bottom:3px}',
      '.nm-coupang-overlay .nm-price{display:inline-block;background:#fff;color:#111827;border-radius:3px;padding:1px 7px;margin-bottom:3px;font-weight:700}',
      '.nm-coupang-overlay .nm-line{white-space:nowrap}',
      '.nm-coupang-overlay .nm-cvr{color:#22c55e;margin-top:1px;font-weight:800}',
      '.nm-card-retry{pointer-events:auto;margin-top:5px;border:0;border-radius:4px;background:#fff;color:#0f172a;font:800 11px/1 Arial,sans-serif;padding:4px 7px;cursor:pointer}',
      '.nm-card-retry:hover{background:#dbeafe}'
    ].join('\n');
    document.documentElement.appendChild(style);
  }

  function updateButtonText() {
    if (!button) return;
    if (!overlayEnabled) {
      button.textContent = '쿠팡 지표 표시';
      if (retryButton) retryButton.style.display = 'none';
      return;
    }
    if (activeWorkers || queue.length) {
      button.textContent = '쿠팡 지표 조회중... ' + totalDone + '/' + totalQueued;
      if (retryButton) retryButton.disabled = true;
      return;
    }
    button.textContent = totalQueued ? '쿠팡 지표 ON ' + totalDone + '개' : '상품 카드 없음';
    updateRetryButton();
  }

  function isRetryableResult(cached) {
    if (!cached) return false;
    if (cached.state === 'error') return true;
    var data = cached.data || {};
    if (data.partial) return true;
    if (data.monthlySalesLowerBound) return true;
    if (data.monthlySales == null || data.views28 == null || data.cvr == null) return true;
    return false;
  }

  function retryableVisibleProducts() {
    if (!overlayEnabled) return [];
    return scanProducts().filter(function(item) {
      if (queuedKeys.has(item.key)) return false;
      return isRetryableResult(resultCache.get(item.key));
    });
  }

  function updateRetryButton() {
    if (!retryButton) return;
    var count = retryableVisibleProducts().length;
    retryButton.style.display = overlayEnabled && totalQueued ? 'block' : 'none';
    retryButton.disabled = !!(activeWorkers || queue.length || !count);
    retryButton.textContent = count ? '문제상품 재조회 ' + count + '개' : '문제상품 없음';
  }

  function enqueueRetryProducts() {
    overlayEnabled = true;
    var products = retryableVisibleProducts();
    var added = 0;
    products.forEach(function(item) {
      resultCache.delete(item.key);
      finishedKeys.delete(item.key);
      queuedKeys.add(item.key);
      pendingCardsByKey.set(item.key, [item.card]);
      queue.push(item);
      totalQueued++;
      added++;
      setOverlay(item.card, 'loading');
    });
    if (added) pumpQueue();
    updateButtonText();
  }

  function enqueueVisibleProducts() {
    if (!overlayEnabled) return;
    var products = scanProducts();
    var added = 0;
    products.forEach(function(item) {
      if (resultCache.has(item.key)) {
        applyCachedResult(item.card, resultCache.get(item.key));
        return;
      }
      if (queuedKeys.has(item.key)) {
        var waiting = pendingCardsByKey.get(item.key) || [];
        if (waiting.indexOf(item.card) < 0) waiting.push(item.card);
        pendingCardsByKey.set(item.key, waiting);
        setOverlay(item.card, 'loading');
        return;
      }
      queuedKeys.add(item.key);
      pendingCardsByKey.set(item.key, [item.card]);
      queue.push(item);
      totalQueued++;
      added++;
      setOverlay(item.card, 'loading');
    });
    if (added) pumpQueue();
    updateButtonText();
  }

  function applyCachedResult(card, cached) {
    if (!cached) return;
    setOverlay(card, cached.state, cached.data);
  }

  function applyResultToPendingCards(key, state, data) {
    var cards = pendingCardsByKey.get(key) || [];
    cards.forEach(function(card) {
      if (card && document.documentElement.contains(card)) setOverlay(card, state, data);
    });
    pendingCardsByKey.delete(key);
  }

  async function processItem(item) {
    try {
      var publicMonthly = await fetchPublicMonthlyFromProductPage(item.url);
      var response = await chrome.runtime.sendMessage({
        type: 'COUPANG_OVERLAY_ANALYZE',
        products: [{ pid: item.pid, url: item.url, name: item.name, price: item.price, publicMonthly: publicMonthly }]
      });
      var result = response && response.results && response.results[0] ? response.results[0] : {};
      var state = result.ok ? 'ok' : 'error';
      result.__key = item.key;
      result.__retryable = isRetryableResult({ state: state, data: result });
      var cached = { state: state, data: result };
      resultCache.set(item.key, cached);
      applyResultToPendingCards(item.key, state, result);
    } catch (e) {
      var errorResult = { error: e && e.message ? e.message : '조회 오류', __key: item.key, __retryable: true };
      resultCache.set(item.key, { state: 'error', data: errorResult });
      applyResultToPendingCards(item.key, 'error', errorResult);
    } finally {
      queuedKeys.delete(item.key);
      finishedKeys.add(item.key);
      totalDone++;
      activeWorkers--;
      updateButtonText();
      pumpQueue();
      updateRetryButton();
    }
  }

  function pumpQueue() {
    while (overlayEnabled && activeWorkers < CONCURRENCY && queue.length) {
      activeWorkers++;
      processItem(queue.shift());
    }
  }

  function enqueueSingleRetry(key) {
    if (!key || queuedKeys.has(key)) return;
    var item = scanProducts().find(function(product) { return product.key === key; });
    if (!item) return;
    overlayEnabled = true;
    resultCache.delete(key);
    finishedKeys.delete(key);
    queuedKeys.add(key);
    pendingCardsByKey.set(key, [item.card]);
    queue.push(item);
    totalQueued++;
    setOverlay(item.card, 'loading');
    pumpQueue();
    updateButtonText();
  }

  function scheduleScan() {
    if (!overlayEnabled) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function() {
      enqueueVisibleProducts();
      updateRetryButton();
    }, 250);
  }

  function runAnalyze() {
    overlayEnabled = true;
    enqueueVisibleProducts();
  }

  function init() {
    if (!/coupang\.com$/i.test(location.hostname)) return;
    injectStyle();
    if (button) return;
    button = document.createElement('button');
    button.className = 'nm-coupang-button';
    button.type = 'button';
    button.textContent = '쿠팡 지표 표시';
    button.addEventListener('click', runAnalyze);
    document.documentElement.appendChild(button);
    retryButton = document.createElement('button');
    retryButton.className = 'nm-coupang-button nm-coupang-retry-button';
    retryButton.type = 'button';
    retryButton.textContent = '문제상품 없음';
    retryButton.style.display = 'none';
    retryButton.addEventListener('click', enqueueRetryProducts);
    document.documentElement.appendChild(retryButton);
    document.addEventListener('click', function(event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var retry = target.closest('.nm-card-retry');
      if (!retry) return;
      event.preventDefault();
      event.stopPropagation();
      enqueueSingleRetry(retry.getAttribute('data-nm-key') || '');
    }, true);
    window.addEventListener('scroll', scheduleScan, { passive: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
