import type { App } from 'electron'
import { clearWindowTabCounts } from '../server/runtime/warm-process-manager'

// The IPC pty/terminalModes/session handlers (registerPtyHandlers) were removed
// at the IPC→tRPC cutover — the renderer uses the tRPC `pty` router over the same
// transport-agnostic `createPtyOps` store. Only the host-owned window-lifecycle
// cleanup below remains (it is not a per-call IPC handler).

/**
 * Drop a window's warm-process tab-count contribution when its webContents dies.
 * Registered app-wide at boot so cleanup holds no matter which transport pushed
 * the counts (tRPC `pty.warmSetProjectTabCounts`). `clearWindowTabCounts` no-ops
 * for ids that never pushed.
 */
export function wireWarmWindowCleanup(app: App): void {
  app.on('web-contents-created', (_event, webContents) => {
    webContents.once('destroyed', () => clearWindowTabCounts(webContents.id))
  })
}
