export {
  configureTaskRuntimeAdapters,
  getRuntimeAdapters,
  cleanupTaskFull,
  cleanupTaskImmediate,
  updateTask,
  parseTask,
  parseTasks,
  parseAndColorTask,
  parseAndColorTasks,
  attachWorktreeColors,
  colorOne,
  getProjectColumns,
  getEnabledModeDefaults,
  getModeDefaultFlags,
  maybeAutoCreateWorktree,
  safeJsonParse
} from './shared.js'
export type {
  OpDeps,
  TaskRuntimeAdapters,
  DiagnosticEventPayload,
  DiagnosticLevel,
  TerminalModeFlagsRow
} from './shared.js'

export { getAllTasksOp } from './get-all.js'
export { getByProjectOp } from './get-by-project.js'
export { getTaskOp } from './get.js'
export { createTaskOp } from './create.js'
export { createImportedTaskOp, type CreateImportedTaskInput } from './create-imported.js'
export { getSubTasksOp } from './get-subtasks.js'
export { updateTaskOp } from './update.js'
export { deleteTaskOp, type DeleteTaskResult } from './delete.js'
export { restoreTaskOp } from './restore.js'
export { archiveTaskOp } from './archive.js'
export { archiveManyTasksOp } from './archive-many.js'
export { updateManyTasksOp, type UpdateManyTasksInput } from './update-many.js'
export { deleteManyTasksOp, type DeleteManyTasksResult } from './delete-many.js'
export { unarchiveTaskOp } from './unarchive.js'
export { reorderTasksOp, reorderPinnedTasksOp } from './reorder.js'
export { setBrowserTabLockedOp } from './set-browser-tab-locked.js'
export { getBlockersOp } from './deps-get-blockers.js'
export { getAllBlockedTaskIdsOp } from './deps-get-all-blocked-ids.js'
export { getBlockingOp } from './deps-get-blocking.js'
export { addBlockerOp } from './deps-add-blocker.js'
export { removeBlockerOp } from './deps-remove-blocker.js'
export { setBlockersOp } from './deps-set-blockers.js'
export { loadBoardDataOp, type BoardData } from './load-board-data.js'
export {
  collectReferencedConversationIds,
  casRepointConversationId
} from './conversation-id-heal.js'
// Writes still go through the v145 ledger writer (which triple-writes into the
// v147 agent-session tables during the transition slice).
export {
  recordConversation,
  recordPendingSpawn,
  prunePendingSpawns
} from './task-conversations.js'
// Reads cut over to the first-class agent-session tables (slice 2 — see
// plans/agent-sessions.md). Same fn names + semantics, new source of truth
// (`agent_sessions` + `session_resets`). task_conversations is still written
// for rollback safety until the "drop legacy" slice.
export {
  getCurrentConversationId,
  listConversationHistory,
  listTaskSessions,
  findPendingSpawn
} from './agent-sessions.js'
export type { TaskSessionSummary } from './agent-sessions.js'
// Entity-model B write lifecycle (one row per spawn). Wired into the spawn path
// in the runtime-key-decouple slice; exported now for that wiring + tests.
export {
  recordSessionSpawn,
  confirmSessionConversation,
  confirmSessionConversationByTaskMode,
  markSessionDead,
  bindSessionToTask,
  getBoundTaskId
} from './agent-sessions.js'
