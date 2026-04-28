/**
 * Mock Electron module for running handler tests outside of Electron.
 * Provides stubs for commonly used Electron APIs.
 */
export const app = {
  getPath: (name: string) => `/tmp/mock-${name}`,
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  name: 'slayzone-test',
  quit: () => {},
  on: () => {},
  whenReady: () => Promise.resolve()
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 })
}

export const BrowserWindow = class MockBrowserWindow {
  static getAllWindows() { return [] }
  static fromWebContents() { return null }
  static getFocusedWindow() { return null }
  webContents = { send: () => {} }
}

// Capture all ipcMain.emit calls for tests. Reset via __resetIpcEmitCalls().
export const __ipcEmitCalls: unknown[][] = []
export function __resetIpcEmitCalls(): void { __ipcEmitCalls.length = 0 }

export const ipcMain = {
  handle: () => {},
  on: () => {},
  emit: (...args: unknown[]) => {
    __ipcEmitCalls.push(args)
    return false
  }
}

export const Notification = class MockNotification {
  constructor(_opts?: unknown) {}
  show() {}
  static isSupported() { return false }
}

export const nativeTheme = {
  themeSource: 'system',
  shouldUseDarkColors: false,
  on: () => {}
}

export const shell = {
  openExternal: async () => {}
}

export const clipboard = {
  writeImage: () => {},
  writeText: () => {}
}

export const nativeImage = {
  createFromPath: () => ({})
}

export const session = {
  fromPartition: () => ({
    setPermissionRequestHandler: () => {},
    setDevicePermissionHandler: () => {}
  })
}

export const webContents = {
  fromId: () => null
}

export const powerMonitor = {
  on: () => {},
  off: () => {},
  addListener: () => {},
  removeListener: () => {}
}

export const net = {
  request: () => ({
    on: () => {},
    write: () => {},
    end: () => {}
  }),
  fetch: async () => new Response()
}

// In-memory credential store for tests (replaces OS keychain)
const _credentialStore = new Map<string, Buffer>()
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => {
    const buf = Buffer.from(`encrypted:${text}`)
    return buf
  },
  decryptString: (buf: Buffer) => {
    const str = buf.toString()
    if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length)
    return str
  }
}

export default {
  app, dialog, BrowserWindow, Notification, ipcMain, nativeTheme, shell,
  clipboard, nativeImage, session, webContents, safeStorage, net, powerMonitor
}
