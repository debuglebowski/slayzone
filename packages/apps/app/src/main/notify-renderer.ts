import { broadcastToWindows } from './broadcast-to-windows'

export function notifyRenderer(): void {
  broadcastToWindows('tasks:changed')
  broadcastToWindows('settings:changed')
}
