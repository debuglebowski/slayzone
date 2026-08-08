/**
 * Mock Electron module for running handler tests outside of Electron.
 * Provides stubs for commonly used Electron APIs.
 */

/**
 * Shared stand-in for every Electron method whose only job outside Electron is
 * to be callable: listener registration (`on`/`off`), window/OS side effects
 * (`quit`, `show`, `writeText`), and permission handlers. Nothing under test
 * observes them, so they swallow their arguments and return nothing. Anything a
 * test DOES assert on gets a real implementation below (see `ipcMain.emit` and
 * `safeStorage`).
 */
const noop = (): void => undefined
/** `noop`'s async twin, for the Electron APIs whose contract is a Promise. */
const asyncNoop = async (): Promise<void> => undefined

export const app = {
  getPath: (name: string) => `/tmp/mock-${name}`,
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  name: 'slayzone-test',
  quit: noop,
  on: noop,
  whenReady: () => Promise.resolve()
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 })
}

export const BrowserWindow = class MockBrowserWindow {
  static getAllWindows() {
    return []
  }
  static fromWebContents() {
    return null
  }
  static getFocusedWindow() {
    return null
  }
  webContents = { send: noop }
}

// Capture all ipcMain.emit calls for tests. Reset via __resetIpcEmitCalls().
export const __ipcEmitCalls: unknown[][] = []
export function __resetIpcEmitCalls(): void {
  __ipcEmitCalls.length = 0
}

export const ipcMain = {
  handle: noop,
  on: noop,
  emit: (...args: unknown[]) => {
    __ipcEmitCalls.push(args)
    return false
  }
}

export const Notification = class MockNotification {
  constructor(_opts?: unknown) {
    // Options are accepted so `new Notification({...})` type-checks at the call
    // site, but there is no OS notification centre to hand them to.
  }
  show(): void {
    // Nothing to render outside Electron; tests assert on the code that decided
    // to notify, never on the notification itself.
  }
  static isSupported() {
    return false
  }
}

export const nativeTheme = {
  themeSource: 'system',
  shouldUseDarkColors: false,
  on: noop
}

export const shell = {
  openExternal: asyncNoop
}

export const clipboard = {
  writeImage: noop,
  writeText: noop
}

export const nativeImage = {
  createFromPath: () => ({})
}

export const session = {
  fromPartition: () => ({
    setPermissionRequestHandler: noop,
    setDevicePermissionHandler: noop
  })
}

export const webContents = {
  fromId: () => null
}

export const powerMonitor = {
  on: noop,
  off: noop,
  addListener: noop,
  removeListener: noop
}

export const net = {
  request: () => ({
    on: noop,
    write: noop,
    end: noop
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
  app,
  dialog,
  BrowserWindow,
  Notification,
  ipcMain,
  nativeTheme,
  shell,
  clipboard,
  nativeImage,
  session,
  webContents,
  safeStorage,
  net,
  powerMonitor
}
