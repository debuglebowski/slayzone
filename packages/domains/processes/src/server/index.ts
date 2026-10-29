export {
  processEvents,
  subscribeToProcessLogs,
  setProcessManagerWindow,
  initProcessManager,
  initProcessManagerWith,
  createProcess,
  spawnProcess,
  updateProcess,
  stopProcess,
  killProcess,
  restartProcess,
  killTaskProcesses,
  listForTask,
  listAllProcesses,
  killAllProcesses,
  shutdownAllProcesses,
  setProjectCwdResolver
} from './process-manager'
export type { ProcessStatus, ProcessInfo } from '../shared'
export type {
  ProcessShutdownOptions,
  ProcessShutdownResult,
  ProjectCwdResolver
} from './process-manager'
export { createDbProcessPersistence } from './process-persistence'
export type { ProcessPersistence, PersistedProcess, ProcessRow } from './process-persistence'
export { setProcessBackend, getProcessBackend, localProcessBackend } from './process-backend'
export type { ProcessBackend, ProcSpawnSpec, ProcHandle } from './process-backend'
export { createStatsPoller } from './pid-stats'
// `processes.*` tRPC router + the host-injected process-manager deps it calls.
// Composed by `@slayzone/api`; the deps are injected by the composition root.
export { processesRouter, type ProcessesRouter, type ProcessesMounts } from './processes-router'
export { setProcessesDeps, getProcessesDeps, type ProcessesDeps } from './processes-deps'
