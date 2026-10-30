/**
 * What the board remembers on this device: the project shown (hub + project id: an id
 * alone is ambiguous across hubs), the view, and each project's filters. One JSON file;
 * unreadable or foreign content = nothing kept. The file itself is `board-prefs-file.ts`.
 */
import type { ProjectRef } from '../projects/hub-projects'
import { type BoardFilter, DEFAULT_BOARD_FILTER } from './board-model'

export type BoardView = 'kanban' | 'list' | 'tree'
export const BOARD_VIEWS: readonly BoardView[] = ['kanban', 'list', 'tree']

export interface BoardPrefs {
  project: ProjectRef | null
  view: BoardView
  /** By `rowKey(hubId, projectId)`. */
  filters: Record<string, BoardFilter>
}

export const DEFAULT_BOARD_PREFS: BoardPrefs = { project: null, view: 'kanban', filters: {} }

export interface PrefsStorage {
  read: () => string | null
  write: (text: string) => void
}

export interface BoardPrefsStore {
  load: () => BoardPrefs
  save: (prefs: BoardPrefs) => void
}

export function createBoardPrefs(storage: PrefsStorage): BoardPrefsStore {
  return {
    load: () => {
      try {
        const text = storage.read()
        return text ? parse(JSON.parse(text)) : DEFAULT_BOARD_PREFS
      } catch {
        return DEFAULT_BOARD_PREFS
      }
    },
    save: (prefs) => {
      try {
        storage.write(JSON.stringify(prefs))
      } catch {
        // Not kept: the next launch starts from the defaults, nothing else is lost.
      }
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parse(raw: unknown): BoardPrefs {
  if (!isObject(raw)) return DEFAULT_BOARD_PREFS
  const view = BOARD_VIEWS.includes(raw.view as BoardView) ? (raw.view as BoardView) : 'kanban'
  const p = raw.project
  const project =
    isObject(p) && typeof p.hubId === 'string' && typeof p.projectId === 'string'
      ? { hubId: p.hubId, projectId: p.projectId }
      : null
  const filters: Record<string, BoardFilter> = {}
  if (isObject(raw.filters)) {
    for (const [key, f] of Object.entries(raw.filters)) if (isObject(f)) filters[key] = filterOf(f)
  }
  return { project, view, filters }
}

const DUE_RANGES = ['all', 'overdue', 'today', 'week', 'later'] as const

function filterOf(f: Record<string, unknown>): BoardFilter {
  const d = DEFAULT_BOARD_FILTER
  return {
    priority:
      typeof f.priority === 'number' && f.priority >= 1 && f.priority <= 5
        ? f.priority
        : d.priority,
    dueDateRange: DUE_RANGES.includes(f.dueDateRange as never)
      ? (f.dueDateRange as BoardFilter['dueDateRange'])
      : d.dueDateRange,
    tagIds: Array.isArray(f.tagIds) ? f.tagIds.filter((t) => typeof t === 'string') : d.tagIds,
    showDone: typeof f.showDone === 'boolean' ? f.showDone : d.showDone,
    showBlocked: typeof f.showBlocked === 'boolean' ? f.showBlocked : d.showBlocked
  }
}
