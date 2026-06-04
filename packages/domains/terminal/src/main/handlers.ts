import { BrowserWindow } from 'electron'
import type { IpcMain } from 'electron'
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
import {
  claimWarmShell,
  setProjectTabCounts,
  clearWindowTabCounts
} from './warm-process-manager'

const execFileAsync = promisify(execFile)
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

interface PtyCreateOpts {
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

export function registerPtyHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  // Set database reference for notifications
  setDatabase(db)

  // Self-tracking registrar — see PTY_HANDLER_CHANNELS above.
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]): void => {
    if (!PTY_HANDLER_CHANNELS.includes(channel)) PTY_HANDLER_CHANNELS.push(channel)
    ipcMain.handle(channel, listener)
  }

  // Built-in terminal modes are synchronized inside the DB worker on startup
  // (see db-worker.ts) — no main-thread sync needed here.

  // Terminal Modes CRUD
  handle('terminalModes:list', async () => {
    const rows = await db.prepare('SELECT * FROM terminal_modes ORDER BY "order" ASC').all()
    return rows.map(mapModeRow)
  })

  handle('terminalModes:test', async (_, command: string) => {
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
  })

  handle('terminalModes:get', async (_, id: string) => {
    const row = await db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return row ? mapModeRow(row) : null
  })

  handle('terminalModes:create', async (_, input: CreateTerminalModeInput) => {
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
  })

  handle(
    'terminalModes:update',
    async (_, id: string, updates: UpdateTerminalModeInput) => {
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
  )

  handle('terminalModes:delete', async (_, id: string) => {
    const deleteRow = (await db
      .prepare('SELECT is_builtin FROM terminal_modes WHERE id = ?')
      .get(id)) as { is_builtin: number } | undefined
    if (deleteRow?.is_builtin) {
      return false // Built-in modes cannot be deleted
    }
    await db.prepare('DELETE FROM terminal_modes WHERE id = ?').run(id)
    return true
  })

  handle('terminalModes:restoreDefaults', async () => {
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
  })

  handle('terminalModes:resetToDefaultState', async () => {
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
  })

  handle('pty:create', async (event, opts: PtyCreateOpts) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: 'No window found' }

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
      win,
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
  })

  handle('pty:testExecutionContext', async (_, context: ExecutionContext) => {
    return testExecutionContext(context)
  })

  handle('pty:write', (_, sessionId: string, data: string) => {
    return writePty(sessionId, data)
  })

  handle('pty:submit', (_, sessionId: string, text: string) => {
    return submitPty(sessionId, text)
  })

  handle('pty:resize', (_, sessionId: string, cols: number, rows: number) => {
    return resizePty(sessionId, cols, rows)
  })

  handle('pty:kill', (_, sessionId: string) => {
    return killPty(sessionId)
  })

  handle('pty:touch', (_, sessionId: string) => {
    return touchPty(sessionId)
  })

  handle('pty:interrupt', (_, sessionId: string) => {
    return interruptPty(sessionId)
  })

  handle('pty:exists', (_, sessionId: string) => {
    return hasPty(sessionId)
  })

  handle('pty:getBuffer', (_, sessionId: string) => {
    return getBuffer(sessionId)
  })

  handle('pty:clearBuffer', (_, sessionId: string) => {
    return clearBuffer(sessionId)
  })

  handle('pty:getBufferSince', (_, sessionId: string, afterSeq: number) => {
    return getBufferSince(sessionId, afterSeq)
  })

  handle('pty:list', () => {
    return listPtys()
  })

  handle('chat:list', () => {
    return listChatSessions()
  })

  // Warm-process gate: the renderer pushes its full per-project open-task-tab snapshot
  // (keyed by projectId). Main unions across windows to decide which projects keep a warm
  // shell. Idempotent — a full snapshot each time, so dropped messages self-heal. A window's
  // contribution is cleared when its webContents is destroyed.
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

  handle('pty:getState', (_, sessionId: string) => {
    return getState(sessionId)
  })

  handle('session:list', () => {
    return listSessions()
  })

  handle('session:getState', (_, sessionId: string) => {
    return getSessionState(sessionId)
  })

  handle(
    'pty:set-theme',
    (
      _,
      theme: { foreground: string; background: string; cursor: string; ansi?: readonly string[] }
    ) => {
      setTerminalTheme(theme)
    }
  )

  handle('pty:validate', async (_, mode: TerminalMode) => {
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
  })

  handle('pty:setShellOverride', (_, value: string | null) => {
    setShellOverride(value)
  })
}
