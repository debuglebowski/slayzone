// The `task` router's host-injected deps. Lives with the router (one copy); the
// composition roots (hub `composition.ts`, Electron main) call `setTaskDeps`.
import type { OpDeps } from './ops/shared'
import type { TaskOps } from './task-ops-bundle'

// Task CRUD/deps/board ops — electron-coupled (`createTaskOp` pulls
// `@slayzone/worktrees/main` → electron). `import type` only here (erased at build →
// zero electron at runtime); the Electron-main host injects the concrete bundle via
// `setTaskDeps()` so the `task` router and the still-live IPC handlers share one
// implementation (coexistence until slice 5). The artifacts/template stores are
// electron-free and imported directly by their routers — not injected.
let taskOps: TaskOps | null = null
// Host-injected post-mutation callback (`notifyTasksChanged`) — the same renderer
// refresh signal the legacy IPC handlers fire. Threaded into the task router's
// OpDeps so tRPC mutations broadcast `notify.onTasksChanged` like the IPC path.
let taskOnMutation: OpDeps['onMutation']
// The warm pool's `reserveWarmTaskId`, wired only where the pool runs (the hub). The
// task router hands it to `createTaskOp` so a task created to be opened at once can
// take a warm agent's id. Unset (the Electron host): no task ever does.
type ReserveWarmTaskId = NonNullable<OpDeps['reserveWarmTaskId']>
let taskReserveWarmTaskId: ReserveWarmTaskId | undefined
// The completion bus the task ops emit `db:tasks:*:done` on — the hub's `taskBus`,
// the same one REST and MCP hand them. Its listeners (integration push to
// Linear/GitHub) must see the renderer's mutations too. Unset: the ops emit nothing.
type TaskBus = NonNullable<OpDeps['ipcMain']>
let taskBus: TaskBus | undefined

export function setTaskDeps(deps: {
  ops: TaskOps
  onMutation?: OpDeps['onMutation']
  reserveWarmTaskId?: ReserveWarmTaskId
  bus?: TaskBus
}): void {
  taskOps = deps.ops
  taskOnMutation = deps.onMutation
  taskReserveWarmTaskId = deps.reserveWarmTaskId
  taskBus = deps.bus
}

export function getTaskOps(): TaskOps {
  if (!taskOps) throw new Error('taskOps not initialized — call setTaskDeps() in main host first')
  return taskOps
}

export function getTaskOnMutation(): OpDeps['onMutation'] {
  return taskOnMutation
}

export function getTaskReserveWarmTaskId(): ReserveWarmTaskId | undefined {
  return taskReserveWarmTaskId
}

export function getTaskBus(): TaskBus | undefined {
  return taskBus
}
