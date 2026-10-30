// Notify event bus — the cross-domain `tasks-changed` / `settings-changed`
// signals that back the `notify.*` subscriptions. The emitter is owned by the
// Electron-main host (`notify-renderer.ts`, which also drives the legacy IPC
// broadcast), injected here so the `notifyRouter` and the still-live
// `webContents.send` broadcast share one instance (coexistence until slice 5).
// The host conforms to `NotifyEventMap`; `@slayzone/api` re-exports the registry
// for its composition roots.
import type { TypedEmitter } from '@slayzone/platform/events'
import type { TasksChange } from '@slayzone/task-contracts'
import type { SettingsChange } from '@slayzone/settings-core/server'

export type NotifyEventMap = {
  /** Task data mutation. With a `TasksChange` the renderer patches just those
   *  rows; without one it reloads the board (see `TasksChange`). */
  'tasks-changed': [change?: TasksChange]
  /** Settings changed — renderer refetches affected config. With a `SettingsChange`
   *  only consumers of those keys refetch; without one, every consumer does. */
  'settings-changed': [change?: SettingsChange]
  /**
   * The supervised embedded @slayzone/hub exhausted its restart backoff
   * (slice 7) — renderer shows a persistent toast. Emitted by the Electron
   * host's sidecar supervisor `onPermanentFailure`.
   */
  'embedded-server-failed': [{ attempts: number; message: string }]
}

/** The setting keys a write changed (see `NotifyEventMap['settings-changed']`). */
export type { SettingsChange }

let notifyEvents: TypedEmitter<NotifyEventMap> | null = null

/**
 * Signal that settings were written. Best-effort: a host that wired no notify bus
 * (unit harnesses) has no subscriber to tell.
 */
export function emitSettingsChanged(change?: SettingsChange): void {
  notifyEvents?.emit('settings-changed', change)
}

/**
 * Signal that task data was written — the `tasks-changed` a router outside the task
 * domain fires (tags, artifacts), through a seam api wires. Same bus, same contract as
 * the task ops' own `onMutation`: name the tasks only when the write touched nothing
 * else the board shows (`TasksChange`). Best-effort, like `emitSettingsChanged`.
 */
export function emitTasksChanged(change?: TasksChange): void {
  notifyEvents?.emit('tasks-changed', change)
}

export function setNotifyEvents(ev: TypedEmitter<NotifyEventMap>): void {
  notifyEvents = ev
}

export function getNotifyEvents(): TypedEmitter<NotifyEventMap> {
  if (!notifyEvents)
    throw new Error('notifyEvents not initialized — call setNotifyEvents() in main host first')
  return notifyEvents
}
