// cap-shell-4 — webview namespace (legacy Electron `<webview>` lifecycle).
//
// The fork doesn't use <webview> tags; BrowserPanel only calls
// `registerBrowserPanel` / `unregisterBrowserPanel` for Electron-side
// panel-tracking. Both are safe no-ops in the fork because the embedded-tab
// host already knows the task_id from createView params and doesn't need a
// separate register call.
//
// Every other webview.* surface stubs to a safe empty shape so callers don't
// throw. cap-shell-7 revisits if any renderer path actually demands them
// (keyboard passthrough, device emulation, per-webview DevTools).

import type { ElectronAPI } from '@slayzone/types'

type WebviewNS = ElectronAPI['webview']

const noopUnsub = (): void => undefined
const noopSub = (): (() => void) => noopUnsub

export const webviewShim = {
  registerShortcuts: async (): Promise<void> => undefined,
  setKeyboardPassthrough: async (): Promise<void> => undefined,
  setDesktopHandoffPolicy: async (): Promise<boolean> => false,
  onShortcut: noopSub,
  openDevToolsBottom: async (): Promise<boolean> => false,
  openDevToolsDetached: async (): Promise<boolean> => false,
  closeDevTools: async (): Promise<boolean> => false,
  isDevToolsOpened: async (): Promise<boolean> => false,
  enableDeviceEmulation: async (): Promise<boolean> => false,
  disableDeviceEmulation: async (): Promise<boolean> => false,
  registerBrowserPanel: async (): Promise<void> => undefined,
  unregisterBrowserPanel: async (): Promise<void> => undefined,
} as unknown as WebviewNS
