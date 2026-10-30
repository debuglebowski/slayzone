/**
 * Task search across every signed-in hub, as plain data. Hubs have no task search of
 * their own (desktop's search dialog searches the tasks its board already loaded), so
 * this searches the boards the app holds: titles, like desktop, and descriptions. Every
 * word must appear (any case); title hits rank above description hits — an exact title
 * first, then a title that starts with the query, then one that contains it, then one
 * holding all the words — and within a rank hubs keep sign-in order and each hub its
 * board order. Ephemeral tasks (desktop's temporary terminal tabs) are never shown.
 */
import { type HubFeed, rowKey, type TaskRow } from '../hub-board'

export interface TaskSearchResult extends TaskRow {
  matchedIn: 'title' | 'description'
  /** The description around the first word found (description hits). */
  excerpt: string | null
}

export const TASK_SEARCH_LIMIT = 50
const EXCERPT_BEFORE = 30
const EXCERPT_LENGTH = 120

export function searchTasks(
  feeds: readonly HubFeed[],
  query: string,
  limit = TASK_SEARCH_LIMIT
): TaskSearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  const ranked: { rank: number; result: TaskSearchResult }[] = []
  for (const feed of feeds) {
    const data = feed.board.data
    if (!data) continue
    const projects = new Map(data.projects.flatMap((p) => (p ? [[p.id, p] as const] : [])))
    for (const task of data.tasks) {
      if (task.is_temporary) continue
      const title = task.title.toLowerCase()
      const description = (task.description ?? '').replace(/\s+/g, ' ').trim()
      const both = `${title} ${description.toLowerCase()}`
      if (!words.every((w) => both.includes(w))) continue
      let rank: number
      if (title === q) rank = 0
      else if (title.startsWith(q)) rank = 1
      else if (title.includes(q)) rank = 2
      else if (words.every((w) => title.includes(w))) rank = 3
      else rank = 4
      ranked.push({
        rank,
        result: {
          key: rowKey(feed.hub.id, task.id),
          hubId: feed.hub.id,
          hubLabel: feed.hub.label,
          task,
          project: projects.get(task.project_id),
          matchedIn: rank < 4 ? 'title' : 'description',
          excerpt: rank < 4 ? null : excerptOf(description, words)
        }
      })
    }
  }
  // A stable sort: within a rank, the order they were found in.
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.result)
}

function excerptOf(description: string, words: readonly string[]): string {
  const lower = description.toLowerCase()
  const hits = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)
  const first = hits.length ? Math.min(...hits) : 0
  const start = Math.max(0, first - EXCERPT_BEFORE)
  const end = Math.min(description.length, start + EXCERPT_LENGTH)
  return `${start > 0 ? '…' : ''}${description.slice(start, end)}${end < description.length ? '…' : ''}`
}
