import { EventEmitter } from 'node:events'

export const notifyEvents = new EventEmitter() as EventEmitter & {
  on(event: 'tasks-changed', listener: () => void): EventEmitter
  on(event: 'settings-changed', listener: () => void): EventEmitter
  off(event: string, listener: (...args: unknown[]) => void): EventEmitter
}

export function notifyRenderer(): void {
  notifyEvents.emit('tasks-changed')
  notifyEvents.emit('settings-changed')
}
