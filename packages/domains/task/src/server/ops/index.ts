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
  safeJsonParse,
} from './shared.js'
export type { OpDeps, TaskRuntimeAdapters, DiagnosticEventPayload, DiagnosticLevel, TerminalModeFlagsRow } from './shared.js'

export { getAllTasksOp } from './get-all.js'
export { getByProjectOp } from './get-by-project.js'
export { getTaskOp } from './get.js'
export { createTaskOp } from './create.js'
export { createImportedTaskOp, type CreateImportedTaskInput } from './create-imported.js'
export { getSubTasksOp } from './get-subtasks.js'
export { getSubTasksRecursiveOp } from './get-subtasks-recursive.js'
export { updateTaskOp } from './update.js'
export { deleteTaskOp, type DeleteTaskResult } from './delete.js'
export { restoreTaskOp } from './restore.js'
export { archiveTaskOp } from './archive.js'
export { archiveManyTasksOp } from './archive-many.js'
export { updateManyTasksOp, type UpdateManyTasksInput } from './update-many.js'
export { deleteManyTasksOp, type DeleteManyTasksResult } from './delete-many.js'
export { unarchiveTaskOp } from './unarchive.js'
export { reorderTasksOp } from './reorder.js'
export { getBlockersOp } from './deps-get-blockers.js'
export { getAllBlockedTaskIdsOp } from './deps-get-all-blocked-ids.js'
export { getBlockingOp } from './deps-get-blocking.js'
export { addBlockerOp } from './deps-add-blocker.js'
export { removeBlockerOp } from './deps-remove-blocker.js'
export { setBlockersOp } from './deps-set-blockers.js'
export { loadBoardDataOp, type BoardData } from './load-board-data.js'
