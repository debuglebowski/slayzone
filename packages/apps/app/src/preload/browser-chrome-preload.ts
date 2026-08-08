/**
 * Preload for browser-tabs session WebContentsViews.
 * Provides chrome.app, chrome.csi, chrome.loadTimes in the main world
 * so Google's BotGuard sees a real browser fingerprint.
 *
 * IMPORTANT: Does NOT touch chrome.runtime — that's provided by
 * Electron's native extension system + electron-chrome-extensions.
 * Creating a stub chrome.runtime here would shadow the real one and
 * break extension content script messaging (sendMessage/connect).
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY,
  type BrowserModifiedLinkPayload
} from './browser-link-task-capture'

webFrame.setVisualZoomLevelLimits(1, 3)

function sendModifiedLinkPayload(payload: BrowserModifiedLinkPayload): void {
  if (payload.intent === 'open-external') {
    ipcRenderer.send('browser:request-open-link-externally', { url: payload.url })
    return
  }
  ipcRenderer.send('browser:request-create-task-from-link', {
    url: payload.url,
    linkText: payload.linkText
  })
}

contextBridge.exposeInMainWorld(BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY, sendModifiedLinkPayload)

if ('executeInMainWorld' in contextBridge) {
  contextBridge.executeInMainWorld({
    func: () => {
      // This runs in the page's main world, where `chrome` is Chrome's own
      // namespace object — absent in a WebContentsView. Typed as a loose bag
      // because the members stubbed below are the only ones anything reads, and
      // @types/chrome isn't part of the preload build.
      const w = window as unknown as { chrome?: Record<string, unknown> }
      if (!w.chrome) w.chrome = {}
      const c = w.chrome

      // chrome.app — BotGuard checks for this
      if (!c.app) {
        c.app = {
          isInstalled: false,
          InstallState: {
            DISABLED: 'disabled',
            INSTALLED: 'installed',
            NOT_INSTALLED: 'not_installed'
          },
          RunningState: {
            CANNOT_RUN: 'cannot_run',
            READY_TO_RUN: 'ready_to_run',
            RUNNING: 'running'
          },
          getDetails() {
            return null
          },
          getIsInstalled() {
            return false
          },
          installState(cb?: (s: string) => void) {
            if (cb) cb('not_installed')
          },
          runningState() {
            return 'cannot_run'
          }
        }
      }

      // chrome.csi / chrome.loadTimes — Chrome-specific APIs BotGuard checks
      if (!c.csi) {
        c.csi = () => ({ startE: Date.now(), onloadT: 0, pageT: performance.now(), tran: 15 })
      }
      if (!c.loadTimes) {
        c.loadTimes = () => ({
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: 0,
          finishLoadTime: 0,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: 0,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 0.16,
          startLoadTime: Date.now() / 1000 - 0.16,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true
        })
      }
    }
  })
}
