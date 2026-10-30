/**
 * The folder a chat tab runs in, which the phone must name exactly: the hub keys a
 * chat tab by (task, folder, mode), and a hydrate with another folder tears the tab's
 * running agent down and starts it over (`hydrateSession` on the hub).
 *
 * 1. The tab has a session on the hub (`chat.getInfo`): its folder. The phone attaches
 *    to what runs; it never moves a session.
 * 2. Otherwise: the folder desktop would start it in — every tab of a task runs in the
 *    task's main-terminal folder, resolved by the shared `mainTerminalCwd` (the same
 *    function desktop's task page and the hub's `task.startMainAgent` use), from the
 *    project's folder on the computer the task's work runs on (`taskProjectRoot`: a
 *    project has one folder per computer; an older hub sends its single folder).
 */
import {
  placementOn,
  type ProjectPlacement,
  taskProjectRoot,
  workComputerId
} from '@slayzone/projects-contracts/placements'
import { mainTerminalCwd, mainTerminalCwdNeedsRepos } from '@slayzone/task/main-terminal'

/** A child repo `worktrees.detectChildRepos` found (projects-contracts' `DetectedRepo`). */
type DetectedRepo = { name: string; path: string }
type CwdTask = {
  worktree_path: string | null
  base_dir: string | null
  repo_name: string | null
  computer_id?: string | null
}
/**
 * A project as `projects.list` returns it: its folder on each computer and the computer
 * the hub uses for it. An older hub sends neither, only its one `path`
 * (`placementOn` reads that).
 */
type CwdProject = {
  selected_repo: string | null
  placements?: ProjectPlacement[]
  resolved_computer_id?: string | null
  path?: string | null
}

/** The tab's session folder; null when it has no session, or one of another task. */
export function chatCwdFromSession(
  info: { taskId: string; cwd: string } | null | undefined,
  taskId: string
): string | null {
  return info && info.taskId === taskId ? info.cwd : null
}

/**
 * The folder chosen for the task's project on the computer its work runs on, in any
 * state: with no folder to run in, a chosen one that is gone (`missing`) is "not
 * found", not "no folder" — desktop's task page rule.
 */
export function chosenFolder(task: CwdTask, project: CwdProject | null | undefined): string | null {
  // Same shape the shared helpers read (`placementOn` reads an older hub's `path`).
  const p = project as Parameters<typeof taskProjectRoot>[1]
  return placementOn(p, workComputerId(task, p))?.path ?? null
}

/**
 * The folder desktop starts the task's tabs in. `detectedRepos` null = not asked
 * yet: answers `needsRepos` (the project's folder on the task's computer, to scan)
 * when a bound child repo decides it, else the folder. `cwd: null` = the task has no
 * folder to run in (no folder on its computer, no base dir).
 */
export function chatCwdFromTask(
  task: CwdTask,
  project: CwdProject | null | undefined,
  detectedRepos: readonly DetectedRepo[] | null
): { cwd: string | null } | { needsRepos: string } {
  // `placementOn` reads an older hub's `path` when `placements` is absent.
  const root = taskProjectRoot(task, project as Parameters<typeof taskProjectRoot>[1])
  if (detectedRepos === null && root && mainTerminalCwdNeedsRepos(task, project, root)) {
    return { needsRepos: root }
  }
  return { cwd: mainTerminalCwd(task, project, root, detectedRepos ?? []) }
}
