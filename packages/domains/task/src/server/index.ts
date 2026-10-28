// Electron-free task server surface. Consumed by the transport task/template/artifacts
// routers (which must run under plain Node for the standalone @slayzone/hub host)
// and by the Electron host. The task CRUD ops are pure — ops/shared.ts is seamed via
// TaskRuntimeAdapters (no Electron `app`/IPC), so the whole op set is exported here.
// The Electron host injects its runtime adapters at boot via configureTaskRuntimeAdapters.

export { taskEvents, agentSessionsEvents } from './events'
export type { TaskEventMap, AgentSessionsEventMap } from './events'
export { agentSessionsRouter } from './agent-sessions-router'

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
export { templateRouter } from './template-router'

// The artifact store (createArtifactStore / parseArtifact / parseFolder) and its
// worker txns live in `task-artifacts/server` + `/db`.
export { buildFolderPathResolver, collectFolderAndDescendants } from './artifact-folder-tree'
export { artifactsDirOf, artifactTaskDir, artifactFilePathIn } from './artifact-paths'

// Artifact downloads. Electron-free — the host-only steps (dialogs, reveal,
// offscreen PDF/PNG render) are injected as ArtifactDownloadHost, which the
// transport layer fills from the AppDeps capability bridge.
export {
  downloadArtifactFile,
  downloadArtifactFolder,
  downloadArtifactAsPdf,
  downloadArtifactAsPng,
  downloadArtifactAsHtml,
  downloadAllArtifactsAsZip
} from './artifact-downloads'
export type { ArtifactDownloadHost } from './artifact-downloads'

// Pure task ops + conversation ledger. The Electron host injects runtime adapters
// at boot via configureTaskRuntimeAdapters (kill PTYs, data root, diagnostics…).
export {
  archiveTaskOp,
  archiveManyTasksOp,
  createTaskOp,
  createImportedTaskOp,
  insertTaskRow,
  type TaskRowData,
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
  listTaskSessions,
  isHonoredConversation,
  deleteSession,
  recordPendingSpawn,
  findPendingSpawn,
  findOwnedSpawnForConversation,
  prunePendingSpawns,
  recordSessionSpawn,
  confirmSessionConversation,
  confirmSessionConversationByTaskMode,
  markSessionDead,
  markSessionFirstTurn,
  listResumeCandidates,
  bindSessionToTask
} from './ops'
export type { CreateImportedTaskInput, TaskSessionSummary } from './ops'
export { taskSessionStore } from './task-session-store'
export { configureTaskRuntimeAdapters, updateTask, InvalidTaskUpdateError } from './ops/shared'
// The in-process implementations (`defaultWorktreeExecAdapters`,
// `defaultWorktreePolicyAdapters`) live in `worktrees/server`.
export type { WorktreeExecAdapters, WorktreePolicyAdapters } from './ops/shared'
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
// because it needs task DB ops + terminal transcript helpers, and the package graph
// runs task → terminal (a cycle from terminal/server). The git branch lookup is
// injected (`ConversationHealerDeps`) since worktrees builds on task.
export { registerConversationHealer, registerConversationResolver } from './conversation-healer'
export type { ConversationHealerDeps } from './conversation-healer'
