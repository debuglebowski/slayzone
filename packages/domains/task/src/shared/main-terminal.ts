/**
 * How a task's MAIN agent is started: its spawn props and its working directory.
 *
 * DOM-free and shared by every place that starts it — the desktop task page (and its
 * terminal-first pane), the hub's `task.startMainAgent`, and the mobile chat (which
 * must hydrate a chat tab in the exact folder desktop would) — so no two of them can
 * start the same session two different ways. Pure: the caller supplies the
 * rows and the child repos detected on the machine that owns the project.
 */
import type { Task, TaskPathState } from '@slayzone/task-contracts'
// DOM-free subpaths, not the barrels: the mobile app imports this module too
// (`@slayzone/task/main-terminal`), and projects-contracts' barrel loads a desktop
// UI module at runtime.
import { getProviderFlags } from '@slayzone/task-contracts/types'
import type { DetectedRepo, Project } from '@slayzone/projects-contracts'
import { taskProjectRoot } from '@slayzone/projects-contracts/placements'
import { resolveRepoPath } from '@slayzone/projects-contracts/resolve-repo'
import type { ExecutionContext, AgentId, AgentDefinition } from '@slayzone/terminal-contracts'

/** What the task's MAIN terminal spawns with, apart from its cwd. */
export interface MainTerminalProps {
  mode: AgentId
  supportsSessionId: boolean
  providerFlags: string
  executionContext: ExecutionContext | null | undefined
}

/**
 * The main terminal's spawn props. ONE derivation for every place that mounts the
 * task's main terminal (the task page, and the terminal-first pane shown while the
 * page loads), so they can never spawn the same session two different ways.
 *
 * No conversation id: which conversation the main tab resumes is decided at spawn
 * by the session ledger on the agent's computer (robustness plan §9, P0) — the
 * hub and the renderer hold no copy to hint with.
 */
export function mainTerminalProps(
  task: Task,
  project: Pick<Project, 'execution_context'> | null | undefined,
  modes: readonly Pick<AgentDefinition, 'id' | 'initialCommand'>[]
): MainTerminalProps {
  return {
    mode: task.agent_id,
    supportsSessionId:
      modes.find((m) => m.id === task.agent_id)?.initialCommand?.includes('{id}') ?? false,
    providerFlags: getProviderFlags(task.provider_config, task.agent_id),
    executionContext: project?.execution_context
  }
}

type RepoTask = Pick<Task, 'has_worktree' | 'has_base_dir' | 'repo_name'>
type RepoProject = Pick<Project, 'selected_repo'>

/**
 * The task's own folder — its worktree, else its custom working folder — as its
 * computer answered (`task.paths`; robustness plan §9, P0: the hub keeps no copy).
 * Null while that answer is not in (loading, computer away) or the task has neither.
 */
export function taskOwnFolderOf(paths: TaskPathState | null | undefined): string | null {
  if (!paths || paths.state !== 'ok') return null
  return paths.worktreePath ?? paths.baseDir ?? null
}

/** Whether the task's work is bound to a folder of its own (a worktree or a custom folder). */
export function hasOwnFolder(
  task: Pick<Task, 'has_worktree' | 'has_base_dir'> | null | undefined
): boolean {
  return !!task && (task.has_worktree || task.has_base_dir)
}

/**
 * The child repo a task is bound to: its own pick, else the project default. No
 * fallback to the first detected repo — a wrapper folder stays the wrapper folder,
 * so the terminal and editor never silently jump into an arbitrary child repo.
 */
export function taskRepoName(
  task: RepoTask | null | undefined,
  project: RepoProject | null | undefined
): string | null {
  return task?.repo_name ?? project?.selected_repo ?? null
}

/**
 * The directory a task's work is bound to (terminal, editor, browser, worktree
 * creation): its worktree, else its base dir, else the project's resolved repo
 * (`resolveRepoPath` over the detected child repos). A task with a folder of its own
 * whose `paths` are not in yet gets null — never the project folder in its place.
 */
export function taskRepoPath(
  task: RepoTask | null | undefined,
  resolvedRepoPath: string | null,
  paths: TaskPathState | null | undefined
): string | null {
  return hasOwnFolder(task) ? taskOwnFolderOf(paths) : resolvedRepoPath
}

/**
 * The main terminal's cwd from the task-bound directory: it, else the project's
 * folder on the task's computer (`taskProjectRoot`).
 */
export function mainTerminalCwdFrom(
  repoPath: string | null | undefined,
  projectRoot: string | null | undefined
): string | null {
  return repoPath || projectRoot || null
}

/**
 * The main terminal's cwd. `projectRoot` is the project's folder on the task's
 * computer (a project has one folder per computer). `detectedRepos` are the
 * project's child repos, discovered on that computer; they only matter when a child
 * repo is bound (`taskRepoName`) and the task has no worktree or base dir. `paths`:
 * the task's own folders from its computer. Null = nowhere to run (yet): a task with
 * its own folder never falls back to the project folder while `paths` are not in.
 */
export function mainTerminalCwd(
  task: RepoTask | null | undefined,
  project: RepoProject | null | undefined,
  projectRoot: string | null,
  detectedRepos: readonly DetectedRepo[],
  paths: TaskPathState | null | undefined
): string | null {
  if (hasOwnFolder(task)) return taskOwnFolderOf(paths)
  const resolved = resolveRepoPath(projectRoot, [...detectedRepos], taskRepoName(task, project))
  return mainTerminalCwdFrom(resolved.path, projectRoot)
}

/**
 * Whether `mainTerminalCwd` needs the detected child repos: only when a child repo is
 * bound and no worktree or base dir overrides it. Lets a caller skip a discovery
 * round-trip to the project's machine.
 */
export function mainTerminalCwdNeedsRepos(
  task: RepoTask | null | undefined,
  project: RepoProject | null | undefined,
  projectRoot: string | null
): boolean {
  return !hasOwnFolder(task) && !!projectRoot && taskRepoName(task, project) !== null
}

/**
 * The main terminal's cwd when it needs nothing async to resolve: no worktree, no
 * base dir, no child repo bound to the task or the project — the project root.
 * Null otherwise (the task page resolves those from detected repos / the computer).
 */
export function plainMainTerminalCwd(
  task: Pick<Task, 'has_worktree' | 'has_base_dir' | 'repo_name' | 'computer_id'>,
  project: Pick<Project, 'placements' | 'resolved_computer_id' | 'selected_repo'> | null | undefined
): string | null {
  const root = taskProjectRoot(task, project)
  if (!root) return null
  if (hasOwnFolder(task) || task.repo_name || project?.selected_repo) return null
  return root
}
