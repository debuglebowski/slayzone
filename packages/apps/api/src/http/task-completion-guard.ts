import type { TaskAgentsAccess } from './rest-api/types'

/**
 * Agent-facing completion guard (CLI REST routes + MCP `update_task`).
 * Completing a task stops every agent of it — PTYs and chats, even mid-turn — so
 * these surfaces refuse to complete a task while any of its agents is mid-reply,
 * the caller's own agent included, unless forced. The desktop (tRPC
 * `task.update`, ⌘⇧D) is not guarded: a user completing a task there means to
 * stop it.
 *
 * Returns the refusal message, or null when completion may proceed. Absent
 * `taskAgents` = this host runs no agents, so none can be mid-reply.
 */
export async function completionRefusal(
  taskAgents: TaskAgentsAccess | undefined,
  taskId: string,
  opts: { force: boolean; forceHint: string }
): Promise<string | null> {
  if (opts.force || !taskAgents) return null
  const busy = await taskAgents.midReplySessionIds(taskId)
  if (busy.length === 0) return null
  return (
    `Task ${taskId.slice(0, 8)} has ${busy.length === 1 ? 'an agent' : `${busy.length} agents`} ` +
    `mid-reply; completing it stops every agent. ${opts.forceHint}`
  )
}
