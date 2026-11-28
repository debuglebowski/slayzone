import type { Project } from '@slayzone/projects-contracts'
import type { Task } from '@slayzone/task-contracts'
import type { RankedResult } from './SearchDialog.algorithm'

/** At most this many hub hits are added under the board's own task results. */
export const HUB_TASK_HITS_MAX = 10

/**
 * The palette's task results: the board search's own (fuzzy, over the tasks the app
 * holds) first, then the hub search's hits it missed (`task.search` — a word in the
 * description, an archived task the board may not hold), in the hub's order.
 */
export function appendHubTaskHits(
  boardResults: RankedResult[],
  hubHits: readonly Task[] | undefined,
  projects: readonly Project[]
): RankedResult[] {
  if (!hubHits?.length) return boardResults
  const seen = new Set(boardResults.map((r) => r.item.id))
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const added: RankedResult[] = []
  for (const t of hubHits) {
    if (added.length >= HUB_TASK_HITS_MAX) break
    if (seen.has(t.id)) continue
    seen.add(t.id)
    added.push({
      item: {
        kind: 'task',
        id: t.id,
        label: t.title,
        sublabel: names.get(t.project_id) ?? '',
        status: t.status,
        priority: t.priority
      },
      score: 0,
      positions: new Set(),
      usedPath: false,
      weightedScore: 0
    })
  }
  return added.length ? [...boardResults, ...added] : boardResults
}
