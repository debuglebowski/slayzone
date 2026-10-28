/**
 * Worker-safe DB surface for the projects domain.
 *
 * The DB worker thread must NOT import `@slayzone/projects/electron` — that
 * barrel pulls Electron (IPC handler registration) and node fs side-effects.
 * This narrow entry (a sibling of the rest of `server/`) re-exports only the
 * pure (better-sqlite3 + shared types) named-transaction logic the worker needs.
 */
export { projectsTxns } from './projects-txns'
// Runtime boot step (every open, after migrations): re-validates each project's
// columns config against the LIVE column rules and re-homes tasks whose status
// no longer exists. Not a migration — it must track today's rules.
export { normalizeProjectStatusData } from './status-normalization'
