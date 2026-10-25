import type { Task } from '@slayzone/task/shared'
import { getProviderFlags } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ExecutionContext, TerminalMode, TerminalModeInfo } from '@slayzone/terminal/shared'

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

/**
 * The main terminal's cwd when it needs nothing async to resolve: no worktree, no
 * base dir, no child repo bound to the task or the project — the project root.
 * Null otherwise (the task page resolves those from detected repos).
 */
export function plainMainTerminalCwd(
  task: Pick<Task, 'worktree_path' | 'base_dir' | 'repo_name'>,
  project: Pick<Project, 'path' | 'selected_repo'> | null | undefined
): string | null {
  if (!project?.path) return null
  if (task.worktree_path || task.base_dir || task.repo_name || project.selected_repo) return null
  return project.path
}
