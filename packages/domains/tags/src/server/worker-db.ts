/**
 * Worker-safe DB surface for the tags domain.
 *
 * The DB worker thread must NOT import `@slayzone/tags/main` — that barrel pulls
 * Electron (IPC handler registration). This narrow entry re-exports only the
 * pure (better-sqlite3 + shared types) named-transaction logic the worker needs.
 */
export { tagsTxns } from './tags-txns'
