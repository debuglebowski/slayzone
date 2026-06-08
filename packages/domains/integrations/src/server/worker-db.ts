/**
 * Worker-safe DB surface for the integrations domain.
 *
 * The DB worker thread must NOT import `@slayzone/integrations/main` — that
 * barrel pulls in Electron-laden handler/client code. This narrow entry
 * re-exports only the pure (better-sqlite3 + pure shared types) named-transaction
 * logic the worker needs.
 */
export { integrationTxns } from './integration-txns'
export { ensureIntegrationSchemaSync } from './schema'
