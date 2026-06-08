import {
  getAllTasksOp,
  getByProjectOp,
  getTaskOp,
  createTaskOp,
  getSubTasksOp,
  updateTaskOp,
  updateManyTasksOp,
  deleteTaskOp,
  deleteManyTasksOp,
  restoreTaskOp,
  archiveTaskOp,
  archiveManyTasksOp,
  unarchiveTaskOp,
  reorderTasksOp,
  reorderPinnedTasksOp,
  setBrowserTabLockedOp,
  getBlockersOp,
  getAllBlockedTaskIdsOp,
  getBlockingOp,
  addBlockerOp,
  removeBlockerOp,
  setBlockersOp,
  loadBoardDataOp
} from './ops/index.js'

// The task CRUD/deps/board ops are electron-coupled (createTaskOp pulls
// @slayzone/worktrees/main → handlers → electron). The transport `task` router can't
// import them directly without breaking its zero-electron / standalone-server invariant,
// so the Electron-main host injects this bundle via `setTaskDeps()`. transport sees only
// the `TaskOps` *type* (erased at build). Mirrors chat/integrations injection.
export const taskOps = {
  getAllTasksOp,
  getByProjectOp,
  getTaskOp,
  createTaskOp,
  getSubTasksOp,
  updateTaskOp,
  updateManyTasksOp,
  deleteTaskOp,
  deleteManyTasksOp,
  restoreTaskOp,
  archiveTaskOp,
  archiveManyTasksOp,
  unarchiveTaskOp,
  reorderTasksOp,
  reorderPinnedTasksOp,
  setBrowserTabLockedOp,
  getBlockersOp,
  getAllBlockedTaskIdsOp,
  getBlockingOp,
  addBlockerOp,
  removeBlockerOp,
  setBlockersOp,
  loadBoardDataOp
}

export type TaskOps = typeof taskOps
