// Electron-free integrations surface. The credential store is seamed via
// CredentialCipher (Electron injects safeStorage at boot); onTaskReachedTerminal
// is imported from @slayzone/terminal/server (the no-op seam). Consumed by the
// IPC handlers (../electron) and the tRPC integrations router.
export { createIntegrationOps, ensureIntegrationSchema } from './handlers-store'
export type { IntegrationOps } from './handlers-store'
export {
  startSyncPoller,
  pushTaskAfterEdit,
  pushNewTaskToProviders,
  pushArchiveToProviders,
  pushUnarchiveToProviders,
  startDiscoveryPoller,
  resetSyncFlags
} from './sync'
export { getAdapter, getRegisteredProviders, registerAdapter } from './adapters'
export type { ProviderAdapter, NormalizedIssue, ExternalGroup, ExternalScope } from './adapters'
export { setCredentialCipher } from './credentials'
export type { CredentialCipher } from './credentials'
