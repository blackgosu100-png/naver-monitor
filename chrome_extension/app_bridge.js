window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  var msg = event.data || {};
  if (msg.source !== 'naver-monitor-dashboard' || msg.type !== 'START_FETCH') return;

  chrome.runtime.sendMessage({
    type: 'START_FETCH',
    competitors: msg.competitors || []
  }, function(response) {
    var error = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
    window.postMessage({
      source: 'naver-monitor-extension',
      type: 'START_FETCH_RESULT',
      requestId: msg.requestId,
      ok: !error && !!(response && response.ok),
      error: error || (response && response.error ? response.error : '')
    }, '*');
  });
});
