import { broadcastToWindows } from './broadcast-to-windows'
import { TypedEmitter } from '@slayzone/platform/events'
import type { NotifyEventMap } from '@slayzone/transport/server'

/**
 * Source for the tRPC `notify.*` subscriptions (slice-5 renderer consumes).
 * Injected into the transport package via `setNotifyEvents()` at boot so the
 * `notifyRouter` and the legacy IPC broadcast below share one instance.
 */
export const notifyEvents = new TypedEmitter<NotifyEventMap>()

export function notifyRenderer(): void {
  // tRPC notify.* subscription source.
  notifyEvents.emit('tasks-changed')
  notifyEvents.emit('settings-changed')
  // Legacy IPC broadcast — stays until the renderer drops IPC (slice 5).
  broadcastToWindows('tasks:changed')
  broadcastToWindows('settings:changed')
}
