import type { SlayzoneDb } from '@slayzone/platform'
import { inPathScopeOf } from '@slayzone/platform/path-scope'
import { computerForTurnTask, listTurnsOnComputer } from './turn-git-routing'
import type { AgentTurnRange } from '../shared/types'

/**
 * All agent-turns of a task's checkout, filtered + rethreaded for display (the
 * filter's rules: `filterAndRethread` in ./turn-git). The turns and their git live on
 * the computer that holds the checkout (robustness plan §9, P0); the hub adds only
 * the task titles it owns. The list names only the task (its PATH SCOPE): its
 * computer resolves the checkout — its worktree, else its project's folder there
 * (§9 Phase 7d: neither the client nor the hub names a path).
 */
export async function listAgentTurnsForTask(
  db: SlayzoneDb,
  taskId: string
): Promise<AgentTurnRange[]> {
  // No computer: refused ("connect a computer") — the hub holds no turn itself.
  const computerId = await computerForTurnTask(taskId)
  const task = await db.get<{ project_id: string | null }>(
    'SELECT project_id FROM tasks WHERE id = ?',
    [taskId]
  )
  const input = { taskId, projectId: task?.project_id ?? null }
  if (computerId != null && !task) return []
  const { rows } =
    computerId == null
      ? await listTurnsOnComputer(null, input) // refused: "connect a computer"
      : await inPathScopeOf(db, { taskId }, 'agentTurns.list', () =>
          listTurnsOnComputer(computerId, input)
        )
  const taskIds = [...new Set(rows.flatMap((r) => (r.task_id ? [r.task_id] : [])))]
  const titles = new Map(
    taskIds.length
      ? (
          (await db
            .prepare(`SELECT id, title FROM tasks WHERE id IN (SELECT value FROM json_each(?))`)
            .all(JSON.stringify(taskIds))) as Array<{ id: string; title: string }>
        ).map((t) => [t.id, t.title])
      : []
  )
  return rows.map((r) => ({ ...r, task_title: r.task_id ? (titles.get(r.task_id) ?? null) : null }))
}
