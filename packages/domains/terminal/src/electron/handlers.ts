import { BrowserWindow } from 'electron'
import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  TerminalMode,
  CreateTerminalModeInput,
  UpdateTerminalModeInput
} from '@slayzone/terminal/shared'
import type { ExecutionContext } from '../server/adapters'
import { createPtyOps, type PtyCreateOpts } from '../server/runtime/pty-store'
import { setProjectTabCounts, clearWindowTabCounts } from '../server/runtime/warm-process-manager'

/**
 * Every IPC channel registerPtyHandlers binds, recorded automatically by the
 * self-tracking `handle` wrapper below. e2e teardown (__restorePtyHandlers)
 * removes exactly this set before re-registering — so a newly-added handler can
 * never drift out of the remove-list (the recurring "second handler" bug).
 */
const PTY_HANDLER_CHANNELS: string[] = []

/** Channels bound by registerPtyHandlers (populated after the first call). */
export function getPtyHandlerChannels(): readonly string[] {
  return PTY_HANDLER_CHANNELS
}

/**
 * Thin IPC wrappers over the transport-agnostic `createPtyOps` store
 * (`./pty-store`). Both these `pty:*` / `terminalModes:*` / `session:*` handlers
 * and the tRPC `pty` router call the same ops, so they share one implementation
 * while IPC + tRPC coexist (renderer cutover is slice 5). Deleting this file
 * happens once the renderer has zero `window.api.pty.*` calls left.
 */
export function registerPtyHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  const ops = createPtyOps(db)

  // Self-tracking registrar — see PTY_HANDLER_CHANNELS above.
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]): void => {
    if (!PTY_HANDLER_CHANNELS.includes(channel)) PTY_HANDLER_CHANNELS.push(channel)
    ipcMain.handle(channel, listener)
  }

  // Terminal Modes CRUD
  handle('terminalModes:list', () => ops.terminalModesList())
  handle('terminalModes:test', (_, command: string) => ops.terminalModesTest(command))
  handle('terminalModes:get', (_, id: string) => ops.terminalModesGet(id))
  handle('terminalModes:create', (_, input: CreateTerminalModeInput) =>
    ops.terminalModesCreate(input)
  )
  handle('terminalModes:update', (_, id: string, updates: UpdateTerminalModeInput) =>
    ops.terminalModesUpdate(id, updates)
  )
  handle('terminalModes:delete', (_, id: string) => ops.terminalModesDelete(id))
  handle('terminalModes:restoreDefaults', () => ops.terminalModesRestoreDefaults())
  handle('terminalModes:resetToDefaultState', () => ops.terminalModesResetToDefaultState())

  // PTY ops — `pty:create` carries the invoking window from `event.sender` so
  // redirectSessionWindow() legacy codepaths keep their original target.
  handle('pty:create', (event, opts: PtyCreateOpts) =>
    ops.ptyCreate(opts, BrowserWindow.fromWebContents(event.sender))
  )
  handle('pty:testExecutionContext', (_, context: ExecutionContext) =>
    ops.ptyTestExecutionContext(context)
  )
  handle('pty:write', (_, sessionId: string, data: string) => ops.ptyWrite(sessionId, data))
  handle('pty:submit', (_, sessionId: string, text: string) => ops.ptySubmit(sessionId, text))
  handle('pty:resize', (_, sessionId: string, cols: number, rows: number) =>
    ops.ptyResize(sessionId, cols, rows)
  )
  handle('pty:kill', (_, sessionId: string) => ops.ptyKill(sessionId))
  handle('pty:touch', (_, sessionId: string) => ops.ptyTouch(sessionId))
  handle('pty:interrupt', (_, sessionId: string) => ops.ptyInterrupt(sessionId))
  handle('pty:exists', (_, sessionId: string) => ops.ptyExists(sessionId))
  handle('pty:getBuffer', (_, sessionId: string) => ops.ptyGetBuffer(sessionId))
  handle('pty:clearBuffer', (_, sessionId: string) => ops.ptyClearBuffer(sessionId))
  handle('pty:getBufferSince', (_, sessionId: string, afterSeq: number) =>
    ops.ptyGetBufferSince(sessionId, afterSeq)
  )
  handle('pty:list', () => ops.ptyList())
  handle('chat:list', () => ops.chatList())

  // Warm-process gate: the renderer pushes its full per-project open-task-tab snapshot
  // (keyed by projectId). Main unions across windows to decide which projects keep a warm
  // shell. Idempotent — a full snapshot each time, so dropped messages self-heal. A window's
  // contribution is cleared when its webContents is destroyed.
  //
  // Stays IPC-only (not in the tRPC pty router): it is per-window state keyed by
  // `event.sender.id` + a `destroyed` hook, which needs the deferred `ctx.windowId`
  // tRPC capability. Mirror it into the router when windowId context lands.
  const warmHookedSenders = new Set<number>()
  handle('warm:setProjectTabCounts', (event, counts: Record<string, number>) => {
    const windowId = event.sender.id
    setProjectTabCounts(windowId, counts)
    if (!warmHookedSenders.has(windowId)) {
      warmHookedSenders.add(windowId)
      event.sender.once('destroyed', () => {
        warmHookedSenders.delete(windowId)
        clearWindowTabCounts(windowId)
      })
    }
  })

  handle('pty:getState', (_, sessionId: string) => ops.ptyGetState(sessionId))
  handle('session:list', () => ops.sessionList())
  handle('session:getState', (_, sessionId: string) => ops.sessionGetState(sessionId))
  handle(
    'pty:set-theme',
    (
      _,
      theme: { foreground: string; background: string; cursor: string; ansi?: readonly string[] }
    ) => ops.ptySetTheme(theme)
  )
  handle('pty:validate', (_, mode: TerminalMode) => ops.ptyValidate(mode))
  handle('pty:setShellOverride', (_, value: string | null) => ops.ptySetShellOverride(value))
}
