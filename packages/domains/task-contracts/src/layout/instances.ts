/**
 * Multiple instances of a panel kind (docs/plans/panel-model.md step 7).
 *
 * The first instance of a kind keeps its legacy id and its state where it always
 * lived (task columns: `editor_open_files`, `git_active_tab`, `browser_tabs`…).
 * Every other instance is `<kind>:<uuid8>` and keeps its heavy state elsewhere:
 *
 * - `tasks.panel_instance_state[instanceId]` — editor open files, git tab and repo,
 *   artifacts selection and sidebar (`patchInstanceState` / `withoutInstanceState`).
 * - `browser_tabs.byPanel[instanceId]` — which tabs of the ONE flat per-task list
 *   it shows (tabs no entry lists are the primary's), so tab ids stay unique per
 *   task and `slay browser --tab` finds a tab whichever panel shows it.
 * - `settings.terminalGroupIds` — the terminal groups an agent/terminal instance
 *   shows; the primary agent shows every group no other instance claims.
 *
 * Handlers that act on "the" panel of a kind (shortcuts, palette, CLI events)
 * target `resolveTargetInstance`: the focused instance of that kind, else the primary.
 */
import type { BrowserPanelTabs, BrowserTab, BrowserTabsState } from '../browser-tabs'
import type { PanelInstanceState } from '../types'
import { findTab, isPrimaryInstance } from './ops'
import { PRIMARY_INSTANCE_IDS, type LayoutTree, type PanelInstance, type PanelKind } from './types'

// ── Instances of a kind ──────────────────────────────────────────────────────

/** The instances of `kind`, in layout order (columns left to right, slots, tabs). */
export function instancesOfKind(tree: LayoutTree, kind: PanelKind): PanelInstance[] {
  const out: PanelInstance[] = []
  for (const column of tree.columns)
    for (const slot of column.slots)
      for (const tab of slot.tabs) {
        const inst = tree.instances[tab.instanceId]
        if (inst?.kind === kind) out.push(inst)
      }
  return out
}

/**
 * The instance a kind-wide handler acts on: `focusedId` while it is an instance of
 * `kind` in the layout, else the kind's primary id (even when the layout lacks it:
 * showing it adds it back), else the first instance of the kind, else null.
 */
export function resolveTargetInstance(
  tree: LayoutTree,
  kind: PanelKind,
  focusedId: string | null | undefined
): string | null {
  if (focusedId && tree.instances[focusedId]?.kind === kind && findTab(tree, focusedId))
    return focusedId
  const primary = PRIMARY_INSTANCE_IDS[kind]
  if (primary !== undefined) return primary
  return instancesOfKind(tree, kind)[0]?.id ?? null
}

/** Whether `instanceId` is a non-primary instance in the layout (its state lives elsewhere). */
export function isSecondaryInstance(tree: LayoutTree, instanceId: string): boolean {
  const inst = tree.instances[instanceId]
  return !!inst && !isPrimaryInstance(inst)
}

// ── Terminal groups ──────────────────────────────────────────────────────────

const TERMINAL_KINDS: ReadonlySet<PanelKind> = new Set(['agent', 'terminal'])

/** The terminal groups an agent/terminal instance claims (`settings.terminalGroupIds`). */
export function terminalGroupIdsOf(inst: PanelInstance | undefined): string[] {
  if (!inst || !TERMINAL_KINDS.has(inst.kind)) return []
  const ids = inst.settings.terminalGroupIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

/** Every terminal group claimed by an agent/terminal instance other than `exceptId`. */
export function claimedTerminalGroupIds(tree: LayoutTree, exceptId?: string): string[] {
  const out = new Set<string>()
  for (const inst of Object.values(tree.instances)) {
    if (inst.id === exceptId) continue
    for (const id of terminalGroupIdsOf(inst)) out.add(id)
  }
  return [...out]
}

/** The agent/terminal instance claiming terminal group `groupId`, or null (the primary agent). */
export function terminalInstanceOfGroup(tree: LayoutTree, groupId: string): string | null {
  for (const inst of Object.values(tree.instances))
    if (terminalGroupIdsOf(inst).includes(groupId)) return inst.id
  return null
}

// ── panel_instance_state ─────────────────────────────────────────────────────

/** Merge `patch` into `instanceId`'s state (undefined values delete keys). */
export function patchInstanceState(
  state: PanelInstanceState | null | undefined,
  instanceId: string,
  patch: Record<string, unknown>
): PanelInstanceState {
  const entry: Record<string, unknown> = { ...(state?.[instanceId] ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete entry[k]
    else entry[k] = v
  }
  return { ...(state ?? {}), [instanceId]: entry }
}

/** The state without `instanceId`'s entry (the instance was closed). */
export function withoutInstanceState(
  state: PanelInstanceState | null | undefined,
  instanceId: string
): PanelInstanceState {
  const next: PanelInstanceState = { ...(state ?? {}) }
  delete next[instanceId]
  return next
}

// ── browser_tabs.byPanel ─────────────────────────────────────────────────────

function claimedTabIds(byPanel: Record<string, BrowserPanelTabs>, exceptId?: string): Set<string> {
  const out = new Set<string>()
  for (const [id, entry] of Object.entries(byPanel))
    if (id !== exceptId) for (const tabId of entry.tabIds) out.add(tabId)
  return out
}

function pickActive(tabIds: readonly string[], preferred: string | null): string | null {
  return preferred !== null && tabIds.includes(preferred) ? preferred : (tabIds[0] ?? null)
}

/**
 * The tabs browser instance `instanceId` shows, as the BrowserTabsState its panel
 * takes (no `byPanel`). The primary shows every tab no other instance lists, with
 * the stored `activeTabId`; with no `byPanel` that is the stored state as it is.
 */
export function browserTabsForInstance(
  state: BrowserTabsState,
  instanceId: string,
  primary: boolean
): BrowserTabsState {
  const byPanel = state.byPanel ?? {}
  if (primary) {
    const claimed = claimedTabIds(byPanel)
    if (claimed.size === 0) return { tabs: state.tabs, activeTabId: state.activeTabId }
    const tabs = state.tabs.filter((t) => !claimed.has(t.id))
    const activeTabId =
      state.activeTabId !== null && claimed.has(state.activeTabId)
        ? (tabs[0]?.id ?? null)
        : state.activeTabId
    return { tabs, activeTabId }
  }
  const entry = byPanel[instanceId]
  if (!entry) return { tabs: [], activeTabId: null }
  const byId = new Map(state.tabs.map((t) => [t.id, t]))
  const tabs = entry.tabIds.flatMap((id) => {
    const tab = byId.get(id)
    return tab ? [tab] : []
  })
  return {
    tabs,
    activeTabId: pickActive(
      tabs.map((t) => t.id),
      entry.activeTabId
    )
  }
}

/**
 * Write back what browser instance `instanceId` now shows (`view`, from its panel).
 * Its old tabs the view lacks are gone from the flat list; new ones join it; a tab
 * another instance listed moves here. Other instances' tabs are untouched.
 */
export function setBrowserTabsForInstance(
  state: BrowserTabsState,
  instanceId: string,
  primary: boolean,
  view: BrowserTabsState
): BrowserTabsState {
  const viewIds = new Set(view.tabs.map((t) => t.id))
  const byPanel: Record<string, BrowserPanelTabs> = {}
  for (const [id, entry] of Object.entries(state.byPanel ?? {})) {
    if (!primary && id === instanceId) continue
    const tabIds = entry.tabIds.filter((t) => !viewIds.has(t))
    byPanel[id] =
      tabIds.length === entry.tabIds.length
        ? entry
        : { tabIds, activeTabId: pickActive(tabIds, entry.activeTabId) }
  }
  let tabs: BrowserTab[]
  let activeTabId: string | null
  if (primary) {
    // Everything unlisted was the primary's: the view replaces it.
    const others = claimedTabIds(byPanel)
    tabs = [...view.tabs, ...state.tabs.filter((t) => others.has(t.id))]
    activeTabId = view.activeTabId
  } else {
    const mine = new Set(state.byPanel?.[instanceId]?.tabIds ?? [])
    tabs = [...state.tabs.filter((t) => !viewIds.has(t.id) && !mine.has(t.id)), ...view.tabs]
    byPanel[instanceId] = {
      tabIds: view.tabs.map((t) => t.id),
      activeTabId: pickActive(
        view.tabs.map((t) => t.id),
        view.activeTabId
      )
    }
    activeTabId =
      state.activeTabId !== null && (viewIds.has(state.activeTabId) || mine.has(state.activeTabId))
        ? (tabs.find((t) => !claimedTabIds(byPanel).has(t.id))?.id ?? null)
        : state.activeTabId
  }
  return Object.keys(byPanel).length > 0 ? { tabs, activeTabId, byPanel } : { tabs, activeTabId }
}

/** The state without browser instance `instanceId`: its entry and its tabs are gone. */
export function removeBrowserInstanceTabs(
  state: BrowserTabsState,
  instanceId: string
): BrowserTabsState {
  const entry = state.byPanel?.[instanceId]
  if (!entry) return state
  const gone = new Set(entry.tabIds)
  const byPanel = { ...state.byPanel }
  delete byPanel[instanceId]
  const tabs = state.tabs.filter((t) => !gone.has(t.id))
  const base = { tabs, activeTabId: state.activeTabId }
  return Object.keys(byPanel).length > 0 ? { ...base, byPanel } : base
}

/** The non-primary browser instance listing tab `tabId`, or null (the primary's, or unknown). */
export function browserInstanceOfTab(state: BrowserTabsState, tabId: string): string | null {
  for (const [id, entry] of Object.entries(state.byPanel ?? {}))
    if (entry.tabIds.includes(tabId)) return id
  return null
}
