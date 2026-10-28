import { Fzf } from 'fzf'
import type { SearchFileContext } from '@slayzone/settings'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
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
  /** A sub-page item rendered under its command (shows its own label, indented). */
  nested?: boolean
  /** Shown only because one of its sub-page items matched — not itself a hit. */
  context?: boolean
  /** Position in match order before nesting (0 = best hit). Absent on context rows. */
  rank?: number
  /** Match quality (0 = exact … see `labelTier`). Absent on context rows. */
  tier?: number
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
    for (const { command, trail, limit, rootId } of flattenPaletteCommands(taskCommands)) {
      list.push({
        kind: 'task-command',
        // Prefixed: rankResults dedupes by id across kinds.
        id: `cmd:${command.id}`,
        label: [...trail, command.label].join(' → '),
        sublabel: '',
        keywords: command.keywords ?? '',
        command,
        limit,
        rootItemId: rootId ? `cmd:${rootId}` : undefined
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
  search: string,
  /** The searched items — supplies a sub-page item's command when only the item matched. */
  items: SearchItem[]
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
  // Task commands tie-break on their defined order (stable, as authored); the rest on length.
  const order = new Map(items.map((item, i) => [item.id, i]))
  weighted.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.weightedScore - a.weightedScore ||
      (a.item.kind === 'task-command' && b.item.kind === 'task-command'
        ? (order.get(a.item.id) ?? 0) - (order.get(b.item.id) ?? 0)
        : selectorForItem(a.item).length - selectorForItem(b.item).length)
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
  const ranked = capped.map((r, rank) => ({ ...r, rank }))
  return nestUnderCommands(ranked, items, search).slice(0, MAX_RESULTS)
}

/**
 * Sub-page items render directly beneath their top-level command: each command and its
 * matching items form one block, placed where its best member ranks. A command that did
 * not match itself still heads its block, as context.
 */
function nestUnderCommands(
  ranked: RankedResult[],
  items: SearchItem[],
  search: string
): RankedResult[] {
  const rootOf = (r: RankedResult): string | undefined =>
    r.item.kind === 'task-command' ? r.item.rootItemId : undefined
  const children = new Map<string, RankedResult[]>()
  for (const r of ranked) {
    const root = rootOf(r)
    if (!root) continue
    const list = children.get(root) ?? []
    list.push({ ...r, nested: true })
    children.set(root, list)
  }
  if (children.size === 0) return ranked
  // Within a block: items whose own label matches first, then the page's own order
  // (an item matched only through its page title is just one of the page's options).
  const order = new Map(items.map((item, i) => [item.id, i]))
  const leafTier = (r: RankedResult): number =>
    r.item.kind === 'task-command' ? labelTier(r.item.command.label, search) : 4
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        leafTier(a) - leafTier(b) || (order.get(a.item.id) ?? 0) - (order.get(b.item.id) ?? 0)
    )
  }

  const byId = new Map(ranked.map((r) => [r.item.id, r]))
  const itemById = new Map(items.map((i) => [i.id, i]))
  const out: RankedResult[] = []
  const placed = new Set<string>()
  for (const r of ranked) {
    const blockId = rootOf(r) ?? r.item.id
    if (placed.has(blockId)) continue
    placed.add(blockId)
    const nestedRows = children.get(blockId)
    if (!nestedRows) {
      out.push(r)
      continue
    }
    const head = byId.get(blockId)
    if (head) out.push(head)
    else {
      const rootItem = itemById.get(blockId)
      if (rootItem) {
        out.push({
          item: rootItem,
          score: 0,
          positions: new Set(),
          usedPath: false,
          weightedScore: 0,
          context: true
        })
      }
    }
    out.push(...nestedRows)
  }
  return out
}

/**
 * The texts an item can match "as a whole": its label, plus a sub-page item's own label
 * and its trail joined by spaces. A trailing "…" (opens a page) is not part of the name.
 */
function wholeMatchTexts(item: SearchItem): string[] {
  const texts =
    item.kind === 'task-command'
      ? [item.label, item.command.label, item.label.replaceAll(' → ', ' ')]
      : [item.label]
  return texts.map((t) => t.replace(/…$/, ''))
}

/** Best tier over the item's whole-match texts. */
function matchTier(item: SearchItem, search: string): number {
  return Math.min(...wholeMatchTexts(item).map((t) => labelTier(t, search)))
}

/** 0 exact, 1 prefix, 2 a word starts with the query, 3 substring, 4 fuzzy only. */
function labelTier(text: string, search: string): number {
  const q = search.trim().toLowerCase()
  const t = text.replace(/…$/, '').toLowerCase()
  if (t === q) return 0
  if (t.startsWith(q)) return 1
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q)}`, 'u').test(t)) return 2
  if (t.includes(q)) return 3
  return 4
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** cmdk value of a ranked row (matches the values SearchResults renders). */
export function resultValue(r: RankedResult): string {
  return r.item.kind === 'file' ? r.item.id : `${r.item.kind}:${r.item.id}`
}

/**
 * The row selected on open: the best hit of the first group on screen. Groups render in a
 * fixed order, and inside a group a command row can head a better-matching sub-page item.
 *
 * One exception: an entity pick (a row of a capped entity page, e.g. "Blocked by → X")
 * never defaults over a task or project matching at least as well. Its label IS that
 * entity's title, so typing a title + Enter would otherwise write a relation to the
 * entity instead of opening it. The pick stays listed; it just isn't the default.
 */
export function firstResultValue(groups: GroupedResults): string {
  const entityTiers = [...groups.tasks, ...groups.projects]
    .filter((r) => !r.context)
    .map((r) => r.tier ?? Infinity)
  const bestEntityTier = Math.min(Infinity, ...entityTiers)
  const yieldsToEntity = (r: RankedResult): boolean =>
    r.item.kind === 'task-command' && !!r.item.limit && bestEntityTier <= (r.tier ?? Infinity)
  for (const group of [
    groups.taskCommands,
    groups.actions,
    groups.files,
    groups.tasks,
    groups.projects
  ]) {
    let best: RankedResult | undefined
    for (const r of group) {
      if (r.context || yieldsToEntity(r)) continue
      if (!best || (r.rank ?? 0) < (best.rank ?? 0)) best = r
    }
    if (best) return resultValue(best)
  }
  return ''
}

export function groupResults(results: RankedResult[]): GroupedResults {
  const taskCommands = results.filter((r) => r.item.kind === 'task-command')
  const actions = results.filter((r) => r.item.kind === 'action')
  const files = results.filter((r) => r.item.kind === 'file')
  const taskHits = results.filter((r) => r.item.kind === 'task')
  const projectHits = results.filter((r) => r.item.kind === 'project')
  return { taskCommands, actions, files, tasks: taskHits, projects: projectHits }
}
