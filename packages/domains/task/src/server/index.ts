// Electron-free task server surface. Consumed by the transport task/template/artifacts
// routers (which must run under plain Node for the standalone @slayzone/server host)
// and by the Electron host. The task CRUD ops are pure — ops/shared.ts is seamed via
// TaskRuntimeAdapters (no Electron `app`/IPC), so the whole op set is exported here.
// The Electron host injects its runtime adapters at boot via configureTaskRuntimeAdapters.

export { taskEvents } from './events'
export type { TaskEventMap } from './events'

export {
  artifactWatcherEvents,
  startArtifactWatcher,
  closeArtifactWatcher
} from './artifact-watcher'
export type { ArtifactWatcherEventMap } from './artifact-watcher'

export {
  parseTemplate,
  getTemplateForTask,
  listTemplatesByProject,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate
} from './template-store'

export {
  createArtifactStore,
  parseArtifact,
  parseFolder,
  buildFolderPathResolver,
  collectFolderAndDescendants
} from './artifact-store'
export type { ArtifactStore } from './artifact-store'

// Pure task ops + conversation ledger. The Electron host injects runtime adapters
// at boot via configureTaskRuntimeAdapters (kill PTYs, data root, diagnostics…).
export {
  archiveTaskOp,
  archiveManyTasksOp,
  createTaskOp,
  createImportedTaskOp,
  deleteTaskOp,
  getTaskOp,
  restoreTaskOp,
  unarchiveTaskOp,
  updateTaskOp,
  collectReferencedConversationIds,
  casRepointConversationId,
  recordConversation,
  getCurrentConversationId,
  listConversationHistory,
  recordPendingSpawn,
  findPendingSpawn,
  prunePendingSpawns
} from './ops'
export type { CreateImportedTaskInput } from './ops'
export { configureTaskRuntimeAdapters, updateTask } from './ops/shared'
export type {
  OpDeps,
  TaskRuntimeAdapters,
  DiagnosticEventPayload,
  DiagnosticLevel
} from './ops/shared'
export { taskOps } from './task-ops-bundle'
export type { TaskOps } from './task-ops-bundle'
export { handleAttentionTransition } from './attention'
