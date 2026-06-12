/**
 * Host bridge for the PTY/chat runtime — the inversion seam that lets
 * pty-manager + the chat stack run electron-free (slice 6c).
 *
 * The runtime needs three things from its host:
 *   - renderer windows to stream legacy `webContents.send` events at,
 *   - the OS theme (COLORFGBG / TERM_BACKGROUND env for spawned shells),
 *   - a command bus to receive renderer acks on (Electron: ipcMain).
 *
 * The Electron entry (`terminal/src/electron/index.ts`) configures the real
 * impls at import time, so behavior in the app is byte-identical. The
 * standalone server leaves the inert defaults: no windows (events flow through
 * the tRPC emitters instead), dark theme, ack-less bus (tRPC ackEnsureAlive
 * mutation still drives ensure-alive resolution).
 */

/** Structural slice of Electron's BrowserWindow that the runtime drives. */
export interface PtySessionWindow {
  isDestroyed(): boolean
  webContents: {
    send(channel: string, ...args: unknown[]): void
    getURL(): string
  }
}

/** Structural slice of Electron's IpcMain the runtime's register* glue takes —
 *  kept structural so the runtime modules stay electron-free. */
export interface IpcMainLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural match for IpcMain
  handle(channel: string, listener: (...args: any[]) => any): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural match for IpcMain
  on(channel: string, listener: (...args: any[]) => void): unknown
}

export interface PtyHostBridge {
  getAllWindows(): PtySessionWindow[]
  getFocusedWindow(): PtySessionWindow | null
  isDarkTheme(): boolean
  /** Renderer→runtime command bus (Electron: ipcMain). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural match for IpcMain.on
  bus: { on(channel: string, listener: (...args: any[]) => void): unknown }
}

const inertBridge: PtyHostBridge = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
  // Agents overwhelmingly run in dark terminals; matches the app default.
  isDarkTheme: () => true,
  bus: { on: () => undefined }
}

let bridge: PtyHostBridge = inertBridge
let configured = false

// Module-scope subscriptions made before the host configures (pty-manager
// registers its ack listener at import time) — replayed onto the real bus.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors bus.on
const pendingBusSubs: Array<[string, (...args: any[]) => void]> = []

export function configurePtyHost(b: PtyHostBridge): void {
  bridge = b
  if (!configured) {
    configured = true
    for (const [channel, listener] of pendingBusSubs) b.bus.on(channel, listener)
  }
}

export function getPtyHostBridge(): PtyHostBridge {
  return bridge
}

/** Subscribe to the host command bus; queues until the host configures. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors bus.on
export function onPtyHostBus(channel: string, listener: (...args: any[]) => void): void {
  if (configured) {
    bridge.bus.on(channel, listener)
  } else {
    pendingBusSubs.push([channel, listener])
  }
}
