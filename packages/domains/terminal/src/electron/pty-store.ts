import { BrowserWindow } from 'electron'
import type { Database } from 'better-sqlite3'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createPty, writePty, submitPty, resizePty, killPty, hasPty, getBuffer, clearBuffer, getBufferSince, getHistorySnapshot, getHistoryBefore, setArchiveCapBytes, listPtys, getState, setDatabase, setTerminalTheme, testExecutionContext } from './pty-manager'
import { listSessions, getSessionState } from './session-registry'
import { listChatSessions } from './chat-transport-manager'

const execFileAsync = promisify(execFile)
import { getAdapter, type ExecutionContext } from '../server/adapters'
import type { TerminalMode, TerminalModeInfo, CreateTerminalModeInput, UpdateTerminalModeInput } from '@slayzone/terminal/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import { parseShellArgs } from '../server/adapters/flag-parser'
import { listCcsProfiles, setShellOverride } from '../server/shell-env'
import { syncTerminalModes } from '../server/startup-sync'

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
    try { usageConfig = JSON.parse(row.usage_config) } catch { /* ignore corrupt */ }
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
    usageConfig,
  }
}

export function createPtyOps(db: Database) {

  // Set database reference for notifications
  setDatabase(db)

  // Synchronize built-in modes from code to database
  syncTerminalModes(db)

  // Apply scrollback archive cap from setting (default 10MB if unset)
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('terminal_archive_cap_mb') as { value: string } | undefined
    const mb = row?.value ? parseInt(row.value, 10) : NaN
    if (Number.isFinite(mb) && mb >= 1) setArchiveCapBytes(mb * 1024 * 1024)
  } catch { /* ignore */ }

  const ptySetArchiveCapMb = (mb: number) => {
    if (Number.isFinite(mb) && mb >= 1) setArchiveCapBytes(Math.floor(mb) * 1024 * 1024)
  }

  // Terminal Modes CRUD
  const terminalModesList = async () => {
    const rows = db.prepare('SELECT * FROM terminal_modes ORDER BY "order" ASC').all()
    return rows.map(mapModeRow)
  }

  const terminalModesTest = async (command: string) => {
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

  const terminalModesGet = async (id: string) => {
    const row = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return row ? mapModeRow(row) : null
  }

  const terminalModesCreate = async (input: CreateTerminalModeInput) => {
    const id = input.id
    db.prepare(`
      INSERT INTO terminal_modes (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order", pattern_working, pattern_error, usage_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
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
    const row = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return mapModeRow(row)
  }

  const terminalModesUpdate = async (id: string, updates: UpdateTerminalModeInput) => {
    const builtinRow = db.prepare('SELECT is_builtin FROM terminal_modes WHERE id = ?').get(id) as { is_builtin: number } | undefined
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
      sets.push('updated_at = datetime(\'now\')')
      params.push(id)
      db.prepare(`UPDATE terminal_modes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    const updatedRow = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return updatedRow ? mapModeRow(updatedRow) : null
  }

  const terminalModesDelete = async (id: string) => {
    const deleteRow = db.prepare('SELECT is_builtin FROM terminal_modes WHERE id = ?').get(id) as { is_builtin: number } | undefined
    if (deleteRow?.is_builtin) {
      return false // Built-in modes cannot be deleted
    }
    db.prepare('DELETE FROM terminal_modes WHERE id = ?').run(id)
    return true
  }

  const terminalModesRestoreDefaults = async () => {
    db.transaction(() => {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO terminal_modes (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      for (const mode of DEFAULT_TERMINAL_MODES) {
        insertStmt.run(
          mode.id,
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.headlessCommand ?? null,
          mode.defaultFlags ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        )
      }
    })()
  }

  const terminalModesResetToDefaultState = async () => {
    db.transaction(() => {
      db.prepare('DELETE FROM terminal_modes').run()
      const insertStmt = db.prepare(`
        INSERT INTO terminal_modes (id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      for (const mode of DEFAULT_TERMINAL_MODES) {
        insertStmt.run(
          mode.id,
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.headlessCommand ?? null,
          mode.defaultFlags ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        )
      }
    })()
  }

  const ptyCreate = async (opts: PtyCreateOpts) => {
      // Post-tRPC migration: PTY data flows via ptyEvents emitter (no per-window
      // routing). win is still required for some redirectSessionWindow() codepaths.
      // Use focused/main BrowserWindow.
      const focused = BrowserWindow.getFocusedWindow()
      const all = BrowserWindow.getAllWindows()
      const win = focused ?? all[0]
      if (!win) return { success: false, error: 'No window found' }

      let providerArgs: string[] = []
      try {
        providerArgs = parseShellArgs(opts.providerFlags)
      } catch (err) {
        console.warn('[pty:create] Invalid provider flags, ignoring:', (err as Error).message)
      }

      // Look up mode info to get type, templates, and default flags
      const modeId = opts.mode || 'claude-code'

      const modeRow = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(modeId)
      const modeInfo = modeRow ? mapModeRow(modeRow) : undefined

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
      })
    }

  const ptyTestExecutionContext = async (context: ExecutionContext) => {
    return testExecutionContext(context)
  }

  const ptyCcsListProfiles = async () => {
    try {
      const profiles = await listCcsProfiles()
      return { profiles }
    } catch (e: unknown) {
      return { profiles: [], error: e instanceof Error ? e.message : String(e) }
    }
  }

  const ptyWrite = (sessionId: string, data: string) => {
    return writePty(sessionId, data)
  }

  const ptySubmit = (sessionId: string, text: string) => {
    return submitPty(sessionId, text)
  }

const ptyResize = (sessionId: string, cols: number, rows: number) => {
    return resizePty(sessionId, cols, rows)
  }

  const ptyKill = (sessionId: string) => {
    return killPty(sessionId)
  }

  const ptyExists = (sessionId: string) => {
    return hasPty(sessionId)
  }

  const ptyGetBuffer = (sessionId: string) => {
    return getBuffer(sessionId)
  }

  const ptyClearBuffer = (sessionId: string) => {
    return clearBuffer(sessionId)
  }

  const ptyGetBufferSince = (sessionId: string, afterSeq: number) => {
    return getBufferSince(sessionId, afterSeq)
  }

  const ptyGetHistorySnapshot = (sessionId: string, lineCount: number) => {
    return getHistorySnapshot(sessionId, lineCount)
  }

  const ptyGetHistoryBefore = (sessionId: string, currentEarliestOffset: number, lineCount: number) => {
    return getHistoryBefore(sessionId, currentEarliestOffset, lineCount)
  }

  const ptyList = () => {
    return listPtys()
  }

  const chatList = () => {
    return listChatSessions()
  }

  const ptyGetState = (sessionId: string) => {
    return getState(sessionId)
  }

  const sessionList = () => {
    return listSessions()
  }

  const sessionGetState = (sessionId: string) => {
    return getSessionState(sessionId)
  }

  const ptySetTheme = (theme: { foreground: string; background: string; cursor: string; ansi?: readonly string[] }) => {
    setTerminalTheme(theme)
  }

  const ptyValidate = async (mode: TerminalMode) => {
    const modeRow = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(mode)
    const modeInfo = modeRow ? mapModeRow(modeRow) : undefined
    const adapter = getAdapter({
      mode,
      type: modeInfo?.type,
      patterns: {
        working: modeInfo?.patternWorking,
        error: modeInfo?.patternError,
      },
    })
    return adapter.validate ? adapter.validate() : []
  }

  const ptySetShellOverride = (value: string | null) => {
    setShellOverride(value)
  }
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
    ptyCcsListProfiles,
    ptyWrite,
    ptySubmit,
    ptyResize,
    ptyKill,
    ptyExists,
    ptyGetBuffer,
    ptyClearBuffer,
    ptyGetBufferSince,
    ptyGetHistorySnapshot,
    ptyGetHistoryBefore,
    ptySetArchiveCapMb,
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
