import { Fzf } from 'fzf'
import type { SearchFileContext } from '@slayzone/settings'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { flattenPaletteCommands, type PaletteCommand } from '@slayzone/ui'
import type { FilterKind, SearchItem } from './SearchDialog.types'
import { BASENAME_BOOST, KIND_WEIGHT, MAX_RESULTS, ACTION_DEFS } from './SearchDialog.constants'
import { selectorForItem } from './SearchDialog.utils'

export interface RankedResult {
  item: SearchItem
  score: number
  positions: Set<number>
  usedPath: boolean
  weightedScore: number
}

export interface GroupedResults {
  taskCommands: RankedResult[]
  actions: RankedResult[]
  files: RankedResult[]
  tasks: RankedResult[]
  projects: RankedResult[]
}

interface BuildSearchItemsParams {
  filter: FilterKind
  fileContext: SearchFileContext | null
  allFiles: string[]
  tasks: Task[]
  projects: Project[]
  /** Commands of the current task (empty outside a task). */
  taskCommands: PaletteCommand[]
}

export function buildSearchItems({
  filter,
  fileContext,
  allFiles,
  tasks,
  projects,
  taskCommands
}: BuildSearchItemsParams): SearchItem[] {
  const list: SearchItem[] = []
  const showTaskCommands = filter === 'all' || filter === 'task'
  const showActions = filter === 'all' || filter === 'actions'
  const showFiles = filter === 'all' || filter === 'files'
  const showTasks = filter === 'all' || filter === 'tasks'
  const showProjects = filter === 'all' || filter === 'projects'

  if (showTaskCommands) {
    for (const { command, trail, limit } of flattenPaletteCommands(taskCommands)) {
      list.push({
        kind: 'task-command',
        // Prefixed: rankResults dedupes by id across kinds.
        id: `cmd:${command.id}`,
        label: [...trail, command.label].join(' → '),
        sublabel: '',
        keywords: command.keywords ?? '',
        command,
        limit
      })
    }
  }
  if (showActions) {
    for (const a of ACTION_DEFS) {
      list.push({
        kind: 'action',
        id: a.id,
        label: a.label,
        sublabel: a.sublabel,
        shortcutId: a.shortcutId
      })
    }
  }
  if (showFiles && fileContext) {
    for (const f of allFiles) {
      const name = f.split('/').pop() ?? f
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
      list.push({ kind: 'file', id: f, label: name, sublabel: dir, filePath: f })
    }
  }
  if (showTasks) {
    for (const t of tasks) {
      const projectName = projects.find((p) => p.id === t.project_id)?.name ?? ''
      list.push({
        kind: 'task',
        id: t.id,
        label: t.title,
        sublabel: projectName,
        status: t.status,
        priority: t.priority
      })
    }
  }
  if (showProjects) {
    for (const p of projects) {
      list.push({ kind: 'project', id: p.id, label: p.name, sublabel: '' })
    }
  }
  return list
}

export function createFzf(items: SearchItem[]): {
  fzfLabel: Fzf<SearchItem[]>
  fzfPath: Fzf<SearchItem[]>
} {
  const fzfLabel = new Fzf(items, {
    selector: (i: SearchItem) => i.label,
    limit: MAX_RESULTS * 2,
    casing: 'case-insensitive'
  })
  const fzfPath = new Fzf(items, {
    selector: selectorForItem,
    limit: MAX_RESULTS * 2,
    casing: 'case-insensitive'
  })
  return { fzfLabel, fzfPath }
}

export function rankResults(
  fzfLabel: Fzf<SearchItem[]>,
  fzfPath: Fzf<SearchItem[]>,
  search: string
): RankedResult[] {
  if (!search) return []
  const labelHits = fzfLabel.find(search)
  const pathHits = fzfPath.find(search)

  const pathMap = new Map(pathHits.map((r) => [r.item.id, r]))
  const seenIds = new Set<string>()
  const merged: { item: SearchItem; score: number; positions: Set<number>; usedPath: boolean }[] =
    []

  for (const r of labelHits) {
    seenIds.add(r.item.id)
    const boosted = r.score * BASENAME_BOOST
    const pathHit = r.item.kind === 'file' ? pathMap.get(r.item.id) : undefined
    if (pathHit && pathHit.score > boosted) {
      merged.push({
        item: r.item,
        score: pathHit.score,
        positions: pathHit.positions,
        usedPath: true
      })
    } else {
      merged.push({ item: r.item, score: boosted, positions: r.positions, usedPath: false })
    }
  }

  for (const r of pathHits) {
    if (!seenIds.has(r.item.id)) {
      seenIds.add(r.item.id)
      merged.push({ item: r.item, score: r.score, positions: r.positions, usedPath: true })
    }
  }

  const weighted = merged.map((r) => ({
    ...r,
    tier: matchTier(r.item, search),
    weightedScore: r.score * KIND_WEIGHT[r.item.kind]
  }))
  // Match quality first (fzf scores exact, prefix and mid-word hits alike), then score.
  weighted.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.weightedScore - a.weightedScore ||
      selectorForItem(a.item).length - selectorForItem(b.item).length
  )
  // Entity pages (tasks, projects…) contribute at most `limit.max` hits each.
  const perPage = new Map<string, number>()
  const capped = weighted.filter((r) => {
    const limit = r.item.kind === 'task-command' ? r.item.limit : undefined
    if (!limit) return true
    const n = (perPage.get(limit.key) ?? 0) + 1
    perPage.set(limit.key, n)
    return n <= limit.max
  })
  return capped.slice(0, MAX_RESULTS).map(({ tier: _tier, ...r }) => r)
}

/** The texts an item can match "as a whole": its label, plus a sub-page item's own label and its trail joined by spaces. */
function wholeMatchTexts(item: SearchItem): string[] {
  if (item.kind !== 'task-command') return [item.label]
  return [item.label, item.command.label, item.label.replaceAll(' → ', ' ')]
}

/** 0 exact, 1 prefix, 2 a word starts with the query, 3 substring, 4 fuzzy only. */
function matchTier(item: SearchItem, search: string): number {
  const q = search.trim().toLowerCase()
  let best = 4
  for (const raw of wholeMatchTexts(item)) {
    const t = raw.toLowerCase()
    if (t === q) return 0
    if (t.startsWith(q)) best = Math.min(best, 1)
    else if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q)}`, 'u').test(t))
      best = Math.min(best, 2)
    else if (t.includes(q)) best = Math.min(best, 3)
  }
  return best
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** cmdk value of a ranked row (matches the values SearchResults renders). */
export function resultValue(r: RankedResult): string {
  return r.item.kind === 'file' ? r.item.id : `${r.item.kind}:${r.item.id}`
}

/** The first row on screen: groups render in a fixed order, not by best hit. */
export function firstResultValue(groups: GroupedResults): string {
  const first =
    groups.taskCommands[0] ??
    groups.actions[0] ??
    groups.files[0] ??
    groups.tasks[0] ??
    groups.projects[0]
  return first ? resultValue(first) : ''
}

export function groupResults(results: RankedResult[]): GroupedResults {
  const taskCommands = results.filter((r) => r.item.kind === 'task-command')
  const actions = results.filter((r) => r.item.kind === 'action')
  const files = results.filter((r) => r.item.kind === 'file')
  const taskHits = results.filter((r) => r.item.kind === 'task')
  const projectHits = results.filter((r) => r.item.kind === 'project')
  return { taskCommands, actions, files, tasks: taskHits, projects: projectHits }
}
