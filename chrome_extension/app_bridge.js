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

function postFetchStatus(status) {
  window.postMessage({
    source: 'naver-monitor-extension',
    type: 'FETCH_STATUS',
    status: status || null
  }, '*');
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || msg.type !== 'HISTORY_UPDATED') return;
  window.postMessage({
    source: 'naver-monitor-extension',
    type: 'HISTORY_UPDATED'
  }, '*');
  sendResponse({ ok: true });
});

chrome.storage.onChanged.addListener(function(changes, areaName) {
  if (areaName !== 'local' || !changes.fetchStatus) return;
  postFetchStatus(changes.fetchStatus.newValue || null);
});

chrome.storage.local.get('fetchStatus', function(data) {
  if (data && data.fetchStatus) postFetchStatus(data.fetchStatus);
});
