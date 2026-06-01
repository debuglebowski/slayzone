/**
 * Worker-safe DB surface for the task domain.
 *
 * The DB worker thread must NOT import `@slayzone/task/main` — that barrel pulls
 * Electron (IPC handler registration) and file watchers. This narrow entry
 * re-exports only the pure named-transaction logic the worker needs:
 * task mutations, artifact CRUD, and template ops.
 */
export { taskTxns } from './task-txns'
export { artifactsTxns } from './artifacts-txns'
export { templatesTxns } from './templates-txns'
