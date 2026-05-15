window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  var msg = event.data || {};
  if (msg.source !== 'naver-monitor-dashboard') return;

  if (msg.type === 'START_FETCH') {
    var auth = msg.auth || {};
    chrome.storage.local.set({
      serverUrl: auth.serverUrl || '',
      accessToken: auth.accessToken || '',
      refreshToken: auth.refreshToken || '',
      loginEmail: auth.loginEmail || ''
    }, function() {
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
    return;
  }

  if (msg.type === 'STOP_FETCH') {
    chrome.runtime.sendMessage({
      type: 'STOP_FETCH'
    }, function(response) {
      var error = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
      window.postMessage({
        source: 'naver-monitor-extension',
        type: 'STOP_FETCH_RESULT',
        requestId: msg.requestId,
        ok: !error && !!(response && response.ok),
        error: error || (response && response.error ? response.error : '')
      }, '*');
    });
    return;
  }
});
