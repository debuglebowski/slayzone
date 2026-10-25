// Content script — runs on every page.
// 1. Injects a marker element so the test can detect it
// 2. Sends a message to the background script to test messaging
;(function () {
  // Avoid double-injection
  if (document.getElementById('slayzone-test-ext')) return

  var marker = document.createElement('div')
  marker.id = 'slayzone-test-ext'
  marker.dataset.status = 'loaded'
  marker.style.display = 'none'
  document.documentElement.appendChild(marker)

  // Test chrome.runtime.sendMessage → background script
  try {
    chrome.runtime.sendMessage({ type: 'ping' }, function (response) {
      if (chrome.runtime.lastError) {
        marker.dataset.status = 'error'
        marker.dataset.error = chrome.runtime.lastError.message
        return
      }
      if (response && response.type === 'pong') {
        marker.dataset.status = 'connected'
      }
    })
  } catch (err) {
    marker.dataset.status = 'error'
    marker.dataset.error = err.message
  }
})()

// Test hook: the page dispatches `slz-ext-request` (DOM events cross into this
// isolated world); the background's reply lands on the marker as JSON.
document.addEventListener('slz-ext-request', function (event) {
  var marker = document.getElementById('slayzone-test-ext')
  chrome.runtime.sendMessage(JSON.parse(event.detail), function (response) {
    marker.dataset.reply = chrome.runtime.lastError
      ? JSON.stringify({ ok: false, error: chrome.runtime.lastError.message })
      : JSON.stringify(response)
  })
})
