import { BrowserWindow } from 'electron'
import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createPty, writePty, resizePty, killPty, hasPty, getBuffer, clearBuffer, getBufferSince, listPtys, getState, setDatabase, dismissAllNotifications, setTerminalTheme, testExecutionContext } from './pty-manager'

const execFileAsync = promisify(execFile)
import { getAdapter, type ExecutionContext } from './adapters'
import type { TerminalMode, TerminalModeInfo, CreateTerminalModeInput, UpdateTerminalModeInput } from '@slayzone/terminal/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import { parseShellArgs } from './adapters/flag-parser'
import { setShellOverrideProvider, listCcsProfiles } from './shell-env'
import { syncTerminalModes } from './startup-sync'

interface PtyCreateOpts {
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  mode?: TerminalMode
  initialPrompt?: string | null
  providerFlags?: string | null
  executionContext?: ExecutionContext | null
}

function mapModeRow(row: any): TerminalModeInfo {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    initialCommand: row.initial_command,
    resumeCommand: row.resume_command,
    defaultFlags: row.default_flags,
    enabled: Boolean(row.enabled),
    isBuiltin: Boolean(row.is_builtin),
    order: row.order,
    patternAttention: row.pattern_attention,
    patternWorking: row.pattern_working,
    patternError: row.pattern_error,
  }
}

export function registerPtyHandlers(ipcMain: IpcMain, db: Database): void {
  // Set database reference for notifications
  setDatabase(db)
  setShellOverrideProvider(() => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('shell') as { value: string } | undefined
    const value = row?.value?.trim()
    return value ? value : null
  })

  // Synchronize built-in modes from code to database
  syncTerminalModes(db)

  // Terminal Modes CRUD
  ipcMain.handle('terminalModes:list', async () => {
    const rows = db.prepare('SELECT * FROM terminal_modes ORDER BY "order" ASC').all()
    return rows.map(mapModeRow)
  })

  ipcMain.handle('terminalModes:test', async (_, command: string) => {
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

  ipcMain.handle('terminalModes:get', async (_, id: string) => {
    const row = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return row ? mapModeRow(row) : null
  })

  ipcMain.handle('terminalModes:create', async (_, input: CreateTerminalModeInput) => {
    const id = input.id
    db.prepare(`
      INSERT INTO terminal_modes (id, label, type, initial_command, resume_command, default_flags, enabled, is_builtin, "order", pattern_attention, pattern_working, pattern_error)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      id,
      input.label,
      input.type,
      input.initialCommand ?? null,
      input.resumeCommand ?? null,
      input.defaultFlags ?? null,
      input.enabled !== false ? 1 : 0,
      input.order ?? 0,
      input.patternAttention ?? null,
      input.patternWorking ?? null,
      input.patternError ?? null
    )
    const row = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return mapModeRow(row)
  })

  ipcMain.handle('terminalModes:update', async (_, id: string, updates: UpdateTerminalModeInput) => {
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
    if (updates.patternAttention !== undefined) {
      sets.push('pattern_attention = ?')
      params.push(updates.patternAttention ?? null)
    }
    if (updates.patternWorking !== undefined) {
      sets.push('pattern_working = ?')
      params.push(updates.patternWorking ?? null)
    }
    if (updates.patternError !== undefined) {
      sets.push('pattern_error = ?')
      params.push(updates.patternError ?? null)
    }

    if (sets.length > 0) {
      sets.push('updated_at = datetime(\'now\')')
      params.push(id)
      db.prepare(`UPDATE terminal_modes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    const updatedRow = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(id)
    return updatedRow ? mapModeRow(updatedRow) : null
  })

  ipcMain.handle('terminalModes:delete', async (_, id: string) => {
    const deleteRow = db.prepare('SELECT is_builtin FROM terminal_modes WHERE id = ?').get(id) as { is_builtin: number } | undefined
    if (deleteRow?.is_builtin) {
      return false // Built-in modes cannot be deleted
    }
    db.prepare('DELETE FROM terminal_modes WHERE id = ?').run(id)
    return true
  })

  ipcMain.handle('terminalModes:restoreDefaults', async () => {
    db.transaction(() => {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO terminal_modes (id, label, type, initial_command, resume_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      for (const mode of DEFAULT_TERMINAL_MODES) {
        insertStmt.run(
          mode.id,
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.defaultFlags ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        )
      }
    })()
  })

  ipcMain.handle('terminalModes:resetToDefaultState', async () => {
    db.transaction(() => {
      db.prepare('DELETE FROM terminal_modes').run()
      const insertStmt = db.prepare(`
        INSERT INTO terminal_modes (id, label, type, initial_command, resume_command, default_flags, enabled, is_builtin, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      for (const mode of DEFAULT_TERMINAL_MODES) {
        insertStmt.run(
          mode.id,
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.defaultFlags ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        )
      }
    })()
  })

  ipcMain.handle(
    'pty:create',
    async (event, opts: PtyCreateOpts) => {
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

      if (modeId === 'terminal') {
        return createPty({ win, sessionId: opts.sessionId, cwd: opts.cwd, conversationId: opts.conversationId, existingConversationId: opts.existingConversationId, mode: 'terminal', initialPrompt: opts.initialPrompt, providerArgs, executionContext: opts.executionContext, type: 'terminal' })
      }

      const modeRow = db.prepare('SELECT * FROM terminal_modes WHERE id = ?').get(modeId)
      const modeInfo = modeRow ? mapModeRow(modeRow) : undefined

      return createPty({
        win,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        conversationId: opts.conversationId,
        existingConversationId: opts.existingConversationId,
        mode: opts.mode as TerminalMode,
        initialPrompt: opts.initialPrompt,
        providerArgs,
        executionContext: opts.executionContext,
        type: modeInfo?.type,
        initialCommand: modeInfo?.initialCommand,
        resumeCommand: modeInfo?.resumeCommand,
        defaultFlags: modeInfo?.defaultFlags,
        patternAttention: modeInfo?.patternAttention,
        patternWorking: modeInfo?.patternWorking,
        patternError: modeInfo?.patternError,
      })
    }
  )

  ipcMain.handle('pty:testExecutionContext', async (_, context: ExecutionContext) => {
    return testExecutionContext(context)
  })

  ipcMain.handle('pty:ccsListProfiles', async () => {
    try {
      const profiles = await listCcsProfiles()
      return { profiles }
    } catch (e: unknown) {
      return { profiles: [], error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('pty:write', (_, sessionId: string, data: string) => {
    return writePty(sessionId, data)
  })

ipcMain.handle('pty:resize', (_, sessionId: string, cols: number, rows: number) => {
    return resizePty(sessionId, cols, rows)
  })

  ipcMain.handle('pty:kill', (_, sessionId: string) => {
    return killPty(sessionId)
  })

  ipcMain.handle('pty:exists', (_, sessionId: string) => {
    return hasPty(sessionId)
  })

  ipcMain.handle('pty:getBuffer', (_, sessionId: string) => {
    return getBuffer(sessionId)
  })

  ipcMain.handle('pty:clearBuffer', (_, sessionId: string) => {
    return clearBuffer(sessionId)
  })

  ipcMain.handle('pty:getBufferSince', (_, sessionId: string, afterSeq: number) => {
    return getBufferSince(sessionId, afterSeq)
  })

  ipcMain.handle('pty:list', () => {
    return listPtys()
  })

  ipcMain.handle('pty:getState', (_, sessionId: string) => {
    return getState(sessionId)
  })

  ipcMain.handle('pty:dismissAllNotifications', () => {
    dismissAllNotifications()
  })

  ipcMain.handle('pty:set-theme', (_, theme: { foreground: string; background: string; cursor: string }) => {
    setTerminalTheme(theme)
  })

  ipcMain.handle('pty:validate', async (_, mode: TerminalMode) => {
    const adapter = getAdapter({ mode })
    return adapter.validate ? adapter.validate() : []
  })
}
