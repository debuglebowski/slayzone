import type { SlayzoneDb } from '@slayzone/platform'
import type { TasksChange } from '@slayzone/task-contracts'
import type { TypedEmitter } from '@slayzone/platform/events'
import type { HubMenuEventMap } from '../../app-deps'
import type { TaskAgentsAccess, TaskOpsBus } from '../rest-api/types'

export interface McpToolsDeps {
  db: SlayzoneDb
  notifyRenderer: (change?: TasksChange) => void
  /** Structural completion-event bus the task ops emit on (Electron: ipcMain).
   *  Absent → completion events drop (standalone server). */
  taskBus?: TaskOpsBus
  /** Menu/app-shortcut bus for UI side effects (close-task). */
  menu?: TypedEmitter<HubMenuEventMap>
  /** Legacy webContents.send fan-out — Electron host only; dropped slice 8. */
  legacyBroadcast?: (channel: string, ...args: unknown[]) => void
  /** Completion guard for `update_task`. Absent → this host runs no agents. */
  taskAgents?: TaskAgentsAccess
}
