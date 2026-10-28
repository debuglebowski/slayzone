/**
 * Worker-safe DB surface for the task domain.
 *
 * The DB worker thread must NOT import `@slayzone/task/main` — that barrel pulls
 * Electron (IPC handler registration) and file watchers. This narrow entry
 * re-exports only the pure named-transaction logic the worker needs:
 * task mutations and template ops. (Artifact CRUD txns live in
 * `task-artifacts/db`.)
 */
export { taskTxns } from './task-txns'
export { templatesTxns } from './templates-txns'
