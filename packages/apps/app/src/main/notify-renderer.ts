import { TypedEmitter } from '@slayzone/platform/events'
import type { NotifyEventMap } from '@slayzone/transport/server'

/**
 * Source for the tRPC `notify.*` subscriptions.
 */
export const notifyEvents = new TypedEmitter<NotifyEventMap>()

export function notifyRenderer(): void {
  notifyEvents.emit('tasks-changed')
  notifyEvents.emit('settings-changed')
}
