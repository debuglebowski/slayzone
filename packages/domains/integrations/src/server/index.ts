// Electron-free integrations surface. The credential store encrypts with the hub's
// own key (setCredentialKeyRing, resolved at hub boot); onTaskReachedTerminal
// is imported from @slayzone/terminal/server (the no-op seam). Consumed by the
// IPC handlers (../electron) and the tRPC integrations router.
export { createIntegrationOps, ensureIntegrationSchema } from './handlers-store'
export type { IntegrationOps } from './handlers-store'
// `integrations.*` tRPC router + the ops registry it reads (host-wired via
// `setIntegrationOps`). Composed by `@slayzone/api`.
export {
  integrationsRouter,
  type IntegrationsRouter,
  type IntegrationsMounts
} from './integrations-router'
export { setIntegrationOps, getIntegrationOps } from './integrations-router-deps'
export {
  startSyncPoller,
  pushTaskAfterEdit,
  pushNewTaskToProviders,
  pushArchiveToProviders,
  pushUnarchiveToProviders,
  syncedTaskFieldsChanged,
  SYNCED_TASK_FIELDS,
  startDiscoveryPoller,
  resetSyncFlags
} from './sync'
export { getAdapter, getRegisteredProviders, registerAdapter } from './adapters'
export type { ProviderAdapter, NormalizedIssue, ExternalGroup, ExternalScope } from './adapters'
export {
  CREDENTIAL_RECONNECT_REQUIRED,
  migrateStoredCredentials,
  RECONNECT_AUTH_ERROR,
  setCredentialKeyRing,
  setLegacyCredentialDecryptor
} from './credentials'
export type { CredentialMigrationReport, LegacyCredentialDecryptor } from './credentials'
export type { CredentialKeyRing } from './hub-cipher'
