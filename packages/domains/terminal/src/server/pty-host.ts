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
 *  kept structural so the runtime modules stay electron-free.
 *
 *  The listener's parameter list is a type parameter rather than a fixed
 *  tuple: this seam never reads the args, it only hands the listener to the
 *  host, and each `ipcMain.handle('chat:send', (_, tabId: string, …))` call
 *  site declares its own channel-specific payload. Inferring `A` keeps those
 *  annotations checked instead of widening every handler to `any`. */
export interface IpcMainLike {
  handle<A extends unknown[], R>(channel: string, listener: (...args: A) => R): unknown
  on<A extends unknown[]>(channel: string, listener: (...args: A) => void): unknown
}

export interface PtyHostBridge {
  getAllWindows(): PtySessionWindow[]
  getFocusedWindow(): PtySessionWindow | null
  isDarkTheme(): boolean
  /** Renderer→runtime command bus (Electron: ipcMain). */
  bus: { on(channel: string, listener: OpaqueBusListener): unknown }
}

/** A bus listener as the HOST sees it: an unbounded, unknown argument list.
 *  pty-host stores and forwards these but never calls them, so it has nothing
 *  to narrow — the narrowing happens in each subscriber's own signature (see
 *  {@link onPtyHostBus}). */
type OpaqueBusListener = (...args: unknown[]) => void

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
const pendingBusSubs: Array<[string, OpaqueBusListener]> = []

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

/** Subscribe to the host command bus; queues until the host configures.
 *
 *  `A` is inferred from the subscriber, so a listener may declare the payload
 *  its channel actually carries (`(_e, reqId: number, result: AckResult)`) and
 *  stay checked. Widening back to `OpaqueBusListener` at the forwarding edge is
 *  the one unchecked step: the host, not this seam, decides what a channel
 *  delivers, and the channel↔payload contract lives with the subscriber. */
export function onPtyHostBus<A extends unknown[]>(
  channel: string,
  listener: (...args: A) => void
): void {
  const opaque = listener as OpaqueBusListener
  if (configured) {
    bridge.bus.on(channel, opaque)
  } else {
    pendingBusSubs.push([channel, opaque])
  }
}
