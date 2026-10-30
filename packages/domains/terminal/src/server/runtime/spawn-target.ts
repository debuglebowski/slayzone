import { GLOBAL_AGENT_PANEL_SESSION_OWNER } from '@slayzone/terminal-contracts'
import type { PtySpawnLookups } from './pty-data-ops'

/** Where an agent session runs: its task (if any), project, computer and folder. */
export interface SpawnTarget {
  taskId: string | null
  projectId: string | null
  computerId: string | null
  /** The folder it starts in; empty = none known, the computer decides. */
  cwd: string
}

/**
 * Decide on the hub which computer a session starts on and in which folder.
 *
 * The folder is decided HERE, not left to the computer, because the hub needs it
 * before the spawn: the conversation healer, session detection and warm-agent
 * matching all look for the session by its folder. An explicit `cwd` (a worktree,
 * a task's base dir, a child repo) always wins. Otherwise it is the project's
 * folder on the resolved computer, as the hub knows it. When the hub knows none,
 * no folder is sent and the computer uses its own record or refuses with
 * `project_not_placed` — never a guess.
 *
 * Session ids are `<taskId>:<…>`, except the project-wide agent panel's
 * `__global-agent-panel:<projectId>:<n>`, which has no task.
 */
export async function resolveSpawnTarget(
  sessionId: string,
  cwd: string | undefined,
  lookups: PtySpawnLookups
): Promise<SpawnTarget> {
  const [owner, second] = sessionId.split(':')
  let taskId: string | null = null
  let projectId: string | null = null
  let computerId: string | null = null
  if (owner === GLOBAL_AGENT_PANEL_SESSION_OWNER) {
    projectId = second || null
    computerId = projectId ? await lookups.resolveProjectComputerId(projectId) : null
  } else if (owner) {
    taskId = owner
    computerId = await lookups.resolveComputerId(owner)
    projectId = await lookups.getTaskProjectId(owner)
  }
  const folder = await resolveAgentFolder(cwd, projectId, computerId, lookups.getProjectRoot)
  return { taskId, projectId, computerId, cwd: folder }
}

/**
 * The folder an agent starts in: the explicit one, else the project's folder on
 * that computer as the hub knows it, else '' (none known — the computer decides).
 * Shared by terminal and chat agents so both start in the same place.
 */
export async function resolveAgentFolder(
  cwd: string | undefined,
  projectId: string | null,
  computerId: string | null,
  getProjectRoot: (projectId: string, computerId: string) => Promise<string | null>
): Promise<string> {
  if (cwd) return cwd
  if (!projectId || !computerId) return ''
  return (await getProjectRoot(projectId, computerId)) ?? ''
}
