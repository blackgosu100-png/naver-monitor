// document_start, MAIN world
(function() {
  window.__naverStockCache = {};
  window.__coupangQuantityCache = {};

  function tryCache(url, responseText) {
    if (!responseText) return;
    if (!responseText.includes('stockQuantity') && !responseText.includes('optionCombinations')) return;
    try {
      var data = JSON.parse(responseText);
      var pidMatch = (url || '').match(/\/products\/(\d+)/);
      if (pidMatch) window.__naverStockCache[pidMatch[1]] = data;
    } catch(e) {}
  }

  function tryCoupangCache(url, responseText) {
    if (!responseText) return;
    if (!responseText.includes('PRODUCT_DETAIL_SOCIAL_PROOF_NUDGE') && !responseText.includes('socialProofNumUsers')) return;
    try {
      var data = JSON.parse(responseText);
      var pidMatch = (url || '').match(/[?&]productId=(\d+)/) || (location.pathname || '').match(/\/products\/(\d+)/);
      if (pidMatch) window.__coupangQuantityCache[pidMatch[1]] = data;
    } catch(e) {}
  }

  var _XHROpen = XMLHttpRequest.prototype.open;
  var _XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__xhrUrl = (typeof url === 'string') ? url : '';
    return _XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    var url = this.__xhrUrl;
    this.addEventListener('load', function() {
      tryCache(url, this.responseText);
      tryCoupangCache(url, this.responseText);
    });
    return _XHRSend.apply(this, arguments);
  };

  var _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = _fetch(input, init);
    p.then(function(resp) {
      resp.clone().text().then(function(text) {
        tryCache(url, text);
        tryCoupangCache(url, text);
      }).catch(function(){});
    }).catch(function(){});
    return p;
  };

  document.addEventListener('DOMContentLoaded', function() {
    var pid = (location.pathname.match(/\/products\/(\d+)/) || [])[1];
    if (!pid || window.__naverStockCache[pid]) return;

    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      var text = scripts[i].textContent;
      if (!text.includes('stockQuantity') && !text.includes('optionCombinations')) continue;

      var m = text.match(/window\.\w+\s*=\s*(\{[\s\S]+\})\s*;/);
      if (m) { try { var d = JSON.parse(m[1]); if (d) { window.__naverStockCache[pid] = d; return; } } catch(e) {} }

      m = text.match(/(?:var|let|const)\s+\w+\s*=\s*(\{[\s\S]+\})\s*;/);
      if (m) { try { var d2 = JSON.parse(m[1]); if (d2) { window.__naverStockCache[pid] = d2; return; } } catch(e) {} }

      try { var d3 = JSON.parse(text.trim()); if (d3 && typeof d3 === 'object') { window.__naverStockCache[pid] = d3; return; } } catch(e) {}
    }
  });
})();
