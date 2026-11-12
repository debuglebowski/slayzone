// Electron-free task server surface. Consumed by the transport task/template/artifacts
// routers (which must run under plain Node for the standalone @slayzone/hub host)
// and by the Electron host. The task CRUD ops are pure — ops/shared.ts is seamed via
// TaskRuntimeAdapters (no Electron `app`/IPC), so the whole op set is exported here.
// The Electron host injects its runtime adapters at boot via configureTaskRuntimeAdapters.

export { taskEvents, agentSessionsEvents } from './events'
export type { TaskEventMap, AgentSessionsEventMap } from './events'
export {
  agentSessionsRouter,
  type AgentSessionsRouter,
  type AgentSessionsMounts
} from './agent-sessions-router'
// `task.*` tRPC router + the host-injected deps it calls. Composed by `@slayzone/api`;
// the deps are injected by the composition roots (hub, Electron main).
export { taskRouter } from './task-router'
export { taskMovesRouter } from './task-moves-router'
export { anyTaskMoveLocking, lockedTaskIds } from './ops/task-moves'
export { setTaskDeps, getTaskOps } from './task-router-deps'
// `task.startMainAgent`'s repo-discovery seam (api wires worktrees' `detectChildRepos`).
export {
  setMainAgentDeps,
  resolveMainAgentLaunch,
  resolveChatAgentLaunch,
  startMainAgent,
  switchMainAgentMode,
  type SwitchMainAgentModeInput,
  type MainAgentLaunch,
  type MainAgentDeps,
  type StartMainAgentInput,
  type StartMainAgentResult
} from './main-agent'
// The hub's boot restore of the chat agents that ran at shutdown.
export {
  restoreRunningChatAgents,
  type AgentRestorePassOptions,
  type AgentRestorePassResult
} from './agent-restore'
export type { TaskRouter, TaskMounts } from './router-mounts'

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
export { templateRouter, type TemplateRouter, type TemplateMounts } from './template-router'

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
export type { ArtifactDownloadHost, ArtifactDownloadSource } from './artifact-downloads'

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
  moveTasksToProjectOp,
  setTaskSessionLedger,
  taskSessionLedger,
  SessionsOfflineError,
  listTaskSessions,
  setTaskSessionPromptReader,
  legacyCodexChatPromptSummaries,
  isHonoredConversation,
  deleteSession,
  relinquishSession,
  resetConversation,
  switchConversation
} from './ops'
export type {
  CreateImportedTaskInput,
  LedgerSessionRow,
  SessionLedgerClient,
  TaskSessionSummary
} from './ops'
export {
  configureTaskRuntimeAdapters,
  getRuntimeAdapters,
  updateTask,
  setChatSettingsDelegate,
  type ChatSettingsDelegate,
  setTaskPathsDelegate,
  getTaskPathsDelegate,
  notifyTaskPaths,
  readTaskPaths,
  type TaskPathsDelegate,
  type TaskPathChange,
  type TaskPathPatch,
  type TaskPathRelease,
  InvalidTaskUpdateError,
  TaskFoldersUnavailableError,
  ProjectNotFoundError
} from './ops/shared'
// The in-process implementations (`defaultWorktreeExecAdapters`,
// `defaultWorktreePolicyAdapters`) live in `worktrees/server`.
export type {
  WorktreeComputerState,
  WorktreeExecAdapters,
  WorktreePolicyAdapters
} from './ops/shared'
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
// the healer/resolver seams `createPty` calls are never left null. Both only
// forward to the agent's computer (its session ledger decides, robustness plan §9).
export { registerConversationHealer, registerConversationResolver } from './conversation-healer'
