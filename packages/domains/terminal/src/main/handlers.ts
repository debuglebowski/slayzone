import { BrowserWindow } from 'electron'
import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { createPty, writePty, resizePty, killPty, hasPty, getBuffer, clearBuffer, getBufferSince, listPtys, getState, setDatabase, dismissAllNotifications, setTerminalTheme, setCcsEnabled, testExecutionContext } from './pty-manager'
import { getAdapter, type TerminalMode, type ExecutionContext } from './adapters'
import type { CodeMode } from '@slayzone/terminal/shared'
import { parseShellArgs } from './adapters/flag-parser'
import { setShellOverrideProvider, listCcsProfiles } from './shell-env'

interface PtyCreateOpts {
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  mode?: TerminalMode
  initialPrompt?: string | null
  codeMode?: CodeMode | null
  providerFlags?: string | null
  executionContext?: ExecutionContext | null
  ccsProfile?: string | null
}

export function registerPtyHandlers(ipcMain: IpcMain, db: Database): void {
  // Set database reference for notifications
  setDatabase(db)
  setShellOverrideProvider(() => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('shell') as { value: string } | undefined
    const value = row?.value?.trim()
    return value ? value : null
  })
  // Read initial CCS setting; updated via pty:setCcsEnabled IPC
  const ccsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ccs_enabled') as { value: string } | undefined
  setCcsEnabled(ccsRow?.value === '1')

  ipcMain.handle(
    'pty:create',
    (event, opts: PtyCreateOpts) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, error: 'No window found' }

      let providerArgs: string[] = []
      try {
        providerArgs = parseShellArgs(opts.providerFlags)
      } catch (err) {
        console.warn('[pty:create] Invalid provider flags, ignoring:', (err as Error).message)
      }

      return createPty(win, opts.sessionId, opts.cwd, opts.conversationId, opts.existingConversationId, opts.mode, opts.initialPrompt, providerArgs, opts.codeMode, opts.executionContext, opts.ccsProfile)
    }
  )

  ipcMain.handle('pty:testExecutionContext', async (_, context: ExecutionContext) => {
    return testExecutionContext(context)
  })

  ipcMain.handle('pty:setCcsEnabled', (_, enabled: boolean) => {
    setCcsEnabled(enabled)
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
    const adapter = getAdapter(mode)
    return adapter.validate ? adapter.validate() : []
  })
}
