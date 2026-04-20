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
  type BrowserCreateTaskFromLinkCapturePayload,
} from './browser-link-task-capture'

webFrame.setVisualZoomLevelLimits(1, 3)

function sendTaskLinkPayload(payload: BrowserCreateTaskFromLinkCapturePayload): void {
  ipcRenderer.send('browser:request-create-task-from-link', payload)
}

contextBridge.exposeInMainWorld(BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY, sendTaskLinkPayload)

if ('executeInMainWorld' in contextBridge) {
  contextBridge.executeInMainWorld({
    func: () => {
      if (!window.chrome) (window as any).chrome = {}
      const c = window.chrome as any

      // chrome.app — BotGuard checks for this
      if (!c.app) {
        c.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails() { return null },
          getIsInstalled() { return false },
          installState(cb?: (s: string) => void) { if (cb) cb('not_installed') },
          runningState() { return 'cannot_run' },
        }
      }

      // chrome.csi / chrome.loadTimes — Chrome-specific APIs BotGuard checks
      if (!c.csi) {
        c.csi = () => ({ startE: Date.now(), onloadT: 0, pageT: performance.now(), tran: 15 })
      }
      if (!c.loadTimes) {
        c.loadTimes = () => ({
          commitLoadTime: Date.now() / 1000, connectionInfo: 'h2',
          finishDocumentLoadTime: 0, finishLoadTime: 0,
          firstPaintAfterLoadTime: 0, firstPaintTime: 0,
          navigationType: 'Other', npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 0.16,
          startLoadTime: Date.now() / 1000 - 0.16,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
        })
      }
    },
  })
}
