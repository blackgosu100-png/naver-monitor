// document_start, MAIN world
(function() {
  window.__naverStockCache = {};  // pid → data

  function tryCache(url, responseText) {
    // 응답 내용에 재고 관련 키가 있는 경우만 처리
    if (!responseText) return;
    if (!responseText.includes('stockQuantity') && !responseText.includes('optionCombinations')) return;
    try {
      var data = JSON.parse(responseText);
      var pidMatch = (url || '').match(/\/products\/(\d+)/);
      if (pidMatch) {
        window.__naverStockCache[pidMatch[1]] = data;
      }
    } catch(e) {}
  }

  // XHR 후킹 (URL 패턴 무관하게 모든 응답 검사)
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
    });
    return _XHRSend.apply(this, arguments);
  };

  // fetch 후킹
  var _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = _fetch(input, init);
    p.then(function(resp) {
      resp.clone().text().then(function(text) { tryCache(url, text); }).catch(function(){});
    }).catch(function(){});
    return p;
  };

  // SSR 데이터 탐색 (DOMContentLoaded)
  document.addEventListener('DOMContentLoaded', function() {
    var pid = (location.pathname.match(/\/products\/(\d+)/) || [])[1];
    if (!pid || window.__naverStockCache[pid]) return;

    // 모든 인라인 스크립트에서 stockQuantity 문자열 검색
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      var text = scripts[i].textContent;
      if (!text.includes('stockQuantity') && !text.includes('optionCombinations')) continue;

      // window.XXX = {...} 패턴
      var m = text.match(/window\.\w+\s*=\s*(\{[\s\S]+\})\s*;/);
      if (m) { try { var d = JSON.parse(m[1]); if (d) { window.__naverStockCache[pid] = d; return; } } catch(e) {} }

      // 변수 할당 패턴: var/let/const x = {...}
      m = text.match(/(?:var|let|const)\s+\w+\s*=\s*(\{[\s\S]+\})\s*;/);
      if (m) { try { var d2 = JSON.parse(m[1]); if (d2) { window.__naverStockCache[pid] = d2; return; } } catch(e) {} }

      // 순수 JSON (script type=application/json 등)
      try { var d3 = JSON.parse(text.trim()); if (d3 && typeof d3 === 'object') { window.__naverStockCache[pid] = d3; return; } } catch(e) {}
    }
  });
})();
