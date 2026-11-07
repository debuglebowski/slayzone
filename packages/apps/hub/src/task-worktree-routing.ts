/**
 * Where a task's worktree work goes — the hub's wiring of the task runtime seams that
 * pick a computer for it: the project folder a worktree is made next to, the routing
 * worktree adapters, and the Trash purge's {@link createWorktreeComputerState}. One
 * module, so the composition root and its tests wire the same thing.
 *
 * Two computers, on purpose:
 *   - the TASK's computer (placement's `forTask`: its binding, else the connected
 *     default) — where new work runs, a new worktree included;
 *   - the computer that HOLDS its worktree — `tasks.worktree_computer_id`, recorded
 *     when the worktree is made, else the task's computer. Removal goes there. For an
 *     unbound task on a hub with several computers the default can change after the
 *     worktree is made (another computer connects); removing on the new default found
 *     no such path, "succeeded", and the worktree stayed behind for good.
 *
 * @module hub/task-worktree-routing
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { recordedProjectRoot } from '@slayzone/computers/server'
import {
  createRemoteWorktreeAdapters,
  type ComputerWorkGate,
  type RoutingGateway
} from '@slayzone/computer-transport/server'
import type { TaskRuntimeAdapters, WorktreeExecAdapters } from '@slayzone/task/server'
import { createWorktreeComputerState, recordedWorktreeComputer } from './worktree-computer-state'

export interface TaskWorktreeRoutingDeps {
  db: SlayzoneDb
  requireLogin: boolean
  /** Computers connected and heard from now (throws before the gateway exists). */
  usable: () => readonly { computerId: string }[]
  /** Placement's computer for a task: its binding, else the connected default. */
  forTask: (taskId: string) => Promise<string | null>
}

export interface TaskWorktreeRouting {
  /** The computer that holds the task's worktree: recorded, else the task's computer. */
  worktreeComputerForTask(taskId: string): Promise<string | null>
  projectRootForTask: TaskRuntimeAdapters['projectRootForTask']
  worktreeRootForTask: TaskRuntimeAdapters['worktreeRootForTask']
  worktreeComputerState: TaskRuntimeAdapters['worktreeComputerState']
  /** The routing worktree adapters, once the gateway exists. */
  remoteWorktrees(opts: {
    gateway: RoutingGateway
    gate: ComputerWorkGate | undefined
    local: WorktreeExecAdapters
  }): WorktreeExecAdapters
}

export function createTaskWorktreeRouting(deps: TaskWorktreeRoutingDeps): TaskWorktreeRouting {
  const { db, forTask } = deps
  const worktreeComputerForTask = async (taskId: string): Promise<string | null> =>
    (await recordedWorktreeComputer(db, taskId)) ?? forTask(taskId)
  /** The project's folder on `computerId` (null: none, or no computer). */
  const rootOn = async (
    resolve: Promise<string | null>,
    projectId: string
  ): Promise<string | null> => {
    const computerId = await resolve.catch(() => null)
    return computerId ? recordedProjectRoot(db, projectId, computerId) : null
  }
  return {
    worktreeComputerForTask,
    // A project's folder is per computer: a task's worktrees go next to the folder
    // on the computer its work runs on. A computer that cannot be resolved (none
    // connected; on a hub with login, none of the caller's) means no folder — never
    // a failed read: REST/board reads go through here too.
    projectRootForTask: (_db, taskId, projectId) => rootOn(forTask(taskId), projectId),
    // A worktree is removed next to the project's folder on the computer holding it.
    worktreeRootForTask: (_db, taskId, projectId) =>
      rootOn(worktreeComputerForTask(taskId), projectId),
    // The Trash purge removes a worktree before its task, so it asks whether the
    // computer holding it can (R5-1).
    worktreeComputerState: createWorktreeComputerState(deps),
    remoteWorktrees: ({ gateway, gate, local }) =>
      createRemoteWorktreeAdapters({
        gateway,
        // Route each task's worktree/git/fs work to the SAME computer its agents
        // spawn on (explicit binding, else the connected default computer).
        resolveComputerId: (taskId) => forTask(taskId),
        // …except removal: on the computer that holds the worktree.
        resolveWorktreeComputerId: worktreeComputerForTask,
        gate,
        local
      })
  }
}
