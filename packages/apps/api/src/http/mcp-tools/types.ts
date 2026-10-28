import type { SlayzoneDb } from '@slayzone/platform'
import type { TypedEmitter } from '@slayzone/platform/events'
import type { MenuEventMap } from '../../app-deps'
import type { TaskOpsBus } from '../rest-api/types'

export interface McpToolsDeps {
  db: SlayzoneDb
  notifyRenderer: () => void
  /** Structural completion-event bus the task ops emit on (Electron: ipcMain).
   *  Absent → completion events drop (standalone server). */
  taskBus?: TaskOpsBus
  /** Menu/app-shortcut bus for UI side effects (close-task). */
  menu?: TypedEmitter<MenuEventMap>
  /** Legacy webContents.send fan-out — Electron host only; dropped slice 8. */
  legacyBroadcast?: (channel: string, ...args: unknown[]) => void
}
