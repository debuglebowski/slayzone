/**
 * Fuzzy ranking via fzf — exact name matches always outrank everything; then name
 * matches outrank description matches. Tiebreak chain: exact-name first → fzf score
 * desc → usage count desc → alphabetical asc. Shared by skills / commands / agents
 * / builtins.
 */
import { Fzf } from 'fzf'
import type { AutocompleteSource } from './types'

export interface RankAccessors<Item> {
  getName: (item: Item) => string
  getDescription?: (item: Item) => string
  /** Per-item usage count. Used as tiebreak when fzf scores tie. Default 0. */
  getUsage?: (item: Item) => number
}

// fzf's `U extends string` conditional options typing breaks under generics — safe cast.
function makeFzf<T>(items: T[], selector: (t: T) => string): Fzf<readonly T[]> {
  type AnyCtor = new (list: readonly T[], opts: unknown) => Fzf<readonly T[]>
  return new (Fzf as unknown as AnyCtor)(items, { selector, casing: 'case-insensitive' })
}

function isExactMatch(name: string, query: string): boolean {
  return name.toLowerCase() === query.toLowerCase()
}

export function rankByName<Item>(
  items: Item[],
  query: string,
  accessors: RankAccessors<Item>
): Item[] {
  const { getName, getDescription, getUsage } = accessors
  const usage = getUsage ?? (() => 0)

  if (!query) {
    return [...items].sort(
      (a, b) =>
        usage(b) - usage(a) ||
        getName(a).localeCompare(getName(b))
    )
  }

  const nameHits = makeFzf(items, getName).find(query)
  const matched = new Set<Item>(nameHits.map((h) => h.item))

  const merged: { item: Item; score: number; exact: boolean }[] = nameHits.map((h) => ({
    item: h.item,
    score: h.score,
    exact: isExactMatch(getName(h.item), query),
  }))

  if (getDescription) {
    const pool = items.filter((i) => !matched.has(i))
    for (const h of makeFzf(pool, getDescription).find(query)) {
      merged.push({ item: h.item, score: 0, exact: false })
    }
  }

  merged.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.score - a.score ||
      usage(b.item) - usage(a.item) ||
      getName(a.item).localeCompare(getName(b.item))
  )
  return merged.map((m) => m.item)
}

export interface MergedEntry {
  item: unknown
  source: AutocompleteSource
}

interface SourceGroup {
  source: AutocompleteSource
  items: unknown[]
}

/**
 * Optional usage lookup for cross-source ranking. Receives sourceId + item name,
 * returns the persisted bump count (0 if unknown). Wired by useAutocomplete.
 */
export type UsageLookup = (sourceId: string, name: string) => number

/**
 * Cross-source fzf ranking. Builds a single ranked list across multiple sources by running
 * fzf on the union (using each source's `getName` / `getDescription` accessors). Name hits
 * outrank description hits. Tiebreak chain: fzf score desc → usage desc → alphabetical asc.
 * Sources that lack `getName` are appended in their own filter order at the end.
 */
export function rankAcrossSources(
  groups: SourceGroup[],
  query: string,
  getUsage?: UsageLookup
): MergedEntry[] {
  const mergeable = groups.filter((g) => g.source.getName)
  const passthrough = groups.filter((g) => !g.source.getName)

  type U = MergedEntry & { name: string; description: string; sourceId: string }
  const universe: U[] = []
  for (const g of mergeable) {
    const getName = g.source.getName as (i: unknown) => string
    const getDesc = g.source.getDescription as ((i: unknown) => string) | undefined
    for (const item of g.items) {
      universe.push({
        item,
        source: g.source,
        sourceId: g.source.id,
        name: getName(item),
        description: getDesc ? getDesc(item) : '',
      })
    }
  }

  const usage = getUsage ?? (() => 0)
  const u = (e: U) => usage(e.sourceId, e.name)

  let ranked: MergedEntry[]
  if (!query) {
    ranked = [...universe]
      .sort((a, b) => u(b) - u(a) || a.name.localeCompare(b.name))
      .map((e) => ({ item: e.item, source: e.source }))
  } else {
    const nameHits = makeFzf(universe, (u) => u.name).find(query)
    const matched = new Set<U>(nameHits.map((h) => h.item))
    const merged: { entry: U; score: number; exact: boolean }[] = nameHits.map((h) => ({
      entry: h.item,
      score: h.score,
      exact: isExactMatch(h.item.name, query),
    }))
    const pool = universe.filter((e) => !matched.has(e) && e.description)
    for (const h of makeFzf(pool, (e) => e.description).find(query)) {
      merged.push({ entry: h.item, score: 0, exact: false })
    }
    merged.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.score - a.score ||
        u(b.entry) - u(a.entry) ||
        a.entry.name.localeCompare(b.entry.name)
    )
    ranked = merged.map((m) => ({ item: m.entry.item, source: m.entry.source }))
  }

  for (const g of passthrough) {
    for (const item of g.items) ranked.push({ item, source: g.source })
  }
  return ranked
}
