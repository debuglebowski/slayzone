import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import { listAgentTurnsForWorktree } from '../server/list-turns'

export function registerAgentTurnsHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  ipcMain.handle('agent-turns:list', (_, worktreePath: string) =>
    listAgentTurnsForWorktree(db, worktreePath)
  )
}
