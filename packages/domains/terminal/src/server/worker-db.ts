/**
 * Worker-safe DB surface for the terminal domain.
 *
 * The DB worker thread must NOT import `@slayzone/terminal/main` — that barrel
 * pulls node-pty, xterm and Electron, none of which load in a worker. This
 * narrow entry re-exports only the pure (better-sqlite3 + shared types)
 * DB-startup and transaction logic the worker needs.
 */
export { syncTerminalModes } from './startup-sync'
export { chatQueueTxns } from './chat-queue-txns'
