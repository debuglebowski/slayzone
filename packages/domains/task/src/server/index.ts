// Electron-free task server surface. Consumed by the transport task/template/artifacts
// routers (which must run under plain Node for the standalone @slayzone/hub host)
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
  prunePendingSpawns,
  recordSessionSpawn,
  confirmSessionConversation,
  confirmSessionConversationByTaskMode,
  markSessionDead,
  bindSessionToTask,
  getBoundTaskId
} from './ops'
export type { CreateImportedTaskInput } from './ops'
export {
  configureTaskRuntimeAdapters,
  updateTask,
  defaultWorktreeExecAdapters
} from './ops/shared'
export type { WorktreeExecAdapters } from './ops/shared'
export { purgeStaleAndOrphanedTasks } from './ops/startup-purge'
export type {
  OpDeps,
  TaskRuntimeAdapters,
  DiagnosticEventPayload,
  DiagnosticLevel
} from './ops/shared'
export { taskOps } from './task-ops-bundle'
export type { TaskOps } from './task-ops-bundle'
export { handleAttentionTransition } from './attention'
// Conversation self-heal + resolver. Registered by BOTH composition roots (the
// Electron main process and the slice-9 sidecar that owns the pty runtime) so
// the healer/resolver seams `createPty` calls are never left null. Lives here
// because it needs task DB ops + terminal transcript helpers + worktrees branch
// lookup, and the package graph runs task → those (a cycle from terminal/server).
export { registerConversationHealer, registerConversationResolver } from './conversation-healer'
