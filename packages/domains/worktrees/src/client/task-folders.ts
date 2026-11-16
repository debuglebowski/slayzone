/**
 * A task's checkout folders in the git panel (§9 Phase 7d): read from the computer
 * holding them (`useTaskPath`), never from the hub. While a task's own folder is not
 * known (loading, computer away) these answer null — callers wait; they never fall
 * back to the project folder, which would act on the wrong checkout.
 */
import type { Task } from '@slayzone/task-contracts'
import { useTaskPath } from '@slayzone/task/client/useTaskPath'

export interface TaskFolders {
  worktreePath: string | null
  baseDir: string | null
  /** The computer answered (or the task has no folder of its own). */
  known: boolean
}

export function useTaskFolders(task: Task | null | undefined): TaskFolders {
  const view = useTaskPath(task)
  if (view.state === 'ok')
    return { worktreePath: view.worktreePath, baseDir: view.baseDir, known: true }
  return { worktreePath: null, baseDir: null, known: false }
}

/** The worktree when the task has one, else the project folder. Null: not known yet. */
export function worktreeOrProject(
  task: Pick<Task, 'has_worktree'> | null | undefined,
  folders: TaskFolders,
  projectPath: string | null
): string | null {
  return task?.has_worktree ? folders.worktreePath : projectPath
}

/** Its worktree, else its custom folder, else the project folder. Null: not known yet. */
export function taskCheckoutPath(
  task: Pick<Task, 'has_worktree' | 'has_base_dir'>,
  folders: TaskFolders,
  projectPath: string | null
): string | null {
  if (task.has_worktree || task.has_base_dir) return folders.worktreePath ?? folders.baseDir
  return projectPath
}
