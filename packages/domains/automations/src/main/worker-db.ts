/**
 * Worker-safe DB surface for the automations domain.
 *
 * The DB worker thread must NOT import `@slayzone/automations/main` — that
 * barrel pulls Electron (IPC handler registration) and child_process (command
 * execution). This narrow entry re-exports only the pure (better-sqlite3 +
 * worker-safe recorder) named-transaction logic the worker needs.
 */
export { automationsTxns } from './automations-txns'
