/**
 * Lenses: saved, named presets of the tree sidebar (plans/layout-redesign.md, phase 2).
 *
 * A lens holds how the sidebar is grouped (by project, agent state, task status or
 * recency), how project rows look, which projects show, whether the "Needs you" strip
 * is on, and the full tree display settings (`tree-display.ts`).
 *
 * The sidebar never reads a lens directly. It reads the LIVE fields on the tab store
 * (`LiveLensFields`); applying a lens writes them, editing changes them, and saving
 * copies them back into the lens. "Dirty" = live differs from the active lens. So every
 * existing tree component keeps reading the same `tree*` fields it always did.
 *
 * Pure functions only; the tab store wires them to state.
 */
import {
  DEFAULT_TREE_DISPLAY,
  parseTreeDisplay,
  pickTreeDisplay,
  treeDisplayEqual,
  type TreeDisplay
} from './tree-display'

export type LensGroup = 'project' | 'agent' | 'status' | 'recent'
export type LensLook = 'cards' | 'flat' | 'accordion' | 'dense'
export type LensProjects = 'active' | 'all'
/** Icon key, mapped to an icon by the sidebar. */
export type LensIcon = 'today' | 'agent' | 'status' | 'recent' | 'accordion' | 'lens'
export type BuiltinLensId = 'today' | 'agent-status' | 'task-status' | 'recent' | 'accordion'

export interface LensSpec {
  group: LensGroup
  /** Only used when `group` is 'project'. */
  look: LensLook
  projects: LensProjects
  needsYou: boolean
  display: TreeDisplay
}

export interface Lens {
  id: string
  name: string
  icon: LensIcon
  /** Which built-in this is (they can be edited, hidden and reset, never deleted). */
  builtin: BuiltinLensId | null
  /** Left out of the lens menu and the ⌃1–9 order. */
  hidden: boolean
  spec: LensSpec
}

/** The tab-store fields a lens drives. */
export interface LiveLensFields extends TreeDisplay {
  treeLensGroup: LensGroup
  treeLensLook: LensLook
  /** `projects: 'all'`. Also toggled by the toolbar's More › Show all projects. */
  treeShowAllProjects: boolean
  treeNeedsYou: boolean
}

export const LENS_GROUPS: readonly LensGroup[] = ['project', 'agent', 'status', 'recent']
export const LENS_LOOKS: readonly LensLook[] = ['cards', 'flat', 'accordion', 'dense']
const LENS_ICONS: readonly LensIcon[] = ['today', 'agent', 'status', 'recent', 'accordion', 'lens']

/** Statuses that are not finished, for the lenses that look across every project. */
const OPEN_STATUSES = ['inbox', 'backlog', 'todo', 'in_progress', 'review']

export const TODAY_LENS_ID = 'today'

const BUILTINS: ReadonlyArray<{
  id: BuiltinLensId
  name: string
  icon: LensIcon
  spec: Omit<LensSpec, 'display'> & { display?: Partial<TreeDisplay> }
}> = [
  // Today = the sidebar as it was before lenses (and, on upgrade, the user's settings).
  {
    id: 'today',
    name: 'Today',
    icon: 'today',
    spec: { group: 'project', look: 'cards', projects: 'active', needsYou: false }
  },
  {
    id: 'agent-status',
    name: 'Agent status',
    icon: 'agent',
    spec: {
      group: 'agent',
      look: 'cards',
      projects: 'all',
      needsYou: false,
      display: { treeStatusFilter: OPEN_STATUSES }
    }
  },
  {
    id: 'task-status',
    name: 'Task status',
    icon: 'status',
    spec: {
      group: 'status',
      look: 'cards',
      projects: 'all',
      needsYou: false,
      display: { treeStatusFilter: OPEN_STATUSES }
    }
  },
  {
    id: 'recent',
    name: 'Recent',
    icon: 'recent',
    spec: {
      group: 'recent',
      look: 'cards',
      projects: 'all',
      needsYou: false,
      display: { treeStatusFilter: OPEN_STATUSES, treeOrderBy: 'last_interaction' }
    }
  },
  {
    id: 'accordion',
    name: 'Accordion',
    icon: 'accordion',
    spec: { group: 'project', look: 'accordion', projects: 'all', needsYou: false }
  }
]

const BUILTIN_IDS = new Set<string>(BUILTINS.map((b) => b.id))

/** A built-in lens as it ships. The built-in's lens id is its built-in id. */
export function builtinLens(id: BuiltinLensId): Lens {
  const b = BUILTINS.find((x) => x.id === id)
  if (!b) throw new Error(`Unknown built-in lens: ${id}`)
  const { display, ...rest } = b.spec
  return {
    id: b.id,
    name: b.name,
    icon: b.icon,
    builtin: b.id,
    hidden: false,
    spec: {
      ...rest,
      display: { ...pickTreeDisplay(DEFAULT_TREE_DISPLAY), ...cloneDisplay(display) }
    }
  }
}

export function defaultLenses(): Lens[] {
  return BUILTINS.map((b) => builtinLens(b.id))
}

function cloneDisplay(d: Partial<TreeDisplay> | undefined): Partial<TreeDisplay> {
  if (!d) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) out[k] = Array.isArray(v) ? [...v] : v
  return out as Partial<TreeDisplay>
}

export function cloneSpec(spec: LensSpec): LensSpec {
  return { ...spec, display: pickTreeDisplay(spec.display) }
}

/** The lens spec the sidebar shows right now. */
export function liveSpec(live: LiveLensFields): LensSpec {
  return {
    group: live.treeLensGroup,
    look: live.treeLensLook,
    projects: live.treeShowAllProjects ? 'all' : 'active',
    needsYou: live.treeNeedsYou,
    display: pickTreeDisplay(live)
  }
}

/** The live fields that show `spec`. */
export function specToLive(spec: LensSpec): LiveLensFields {
  return {
    ...pickTreeDisplay(spec.display),
    treeLensGroup: spec.group,
    treeLensLook: spec.look,
    treeShowAllProjects: spec.projects === 'all',
    treeNeedsYou: spec.needsYou
  }
}

/**
 * Same lens? `look` only counts when grouping by project, and the "inside projects"
 * grouping only then too — neither shows in the cross-project lists.
 */
export function specEqual(a: LensSpec, b: LensSpec): boolean {
  if (a.group !== b.group || a.projects !== b.projects || a.needsYou !== b.needsYou) return false
  if (a.group === 'project' && a.look !== b.look) return false
  return treeDisplayEqual(a.display, b.display)
}

/** A built-in whose name or settings differ from how it ships. Never true for user lenses. */
export function isLensEdited(lens: Lens): boolean {
  if (!lens.builtin) return false
  const shipped = builtinLens(lens.builtin)
  return lens.name !== shipped.name || !specEqual(lens.spec, shipped.spec)
}

/** A built-in back as it ships, keeping its place and whether it is hidden. */
export function resetLens(lens: Lens): Lens {
  if (!lens.builtin) return lens
  return { ...builtinLens(lens.builtin), hidden: lens.hidden }
}

/** The lenses in the menu, in order — index i is ⌃(i+1). */
export function visibleLenses(lenses: readonly Lens[]): Lens[] {
  return lenses.filter((l) => !l.hidden)
}

export function isLensDirty(lenses: readonly Lens[], activeLensId: string, live: LiveLensFields) {
  const lens = lenses.find((l) => l.id === activeLensId)
  return lens ? !specEqual(lens.spec, liveSpec(live)) : false
}

export function newLensId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `lens-${rand}`
}

/** A name not taken yet: "Today copy", "Today copy 2", … */
export function uniqueLensName(lenses: readonly Lens[], base: string): string {
  const taken = new Set(lenses.map((l) => l.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`
}

function parseSpec(raw: unknown): LensSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  return {
    group: LENS_GROUPS.includes(s.group as LensGroup) ? (s.group as LensGroup) : 'project',
    look: LENS_LOOKS.includes(s.look as LensLook) ? (s.look as LensLook) : 'cards',
    projects: s.projects === 'all' ? 'all' : 'active',
    needsYou: s.needsYou === true,
    display: parseTreeDisplay(
      s.display && typeof s.display === 'object' ? (s.display as Record<string, unknown>) : null
    )
  }
}

function parseLens(raw: unknown): Lens | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  if (typeof l.id !== 'string' || !l.id) return null
  const spec = parseSpec(l.spec)
  if (!spec) return null
  const builtin =
    typeof l.builtin === 'string' && BUILTIN_IDS.has(l.builtin)
      ? (l.builtin as BuiltinLensId)
      : null
  const fallback = builtin ? builtinLens(builtin) : null
  return {
    id: builtin ?? l.id,
    name: typeof l.name === 'string' && l.name.trim() ? l.name : (fallback?.name ?? 'Lens'),
    icon: LENS_ICONS.includes(l.icon as LensIcon)
      ? (l.icon as LensIcon)
      : (fallback?.icon ?? 'lens'),
    builtin,
    hidden: l.hidden === true,
    spec
  }
}

/**
 * The saved lenses, or — when none were ever saved (the upgrade to lenses) — the
 * built-ins with the user's current display settings as "Today", active, so nothing
 * about the sidebar changes on upgrade.
 *
 * `legacy` is the sidebar as loaded from the same saved state (its `tree*` fields).
 * A saved list missing a built-in (one added in a later release) gets it appended;
 * malformed and duplicate entries are dropped; at least one lens stays visible.
 */
export function migrateLenses(
  saved: { lenses?: unknown; activeLensId?: unknown },
  legacy: LiveLensFields
): { lenses: Lens[]; activeLensId: string } {
  if (!Array.isArray(saved.lenses)) {
    const lenses = defaultLenses().map((l) =>
      l.id === TODAY_LENS_ID ? { ...l, spec: liveSpec(legacy) } : l
    )
    return { lenses, activeLensId: TODAY_LENS_ID }
  }
  const seen = new Set<string>()
  const lenses: Lens[] = []
  for (const raw of saved.lenses) {
    const lens = parseLens(raw)
    if (!lens || seen.has(lens.id)) continue
    seen.add(lens.id)
    lenses.push(lens)
  }
  for (const b of BUILTINS) if (!seen.has(b.id)) lenses.push(builtinLens(b.id))
  if (visibleLenses(lenses).length === 0) lenses[0] = { ...lenses[0], hidden: false }
  const activeLensId =
    typeof saved.activeLensId === 'string' && lenses.some((l) => l.id === saved.activeLensId)
      ? saved.activeLensId
      : visibleLenses(lenses)[0].id
  return { lenses, activeLensId }
}

/** The live lens fields from saved view state (absent → Today's defaults). */
export function parseLiveLensFields(raw: Record<string, unknown>): LiveLensFields {
  return {
    ...parseTreeDisplay(raw),
    treeLensGroup: LENS_GROUPS.includes(raw.treeLensGroup as LensGroup)
      ? (raw.treeLensGroup as LensGroup)
      : 'project',
    treeLensLook: LENS_LOOKS.includes(raw.treeLensLook as LensLook)
      ? (raw.treeLensLook as LensLook)
      : 'cards',
    treeShowAllProjects: raw.treeShowAllProjects === true,
    treeNeedsYou: raw.treeNeedsYou === true
  }
}
