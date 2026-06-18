// cap-shell-2 — constant returns + no-op subscriptions so the renderer's
// app.* calls resolve. TODO(cap-shell-7): read version from package.json,
// wire zoom-factor change observer, hook menu-invoked on* callbacks to
// native accelerator -> shell-side shortcut dispatch.
//
// cap-migrate-all-tests (2026-04-23) — the core-windowing spec batch
// (57-cmd-w-close, 66-tab-store) reaches the renderer's onClose*/onOpen*
// handlers that were previously triggered from Electron main via
// webContents.send(channel). In shell mode we listen on `window` for a
// matching CustomEvent and invoke the callback. Tests drive the flow via
// the existing `__testEmit(channel, data)` hook (dispatches a CustomEvent).
// Production menu accelerator dispatch is unchanged (still deferred).

import { resolveServerUrl, CHROMIUM_WINDOW_ID } from '../server-url'

const noopUnsub = (): void => undefined
const noopSub = (_cb: unknown): (() => void) => noopUnsub

type VoidSub = (cb: () => void) => () => void
type PayloadSub<P> = (cb: (payload: P) => void) => () => void

function voidEventSub(channel: string): VoidSub {
  return (cb) => {
    const handler = (): void => {
      try { cb() } catch { /* ignore throwing subscriber */ }
    }
    window.addEventListener(channel, handler)
    return () => window.removeEventListener(channel, handler)
  }
}

function payloadEventSub<P = unknown>(channel: string): PayloadSub<P> {
  return (cb) => {
    const handler = (evt: Event): void => {
      const detail = (evt as CustomEvent<P>).detail
      try { cb(detail) } catch { /* ignore throwing subscriber */ }
    }
    window.addEventListener(channel, handler)
    return () => window.removeEventListener(channel, handler)
  }
}

export const appShim = {
  getVersion: async (): Promise<string> => '0.0.0-shell-2',
  getZoomFactor: async (): Promise<number> => 1,
  adjustZoom: async (_delta: number): Promise<number> => 1,
  onZoomFactorChanged: noopSub,
  isPlaywright: (): boolean => false,
  isTestsPanelEnabled: async (): Promise<boolean> => false,
  isJiraIntegrationEnabled: async (): Promise<boolean> => false,
  isJiraIntegrationEnabledSync: (): boolean => false,
  isLoopModeEnabled: async (): Promise<boolean> => false,
  // Server-mode discovery: the renderer's transport bootstrap reads these to
  // build the tRPC-WS URL. Fork pins a fixed loopback port (see server-url.ts);
  // windowId is constant (single window). Boot instrumentation is a no-op here.
  getServerUrl: async (): Promise<{ mode: 'local' | 'remote'; url: string }> => resolveServerUrl(),
  getWindowId: async (): Promise<number | null> => CHROMIUM_WINDOW_ID,
  bootMark: (_label: string): void => undefined,
  dataReady: (): Promise<void> => Promise.resolve(),
  cliStatus: async (): Promise<{ installed: boolean; path: string | null }> => ({
    installed: false,
    path: null,
  }),
  installCli: async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: 'cap-shell-2: CLI install deferred to cap-shell-6',
  }),
  restartForUpdate: (): Promise<void> => Promise.resolve(),
  onUpdateStatus: noopSub,
  onOpenTask: payloadEventSub<string>('app:open-task'),
  onCloseTask: payloadEventSub<string>('app:close-task'),
  onCloseCurrent: voidEventSub('app:close-current-focus'),
  onCloseActiveTask: voidEventSub('app:close-active-task'),
  onGoHome: voidEventSub('app:go-home'),
  onNewTemporaryTask: voidEventSub('app:new-temporary-task'),
  onOpenSettings: voidEventSub('app:open-settings'),
  onOpenProjectSettings: voidEventSub('app:open-project-settings'),
  onReloadApp: voidEventSub('app:reload-app'),
  onReloadBrowser: voidEventSub('app:reload-browser'),
  onToggleAgentPanel: voidEventSub('app:toggle-agent-panel'),
  onToggleAttentionPanel: voidEventSub('app:toggle-attention-panel'),
  // onBrowserEnsurePanelOpen / onOpenAsset carry two positional args in
  // preload (taskId + optional url / assetId). Shell shim keeps the two-arg
  // callback shape by unpacking a {0, 1} detail tuple from CustomEvent.
  onBrowserEnsurePanelOpen: (cb: (taskId: string, url?: string) => void) => {
    const handler = (evt: Event): void => {
      const d = (evt as CustomEvent<[string, string?]>).detail ?? ['']
      try { cb(d[0], d[1]) } catch { /* ignore */ }
    }
    window.addEventListener('app:browser-ensure-panel-open', handler)
    return () => window.removeEventListener('app:browser-ensure-panel-open', handler)
  },
  onOpenAsset: (cb: (taskId: string, assetId: string) => void) => {
    const handler = (evt: Event): void => {
      const d = (evt as CustomEvent<[string, string]>).detail ?? ['', '']
      try { cb(d[0], d[1]) } catch { /* ignore */ }
    }
    window.addEventListener('app:open-asset', handler)
    return () => window.removeEventListener('app:open-asset', handler)
  },
  onScreenshotTrigger: voidEventSub('app:screenshot-trigger'),
  onSyncSessionId: voidEventSub('app:sync-session-id'),
  getProtocolClientStatus: async (): Promise<{ registered: boolean }> => ({ registered: false }),
}
