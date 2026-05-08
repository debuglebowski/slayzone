import { EventEmitter } from 'node:events'

export interface EmbeddedServerFailedPayload {
  attempts: number
  message: string
}

export const notifyEvents = new EventEmitter() as EventEmitter & {
  on(event: 'tasks-changed', listener: () => void): EventEmitter
  on(event: 'settings-changed', listener: () => void): EventEmitter
  on(event: 'embedded-server-failed', listener: (p: EmbeddedServerFailedPayload) => void): EventEmitter
  off(event: string, listener: (...args: unknown[]) => void): EventEmitter
  emit(event: 'tasks-changed'): boolean
  emit(event: 'settings-changed'): boolean
  emit(event: 'embedded-server-failed', payload: EmbeddedServerFailedPayload): boolean
}

export function notifyRenderer(): void {
  notifyEvents.emit('tasks-changed')
  notifyEvents.emit('settings-changed')
}
