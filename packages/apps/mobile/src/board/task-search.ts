/**
 * Task search across every signed-in hub, as plain data. Hubs have no task search of
 * their own (desktop's search dialog searches the tasks its board already loaded), so
 * this searches the boards the app holds: titles, like desktop, and descriptions. Every
 * word must appear in plain-text mode; title hits rank above description hits — an exact title
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

export interface TaskSearchOptions {
  caseSensitive?: boolean
  regex?: boolean
}

export function searchTasks(
  feeds: readonly HubFeed[],
  query: string,
  options: TaskSearchOptions = {}
): TaskSearchResult[] {
  const normalize = (text: string) => (options.caseSensitive ? text : text.toLowerCase())
  const q = options.regex ? query.trim() : normalize(query.trim())
  if (!q) return []
  const words = q.split(/\s+/)
  let pattern: RegExp | undefined
  if (options.regex) {
    try {
      pattern = new RegExp(q, options.caseSensitive ? '' : 'i')
    } catch {
      return []
    }
  }
  const ranked: { rank: number; result: TaskSearchResult }[] = []
  for (const feed of feeds) {
    const data = feed.board.data
    if (!data) continue
    const projects = new Map(data.projects.flatMap((p) => (p ? [[p.id, p] as const] : [])))
    for (const task of data.tasks) {
      if (task.is_temporary) continue
      const rawDescription = task.description ?? ''
      const description = pattern ? rawDescription : rawDescription.replace(/\s+/g, ' ').trim()
      let rank: number
      let descriptionHit = 0
      if (pattern) {
        const titleMatch = pattern.exec(task.title)
        if (titleMatch) {
          rank = titleMatch.index > 0 ? 2 : titleMatch[0].length === task.title.length ? 0 : 1
        } else {
          const match = pattern.exec(description)
          if (!match) continue
          rank = 4
          descriptionHit = match.index
        }
      } else {
        const title = normalize(task.title)
        const body = normalize(description)
        const both = `${title} ${body}`
        if (!words.every((word) => both.includes(word))) continue
        if (title === q) rank = 0
        else if (title.startsWith(q)) rank = 1
        else if (title.includes(q)) rank = 2
        else if (words.every((word) => title.includes(word))) rank = 3
        else {
          rank = 4
          const hits = words.map((word) => body.indexOf(word)).filter((at) => at >= 0)
          descriptionHit = hits.length > 0 ? Math.min(...hits) : 0
        }
      }
      ranked.push({
        rank,
        result: {
          key: rowKey(feed.hub.id, task.id),
          hubId: feed.hub.id,
          hubLabel: feed.hub.label,
          task,
          project: projects.get(task.project_id),
          matchedIn: rank < 4 ? 'title' : 'description',
          excerpt: rank < 4 ? null : excerptOf(description, descriptionHit)
        }
      })
    }
  }
  // A stable sort: within a rank, the order they were found in.
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, TASK_SEARCH_LIMIT)
    .map((r) => r.result)
}

function excerptOf(description: string, first: number): string {
  const start = Math.max(0, first - EXCERPT_BEFORE)
  const end = Math.min(description.length, start + EXCERPT_LENGTH)
  const text = description.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${text}${end < description.length ? '…' : ''}`
}
