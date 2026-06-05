import { Fzf } from 'fzf'
import type { SearchFileContext } from '@slayzone/settings'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
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
}

export function buildSearchItems({
  filter,
  fileContext,
  allFiles,
  tasks,
  projects
}: BuildSearchItemsParams): SearchItem[] {
  const list: SearchItem[] = []
  const showActions = filter === 'all' || filter === 'actions'
  const showFiles = filter === 'all' || filter === 'files'
  const showTasks = filter === 'all' || filter === 'tasks'
  const showProjects = filter === 'all' || filter === 'projects'

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
    selector: (i) => i.label,
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
    weightedScore: r.score * KIND_WEIGHT[r.item.kind]
  }))
  weighted.sort(
    (a, b) =>
      b.weightedScore - a.weightedScore ||
      selectorForItem(a.item).length - selectorForItem(b.item).length
  )
  return weighted.slice(0, MAX_RESULTS)
}

export function groupResults(results: RankedResult[]): GroupedResults {
  const actions = results.filter((r) => r.item.kind === 'action')
  const files = results.filter((r) => r.item.kind === 'file')
  const taskHits = results.filter((r) => r.item.kind === 'task')
  const projectHits = results.filter((r) => r.item.kind === 'project')
  return { actions, files, tasks: taskHits, projects: projectHits }
}
