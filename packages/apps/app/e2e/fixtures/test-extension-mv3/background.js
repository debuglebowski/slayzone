// Background service worker — responds to ping messages from content script.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'ping') {
    sendResponse({ type: 'pong' })
  }
  // The `browser` namespace must be the shimmed `chrome` (1Password reads
  // browser.windows at startup; Chromium's native `browser` lacks the shims).
  if (message.type === 'namespaces') {
    sendResponse({
      browserIsChrome: globalThis.browser === chrome,
      browserWindows: typeof (globalThis.browser && globalThis.browser.windows)
    })
  }
  // The origin private file system must work in the service worker (1Password's
  // database lives there; Electron refuses it unless chrome-extension is standard).
  if (message.type === 'opfs') {
    navigator.storage.getDirectory().then(
      function () {
        sendResponse({ opfs: 'ok' })
      },
      function (err) {
        sendResponse({ opfs: err.name })
      }
    )
    return true
  }
  // chrome.tabs.create must open a browser-panel tab (1Password's sign-in page).
  if (message.type === 'open-tab') {
    chrome.tabs
      .create({ url: message.url })
      .then(function (tab) {
        sendResponse({ ok: true, tabId: tab.id })
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
      })
    return true
  }
})
