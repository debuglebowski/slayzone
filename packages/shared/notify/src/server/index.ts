/**
 * The `notify` router (top-level key `notify`): cross-domain refresh signals
 * (`tasks-changed`, `settings-changed`, `embedded-server-failed`), the event bus
 * they stream, and the per-subscriber burst coalescer. A base package (deps:
 * platform, trpc-server, task-contracts, settings-core) so a domain client can type
 * its `notify.*` calls (`NotifyMounts`) without depending on `@slayzone/api`.
 *
 * @module notify/server
 */
export { notifyRouter, type NotifyRouter, type NotifyMounts } from './notify-router'
export {
  setNotifyEvents,
  getNotifyEvents,
  emitSettingsChanged,
  emitTasksChanged,
  type NotifyEventMap,
  type SettingsChange
} from './notify-events'
export { createNotifyCoalescer, NOTIFY_COALESCE_MS, type Coalescer } from './notify-coalescer'
