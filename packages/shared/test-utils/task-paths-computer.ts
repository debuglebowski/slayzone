/**
 * Tests only: the computer holding task folders (robustness plan §9, Phase 7e — the
 * hub keeps only whether a task has a worktree / base dir). A real computer
 * task-paths store in a temp chat database, installed as the hub's task-paths
 * delegate, so every hub write of a task's paths lands here and every read and
 * release is answered from here. `forgotten` lists the purged tasks the hub let go.
 */
// Relative repo paths (as the other helpers here): no package edge, and the very
// module instances the tests under test load.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openChatStorage } from '../../domains/chat-runtime/src/server/storage'
import { createTaskPaths } from '../../domains/chat-runtime/src/server/task-paths'
import {
  getTaskPathsDelegate,
  setTaskPathsDelegate,
  type TaskPathsDelegate
} from '../../domains/task/src/server/ops/shared'

export interface TaskPathsComputer {
  readonly paths: ReturnType<typeof createTaskPaths>
  /** The task's folders as this computer holds them. */
  get(taskId: string): { worktreePath: string | null; baseDir: string | null }
  /** Give a task a worktree here directly (a fixture's raw-SQL task). */
  setWorktree(taskId: string, worktreePath: string | null): void
  /** Purged tasks whose checkout the hub dealt with (`forget`). */
  readonly forgotten: string[]
  /** Restores the delegate that was installed before. */
  uninstall(): void
}

export function installTaskPathsComputer(computerId = 'task-paths-computer'): TaskPathsComputer {
  const storage = openChatStorage({
    stateDir: mkdtempSync(join(tmpdir(), 'slz-task-paths-computer-')),
    hubScope: 'task-paths'
  })
  const paths = createTaskPaths(storage)
  const forgotten: string[] = []
  let at = 0
  const write = (taskId: string, value: Record<string, unknown>) =>
    paths.handle({ op: 'set', taskId, projectId: null, ...value, at: ++at })
  const previous = getTaskPathsDelegate()
  const delegate: TaskPathsDelegate = {
    changed: async (taskId, change) => {
      if (change.op === 'clear') paths.handle({ op: 'clear', taskId, at: ++at })
      else if (change.op === 'inherit')
        paths.handle({
          op: 'inherit',
          taskId,
          parentTaskId: change.parentTaskId,
          projectId: null,
          at: ++at
        })
      else write(taskId, { worktreePath: change.worktreePath, baseDir: change.baseDir })
    },
    apply: async (taskId, patch) => {
      write(taskId, patch)
    },
    read: async (taskIds) =>
      Object.fromEntries(
        taskIds.map((id) => [
          id,
          {
            state: 'ok' as const,
            worktreePath: paths.get(id)?.worktreePath ?? null,
            baseDir: paths.get(id)?.baseDir ?? null
          }
        ])
      ),
    release: async (taskId, liveTaskIds) => ({
      ...(paths.handle({ op: 'release', taskId, liveTaskIds: [...liveTaskIds] }) as {
        worktreePath: string | null
        shared: boolean
      }),
      computerId
    }),
    forget: async (taskId) => {
      forgotten.push(taskId)
      paths.handle({ op: 'forget', taskId })
    }
  }
  setTaskPathsDelegate(delegate)
  return {
    paths,
    get: (taskId) => ({
      worktreePath: paths.get(taskId)?.worktreePath ?? null,
      baseDir: paths.get(taskId)?.baseDir ?? null
    }),
    setWorktree: (taskId, worktreePath) => {
      write(taskId, { worktreePath })
    },
    forgotten,
    uninstall: () => setTaskPathsDelegate(previous)
  }
}
