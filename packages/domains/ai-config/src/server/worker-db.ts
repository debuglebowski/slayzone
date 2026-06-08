/**
 * Worker-safe DB surface for the ai-config domain.
 *
 * The DB worker thread must NOT import `@slayzone/ai-config/main` — that barrel
 * pulls Electron (IPC handler registration). This narrow entry re-exports only
 * the pure marketplace named-transaction logic (better-sqlite3 + node:crypto +
 * worker-safe skill-normalize + shared registry).
 */
export { marketplaceTxns } from './marketplace-txns'
