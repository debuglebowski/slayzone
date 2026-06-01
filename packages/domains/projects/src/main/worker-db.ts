/**
 * Worker-safe DB surface for the projects domain.
 *
 * The DB worker thread must NOT import `@slayzone/projects/main` — that barrel
 * pulls Electron (IPC handler registration) and node fs side-effects. This
 * narrow entry re-exports only the pure (better-sqlite3 + shared types)
 * named-transaction logic the worker needs.
 */
export { projectsTxns } from './projects-txns'
