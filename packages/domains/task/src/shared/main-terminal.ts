/**
 * How a task's MAIN agent is started: its spawn props and its working directory.
 *
 * DOM-free and shared by every place that starts it — the desktop task page (and its
 * terminal-first pane) and the hub's `task.startMainAgent` — so a client and the hub
 * can never start the same session two different ways. Pure: the caller supplies the
 * rows and the child repos detected on the machine that owns the project.
 */
import type { Task } from '@slayzone/task-contracts'
import { getProviderFlags } from '@slayzone/task-contracts'
import type { DetectedRepo, Project } from '@slayzone/projects-contracts'
import { resolveRepoPath, taskProjectRoot } from '@slayzone/projects-contracts'
import type { ExecutionContext, TerminalMode, TerminalModeInfo } from '@slayzone/terminal-contracts'

/**
 * Renderer-side conversation id read. Reads the server-computed
 * `currentConversationByMode` field which goes through the append-only
 * `task_conversations` ledger (honors manual-reset cutoff + provenance gate).
 *
 * Direct access to `provider_config.{mode}.conversationId` from the renderer
 * is rejected by the `lint:server-boundary` guard — that path bypasses the
 * provenance check and would re-introduce the clobber bug class.
 */
export function readCurrentConversationId(
  task: Task | null | undefined,
  mode: string | undefined
): string | null {
  if (!task || !mode) return null
  return task.currentConversationByMode?.[mode] ?? null
}

/** What the task's MAIN terminal spawns with, apart from its cwd. */
export interface MainTerminalProps {
  mode: TerminalMode
  conversationId: string | undefined
  existingConversationId: string | undefined
  /** `currentConversationByMode` is set only by parseAndColorTasks; false = the
   *  task is not hydrated yet (boot window) and the auto-spawn must wait. */
  conversationHydrated: boolean
  supportsSessionId: boolean
  providerFlags: string
  executionContext: ExecutionContext | null | undefined
}

/**
 * The main terminal's spawn props. ONE derivation for every place that mounts the
 * task's main terminal (the task page, and the terminal-first pane shown while the
 * page loads), so they can never spawn the same session two different ways.
 */
export function mainTerminalProps(
  task: Task,
  project: Pick<Project, 'execution_context'> | null | undefined,
  modes: readonly Pick<TerminalModeInfo, 'id' | 'initialCommand'>[]
): MainTerminalProps {
  const conversationId = readCurrentConversationId(task, task.terminal_mode) || undefined
  return {
    mode: task.terminal_mode,
    conversationId,
    existingConversationId: conversationId,
    conversationHydrated: task.currentConversationByMode !== undefined,
    supportsSessionId:
      modes.find((m) => m.id === task.terminal_mode)?.initialCommand?.includes('{id}') ?? false,
    providerFlags: getProviderFlags(task.provider_config, task.terminal_mode),
    executionContext: project?.execution_context
  }
}

type RepoTask = Pick<Task, 'worktree_path' | 'base_dir' | 'repo_name'>
type RepoProject = Pick<Project, 'selected_repo'>

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
 * (`resolveRepoPath` over the detected child repos).
 */
export function taskRepoPath(
  task: RepoTask | null | undefined,
  resolvedRepoPath: string | null
): string | null {
  return task?.worktree_path ?? task?.base_dir ?? resolvedRepoPath
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
 * repo is bound (`taskRepoName`) and the task has no worktree or base dir. Null =
 * nowhere to run.
 */
export function mainTerminalCwd(
  task: RepoTask | null | undefined,
  project: RepoProject | null | undefined,
  projectRoot: string | null,
  detectedRepos: readonly DetectedRepo[]
): string | null {
  const resolved = resolveRepoPath(projectRoot, [...detectedRepos], taskRepoName(task, project))
  return mainTerminalCwdFrom(taskRepoPath(task, resolved.path), projectRoot)
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
  return (
    !task?.worktree_path && !task?.base_dir && !!projectRoot && taskRepoName(task, project) !== null
  )
}

/**
 * The main terminal's cwd when it needs nothing async to resolve: no worktree, no
 * base dir, no child repo bound to the task or the project — the project root.
 * Null otherwise (the task page resolves those from detected repos).
 */
export function plainMainTerminalCwd(
  task: Pick<Task, 'worktree_path' | 'base_dir' | 'repo_name' | 'computer_id'>,
  project: Pick<Project, 'placements' | 'resolved_computer_id' | 'selected_repo'> | null | undefined
): string | null {
  const root = taskProjectRoot(task, project)
  if (!root) return null
  if (task.worktree_path || task.base_dir || task.repo_name || project?.selected_repo) return null
  return root
}
