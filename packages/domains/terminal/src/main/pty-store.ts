import { BrowserWindow } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  createPty,
  writePty,
  submitPty,
  resizePty,
  killPty,
  touchPty,
  interruptPty,
  hasPty,
  getBuffer,
  clearBuffer,
  getBufferSince,
  listPtys,
  getState,
  setDatabase,
  setTerminalTheme,
  testExecutionContext
} from './pty-manager'
import { listSessions, getSessionState } from './session-registry'
import { listChatSessions } from './chat-transport-manager'
import { claimWarmShell } from './warm-process-manager'
import { getAdapter, type ExecutionContext } from './adapters'
import type {
  TerminalMode,
  TerminalModeInfo,
  CreateTerminalModeInput,
  UpdateTerminalModeInput
} from '@slayzone/terminal/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import { parseShellArgs } from './adapters/flag-parser'
import { setShellOverride } from './shell-env'

const execFileAsync = promisify(execFile)

export interface PtyCreateOpts {
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  mode?: TerminalMode
  initialPrompt?: string | null
  providerFlags?: string | null
  executionContext?: ExecutionContext | null
  cols?: number
  rows?: number
}

function mapModeRow(row: any): TerminalModeInfo {
  let usageConfig = null
  if (row.usage_config) {
    try {
      usageConfig = JSON.parse(row.usage_config)
    } catch {
      /* ignore corrupt */
    }
  }
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    initialCommand: row.initial_command,
    resumeCommand: row.resume_command,
    headlessCommand: row.headless_command ?? null,
    defaultFlags: row.default_flags,
    enabled: Boolean(row.enabled),
    isBuiltin: Boolean(row.is_builtin),
    order: row.order,
    patternWorking: row.pattern_working,
    patternError: row.pattern_error,
    usageConfig
  }
}

/**
 * Transport-agnostic PTY operations (IPC → tRPC migration, slice 3 / P17).
 *
 * Single implementation of every `pty:*` / `terminalModes:*` / `session:*` /
 * `chat:list` handler body, so the IPC handlers (`registerPtyHandlers`) and the
 * tRPC `pty` router both delegate here — no duplicated logic while both
 * transports coexist (renderer cutover is slice 5). Mirrors the chat/task
 * `createXOps` pattern; injected into the transport layer via `setPtyDeps`.
 *
 * NOTE: `warm:setProjectTabCounts` is deliberately NOT here — it is per-window
 * state keyed by `event.sender.id` + a `destroyed` hook, which needs the
 * deferred `ctx.windowId` tRPC capability. It stays IPC-only until that lands.
 */
export function createPtyOps(db: SlayzoneDb) {
  // Set database reference for notifications.
  setDatabase(db)

  // Terminal Modes CRUD
  const terminalModesList = async (): Promise<TerminalModeInfo[]> => {
    const rows = await db.prepare('SELECT * FROM terminal_modes ORDER BY "order" ASC').all()
    return rows.map(mapModeRow)
  }

  const terminalModesTest = async (
    command: string
  ): Promise<{ ok: boolean; error?: string; detail?: string }> => {
    try {
      const parts = parseShellArgs(command)
      const bin = parts[0]
      if (!bin) return { ok: false, error: 'No command provided' }

      // Try 'which' on Unix or 'where' on Windows to see if binary exists
      const checkCmd = process.platform === 'win32' ? 'where' : 'which'
      const { stdout } = await execFileAsync(checkCmd, [bin])
      return { ok: true, detail: stdout.trim() }
    } catch (err) {
      return { ok: false, error: 'Command not found', detail: (err as Error).message }
    }
  }

  const terminalModesGet = async (id: string): Promise<TerminalModeInfo | null> => {
    const row = await db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return row ? mapModeRow(row) : null
  }

  const terminalModesCreate = async (input: CreateTerminalModeInput): Promise<TerminalModeInfo> => {
    const id = input.id
    await db
      .prepare(
        `
      INSERT INTO terminal_modes (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order", pattern_working, pattern_error, usage_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        input.label,
        input.type,
        input.initialCommand ?? null,
        input.resumeCommand ?? null,
        input.headlessCommand ?? null,
        input.defaultFlags ?? null,
        input.enabled !== false ? 1 : 0,
        input.order ?? 0,
        input.patternWorking ?? null,
        input.patternError ?? null,
        input.usageConfig ? JSON.stringify(input.usageConfig) : null
      )
    const row = await db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return mapModeRow(row)
  }

  const terminalModesUpdate = async (
    id: string,
    updates: UpdateTerminalModeInput
  ): Promise<TerminalModeInfo | null> => {
    const builtinRow = (await db
      .prepare('SELECT is_builtin FROM terminal_modes WHERE id = ?')
      .get(id)) as { is_builtin: number } | undefined
    const isBuiltin = Boolean(builtinRow?.is_builtin)

    const sets: string[] = []
    const params: any[] = []

    if (updates.label !== undefined && !isBuiltin) {
      sets.push('label = ?')
      params.push(updates.label)
    }
    if (updates.type !== undefined && !isBuiltin) {
      sets.push('type = ?')
      params.push(updates.type)
    }
    if (updates.initialCommand !== undefined && !isBuiltin) {
      sets.push('initial_command = ?')
      params.push(updates.initialCommand)
    }
    if (updates.resumeCommand !== undefined && !isBuiltin) {
      sets.push('resume_command = ?')
      params.push(updates.resumeCommand ?? null)
    }
    if (updates.headlessCommand !== undefined) {
      sets.push('headless_command = ?')
      params.push(updates.headlessCommand ?? null)
    }
    if (updates.defaultFlags !== undefined) {
      sets.push('default_flags = ?')
      params.push(updates.defaultFlags)
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(updates.enabled ? 1 : 0)
    }
    if (updates.order !== undefined) {
      sets.push(' "order" = ?')
      params.push(updates.order)
    }
    if (updates.patternWorking !== undefined) {
      sets.push('pattern_working = ?')
      params.push(updates.patternWorking ?? null)
    }
    if (updates.patternError !== undefined) {
      sets.push('pattern_error = ?')
      params.push(updates.patternError ?? null)
    }
    if (updates.usageConfig !== undefined) {
      sets.push('usage_config = ?')
      params.push(updates.usageConfig ? JSON.stringify(updates.usageConfig) : null)
    }

    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')")
      params.push(id)
      await db.prepare(`UPDATE terminal_modes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    const updatedRow = await db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return updatedRow ? mapModeRow(updatedRow) : null
  }

  const terminalModesDelete = async (id: string): Promise<boolean> => {
    const deleteRow = (await db
      .prepare('SELECT is_builtin FROM terminal_modes WHERE id = ?')
      .get(id)) as { is_builtin: number } | undefined
    if (deleteRow?.is_builtin) {
      return false // Built-in modes cannot be deleted
    }
    await db.prepare('DELETE FROM terminal_modes WHERE id = ?').run(id)
    return true
  }

  const terminalModesRestoreDefaults = async (): Promise<void> => {
    const insertSql = `
        INSERT OR IGNORE INTO terminal_modes (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `
    const ops = DEFAULT_TERMINAL_MODES.map((mode) => ({
      type: 'run' as const,
      sql: insertSql,
      params: [
        mode.id,
        mode.label,
        mode.type,
        mode.initialCommand ?? null,
        mode.resumeCommand ?? null,
        mode.headlessCommand ?? null,
        mode.defaultFlags ?? null,
        mode.enabled ? 1 : 0,
        mode.order
      ]
    }))
    await db.batchTxn(ops)
  }

  const terminalModesResetToDefaultState = async (): Promise<void> => {
    const insertSql = `
        INSERT INTO terminal_modes (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `
    const ops = [
      { type: 'run' as const, sql: 'DELETE FROM terminal_modes', params: [] as unknown[] },
      ...DEFAULT_TERMINAL_MODES.map((mode) => ({
        type: 'run' as const,
        sql: insertSql,
        params: [
          mode.id,
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.headlessCommand ?? null,
          mode.defaultFlags ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        ] as unknown[]
      }))
    ]
    await db.batchTxn(ops)
  }

  /**
   * Create a PTY. `win` is supplied by the IPC handler from the invoking
   * `event.sender`; the tRPC path omits it and we fall back to the focused/first
   * window (PTY output now fans out via `ptyEvents`, so the window is only
   * needed for legacy `redirectSessionWindow()` codepaths).
   */
  const ptyCreate = async (
    opts: PtyCreateOpts,
    win?: BrowserWindow | null
  ): Promise<{ success: boolean; error?: string }> => {
    const targetWin = win ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!targetWin) return { success: false, error: 'No window found' }

    let providerArgs: string[] = []
    try {
      providerArgs = parseShellArgs(opts.providerFlags)
    } catch (err) {
      console.warn('[pty:create] Invalid provider flags, ignoring:', (err as Error).message)
    }

    // Look up mode info to get type, templates, and default flags
    const modeId = opts.mode || 'claude-code'

    const modeRow = await db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(modeId)
    const modeInfo = modeRow ? mapModeRow(modeRow) : undefined

    // Warm-process pool: if this project has a ready warm shell that matches this
    // spawn (default mode, project-root cwd, fresh start), adopt it instead of
    // cold-spawning. Resolve the project via the session's task. A miss is silent —
    // createPty cold-spawns exactly as before.
    let warmClaim: ReturnType<typeof claimWarmShell> = null
    const taskId = opts.sessionId.split(':')[0]
    if (taskId) {
      const taskRow = (await db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId)) as
        | { project_id?: string }
        | undefined
      const projectId = taskRow?.project_id
      if (projectId) {
        warmClaim = claimWarmShell({
          projectId,
          mode: modeId,
          cwd: opts.cwd,
          resuming: !!opts.existingConversationId
        })
      }
    }

    return createPty({
      win: targetWin,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      conversationId: opts.conversationId,
      existingConversationId: opts.existingConversationId,
      mode: modeId as TerminalMode,
      initialPrompt: opts.initialPrompt,
      providerArgs,
      executionContext: opts.executionContext,
      type: modeInfo?.type,
      initialCommand: modeInfo?.initialCommand,
      resumeCommand: modeInfo?.resumeCommand,
      defaultFlags: modeInfo?.defaultFlags,
      patternWorking: modeInfo?.patternWorking,
      patternError: modeInfo?.patternError,
      cols: opts.cols,
      rows: opts.rows,
      adoptPty: warmClaim ?? undefined
    })
  }

  const ptyTestExecutionContext = (context: ExecutionContext) => testExecutionContext(context)
  const ptyWrite = (sessionId: string, data: string) => writePty(sessionId, data)
  const ptySubmit = (sessionId: string, text: string) => submitPty(sessionId, text)
  const ptyResize = (sessionId: string, cols: number, rows: number) =>
    resizePty(sessionId, cols, rows)
  const ptyKill = (sessionId: string) => killPty(sessionId)
  const ptyTouch = (sessionId: string) => touchPty(sessionId)
  const ptyInterrupt = (sessionId: string) => interruptPty(sessionId)
  const ptyExists = (sessionId: string) => hasPty(sessionId)
  const ptyGetBuffer = (sessionId: string) => getBuffer(sessionId)
  const ptyClearBuffer = (sessionId: string) => clearBuffer(sessionId)
  const ptyGetBufferSince = (sessionId: string, afterSeq: number) =>
    getBufferSince(sessionId, afterSeq)
  const ptyList = () => listPtys()
  const chatList = () => listChatSessions()
  const ptyGetState = (sessionId: string) => getState(sessionId)
  const sessionList = () => listSessions()
  const sessionGetState = (sessionId: string) => getSessionState(sessionId)
  const ptySetTheme = (theme: {
    foreground: string
    background: string
    cursor: string
    ansi?: readonly string[]
  }) => setTerminalTheme(theme)

  const ptyValidate = async (mode: TerminalMode) => {
    const modeRow = await db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(mode)
    const modeInfo = modeRow ? mapModeRow(modeRow) : undefined
    const adapter = getAdapter({
      mode,
      type: modeInfo?.type,
      patterns: {
        working: modeInfo?.patternWorking,
        error: modeInfo?.patternError
      }
    })
    return adapter.validate ? adapter.validate() : []
  }

  const ptySetShellOverride = (value: string | null) => setShellOverride(value)

  return {
    terminalModesList,
    terminalModesTest,
    terminalModesGet,
    terminalModesCreate,
    terminalModesUpdate,
    terminalModesDelete,
    terminalModesRestoreDefaults,
    terminalModesResetToDefaultState,
    ptyCreate,
    ptyTestExecutionContext,
    ptyWrite,
    ptySubmit,
    ptyResize,
    ptyKill,
    ptyTouch,
    ptyInterrupt,
    ptyExists,
    ptyGetBuffer,
    ptyClearBuffer,
    ptyGetBufferSince,
    ptyList,
    chatList,
    ptyGetState,
    sessionList,
    sessionGetState,
    ptySetTheme,
    ptyValidate,
    ptySetShellOverride
  }
}
