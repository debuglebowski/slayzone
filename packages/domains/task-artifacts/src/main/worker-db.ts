/**
 * Worker-safe DB surface for the task-artifacts domain.
 *
 * The DB worker thread must NOT import `@slayzone/task-artifacts/main` — that
 * barrel pulls in React/Electron-laden client + export code. This narrow entry
 * re-exports only the pure (node builtins + better-sqlite3 + pure shared
 * helpers) named-transaction logic the worker needs.
 */
export { artifactTxns } from './artifact-txns'
