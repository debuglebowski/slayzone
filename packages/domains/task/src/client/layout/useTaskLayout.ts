/**
 * The task page's panel layout state (docs/plans/panel-model.md §2).
 *
 * - Starts from the stored `task.panel_layout`, else derives Classic from the
 *   legacy columns the page mounted with (`deriveLayoutFromLegacy`). A secondary
 *   window always derives from its own (lifted) visibility.
 * - Classic follows `panel_config` while it is Classic-shaped
 *   (`reconcileClassicLayout`), so the rendered layout is a view of the stored one —
 *   until the user edits the Classic definition (`followPanelConfig` false).
 * - Layout definitions (step 10) apply through `applyDefinition`: instances are
 *   matched by kind and keep their ids; leftovers with live state are parked.
 * - Writes go through a debounced `updateTask({panelLayout})` from the primary
 *   window only; the hub dual-writes panel_visibility / panel_sizes. A hub without
 *   the column (`task.panel_layout === undefined`) gets the legacy fields instead.
 *   Secondary windows keep their layout local.
 * - A stored layout arriving with a higher `rev` (another client) replaces ours.
 * - `panelVisibility` is the legacy projection, for the many callers that still
 *   think in panel ids; it keeps ids the layout does not know (`tests`) as given.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStableCallback } from '@slayzone/ui'
import type {
  InstancePlacement,
  LayoutDefinition,
  PanelConfig,
  PanelInstance,
  PanelKind,
  PanelSizes,
  PanelVisibility,
  Task,
  TaskLayout,
  UpdateTaskInput
} from '@slayzone/task-contracts'
import {
  addInstance as addInstanceOp,
  applyLegacyWrite,
  closeTab as closeTabOp,
  deriveLayoutFromLegacy,
  findSlot,
  findTab,
  hideTab as hideTabOp,
  legacyKindOf,
  moveColumn as moveColumnOp,
  projectToLegacy,
  reconcileClassicLayout,
  renameInstance,
  renameSlot,
  resizeColumns,
  resizeSlots as resizeSlotsOp,
  setActiveTab,
  setSlotHidden,
  splitAt,
  switchLayout,
  unparkInstance,
  updateInstanceSettings as updateInstanceSettingsOp,
  type SwitchLayoutResult
} from '@slayzone/task-contracts'
import { applyDrop, type DragItem, type DropTarget } from './layoutDnd'

/** Coalesces a burst of toggles (a shortcut held down, several panels opened at once). */
export const LAYOUT_SAVE_DEBOUNCE_MS = 150

export interface UseTaskLayoutOptions {
  task: Task | null
  panelConfig: PanelConfig
  /** Legacy visibility the page mounts with (the loader's, or a secondary window's lifted state). */
  initialVisibility: PanelVisibility
  /** Legacy size overrides the page mounts with. */
  initialSizes: PanelSizes
  isSecondaryWindow: boolean
  updateTask: (input: UpdateTaskInput) => Promise<Task | null | undefined>
  onTaskUpdated: (task: Task) => void
  /** Called with the projected visibility whenever it changes (a secondary window lifts it). */
  onPanelVisibilityChange?: (visibility: PanelVisibility) => void
  /**
   * A Classic-shaped layout is rebuilt from `panel_config` (default true). False once
   * the user edited the Classic definition: it then is a layout like any other.
   */
  followPanelConfig?: boolean
}

export interface TaskLayoutApi {
  /** The layout to render (Classic reconciled with `panel_config`). */
  layout: TaskLayout
  /** Legacy projection: panel id → shown. Stable while visibility is unchanged. */
  panelVisibility: PanelVisibility
  /** The group holding panel (instance) `panelId`, or null. */
  slotOf: (panelId: string) => string | null
  /**
   * Show or hide the group holding `panelId`. Showing also clears its column's size
   * override (opening a panel resets its size) and selects its tab; a panel the
   * layout lacks is added as a column. Persists.
   */
  setPanelVisible: (panelId: string, visible: boolean) => void
  /** Show a tab in its group and persist. */
  activateTab: (instanceId: string) => void
  /** Hide panels in this window only (no write): closed elsewhere / released on close. */
  hidePanelsLocally: (panelIds: readonly string[]) => void
  /** Replace the whole visibility in this window only (no write): a template was applied. */
  replaceVisibilityLocally: (visibility: Record<string, boolean>) => void
  /** Live column size overrides during a drag (no write). */
  resizeColumns: (overrides: Partial<PanelSizes>) => void
  /** Persist the sizes (drag end). */
  commitSizes: () => void
  /** Clear every column size override and persist. */
  resetAllSizes: () => void
  /** Slot weights within a column: live during a drag (`persist` false), or one persisted edit. */
  resizeSlots: (columnId: string, weights: Record<string, number>, persist: boolean) => void
  /** A finished panel drag: move the tab or group (no-op drops change nothing). Persists. */
  dropPanel: (item: DragItem, target: DropTarget) => void
  /** Move a tab into a new slot below its group (`after`) or a new column right of it (`right`). */
  splitTab: (instanceId: string, zone: 'after' | 'right') => void
  /** Hide a tab in place (its group when it is the group's last shown tab). Persists. */
  hideTab: (instanceId: string) => void
  /** Close a tab: hides a primary (legacy-id) instance, removes any other. Persists. */
  closeTab: (instanceId: string) => void
  /** Name a tab (blank = the kind's label). Persists. */
  renameTab: (instanceId: string, name: string) => void
  /** Name a group (blank = named from its contents). Persists. */
  renameGroup: (slotId: string, name: string) => void
  /** Move a column to `toIndex` among the columns. Persists. */
  moveColumn: (columnId: string, toIndex: number) => void
  /**
   * Add a new instance of `kind` at `placement` and show it; returns its id (the
   * kind's legacy id while no instance holds it, else `<kind>:<uuid8>`). Persists.
   */
  addInstance: (
    kind: PanelKind,
    placement: InstancePlacement,
    settings?: Record<string, unknown>
  ) => string
  /**
   * New panel instances can be added and kept: the hub stores `panel_layout` and this
   * is the primary window (an old hub keeps the legacy columns only, which hold no
   * extra instances; a secondary window's layout is local).
   */
  supportsInstances: boolean
  /** Merge into an instance's settings (undefined deletes a key). Persists. */
  updateInstanceSettings: (instanceId: string, patch: Record<string, unknown>) => void
  /**
   * Switch to layout definition `def` (`switchLayout`): matched instances keep their
   * ids, unmatched ones with live state are parked, the rest dropped (the caller
   * releases their state). Persists. Returns what happened.
   */
  applyDefinition: (
    def: LayoutDefinition,
    hasLiveState: (inst: PanelInstance) => boolean
  ) => SwitchLayoutResult
  /** Bring a parked instance back as a new column and show it. Persists. */
  unpark: (instanceId: string) => void
  /** Record that the layout now IS definition `layoutId` (it was just saved as it). Persists. */
  setLayoutId: (layoutId: string) => void
  /**
   * Undo a change made outside the view (`task.onLayoutChanged`): put `before` back as
   * a new edit, unless the layout moved past `rev` (the change's rev) since — then
   * nothing happens and it returns false. Persists.
   */
  restoreLayout: (before: TaskLayout, rev: number) => boolean
}

interface LayoutState {
  stored: TaskLayout
  /** Legacy visibility base: keeps keys the layout does not own (`tests`, unknown web ids). */
  legacyVisibility: Record<string, boolean>
  /** Bumped by every change to persist; the save effect keys on it. */
  saveSeq: number
}

/** Show/hide the group holding `panelId`; null when the layout cannot (unknown id). */
function withPanelVisible(
  layout: TaskLayout,
  panelId: string,
  visible: boolean
): TaskLayout | null {
  const loc = findTab(layout, panelId)
  if (!loc) {
    if (!visible || !legacyKindOf(panelId)) return null
    return applyLegacyWrite(layout, { panelVisibility: { [panelId]: true } })
  }
  const column = layout.columns[loc.columnIndex]
  const slot = column.slots[loc.slotIndex]
  if (!visible) return setSlotHidden(layout, slot.id, true)
  // Like the legacy toggle: opening resets the size even when already open.
  return resizeColumns(setActiveTab(setSlotHidden(layout, slot.id, false), panelId), {
    [column.id]: null
  })
}

export function useTaskLayout({
  task,
  panelConfig,
  initialVisibility,
  initialSizes,
  isSecondaryWindow,
  updateTask,
  onTaskUpdated,
  onPanelVisibilityChange,
  followPanelConfig = true
}: UseTaskLayoutOptions): TaskLayoutApi {
  const reconcile = (stored: TaskLayout): TaskLayout =>
    followPanelConfig ? reconcileClassicLayout(stored, panelConfig) : stored
  const [state, setState] = useState<LayoutState>(() => ({
    stored:
      (!isSecondaryWindow ? task?.panel_layout : null) ??
      deriveLayoutFromLegacy(
        { panel_visibility: initialVisibility, panel_sizes: initialSizes },
        panelConfig
      ),
    legacyVisibility: { ...initialVisibility },
    saveSeq: 0
  }))

  const layout = useMemo(
    () => (followPanelConfig ? reconcileClassicLayout(state.stored, panelConfig) : state.stored),
    [state.stored, panelConfig, followPanelConfig]
  )

  // Keyed by content so a resize frame (new layout, same visibility) keeps the object.
  const visibilityKey = JSON.stringify(
    projectToLegacy(layout, { panelVisibility: state.legacyVisibility }).panelVisibility
  )
  const panelVisibility = useMemo(
    () => JSON.parse(visibilityKey) as PanelVisibility,
    [visibilityKey]
  )

  useEffect(() => {
    onPanelVisibilityChange?.(panelVisibility)
  }, [panelVisibility, onPanelVisibilityChange])

  // ── Incoming: a stored layout with a higher rev (another client) wins ─────────
  // Adjusted while rendering (not in an effect): the newer layout is what this render shows.
  const incoming = isSecondaryWindow ? null : (task?.panel_layout ?? null)
  const [seenIncoming, setSeenIncoming] = useState(incoming)
  if (incoming !== seenIncoming) {
    setSeenIncoming(incoming)
    if (incoming && incoming.rev > state.stored.rev) setState({ ...state, stored: incoming })
  }

  // ── Outgoing: debounced write of the latest layout ─────────────────────────────
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taskId = task?.id
  const hubHasLayout = task?.panel_layout !== undefined
  const save = useStableCallback(() => {
    saveTimerRef.current = null
    if (!taskId || isSecondaryWindow) return
    const legacy = projectToLegacy(layout, {
      panelVisibility: state.legacyVisibility,
      panelSizes: initialSizes
    })
    const input: UpdateTaskInput = hubHasLayout
      ? { id: taskId, panelLayout: layout, panelVisibility: legacy.panelVisibility }
      : { id: taskId, panelVisibility: legacy.panelVisibility, panelSizes: legacy.panelSizes }
    updateTask(input).then(
      (updated) => {
        if (updated) onTaskUpdated(updated)
      },
      (error: unknown) => console.warn('[task] saving the panel layout failed:', error)
    )
  })

  useEffect(() => {
    if (state.saveSeq === 0) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(save, LAYOUT_SAVE_DEBOUNCE_MS)
  }, [state.saveSeq, save])

  // Unmount (tab closed, window swapped to another task): write what is pending now.
  useEffect(
    () => () => {
      if (!saveTimerRef.current) return
      clearTimeout(saveTimerRef.current)
      save()
    },
    [save]
  )

  // ── Edits ──────────────────────────────────────────────────────────────────────
  /** Apply `fn` to the rendered layout; `persist` false keeps the rev (a local view). */
  const edit = useStableCallback(
    (fn: (current: TaskLayout) => TaskLayout | null, persist: boolean) => {
      setState((prev) => {
        const current = reconcile(prev.stored)
        const next = fn(current)
        if (!next) return prev
        return {
          ...prev,
          stored: persist ? next : { ...next, rev: prev.stored.rev },
          saveSeq: persist ? prev.saveSeq + 1 : prev.saveSeq
        }
      })
    }
  )

  const slotOf = useStableCallback((panelId: string): string | null => {
    const loc = findTab(layout, panelId)
    return loc ? layout.columns[loc.columnIndex].slots[loc.slotIndex].id : null
  })

  const setPanelVisible = useStableCallback((panelId: string, visible: boolean) => {
    setState((prev) => {
      const current = reconcile(prev.stored)
      const next = withPanelVisible(current, panelId, visible)
      return {
        stored: next ?? prev.stored,
        // An id the layout cannot hold (`tests`) lives on in the legacy map only.
        legacyVisibility: next
          ? prev.legacyVisibility
          : { ...prev.legacyVisibility, [panelId]: visible },
        saveSeq: prev.saveSeq + 1
      }
    })
  })

  const activateTab = useStableCallback((instanceId: string) => {
    edit(
      (current) => (findTab(current, instanceId) ? setActiveTab(current, instanceId) : null),
      true
    )
  })

  const hidePanelsLocally = useStableCallback((panelIds: readonly string[]) => {
    if (panelIds.length === 0) return
    edit(
      (current) =>
        applyLegacyWrite(current, {
          panelVisibility: Object.fromEntries(panelIds.map((id) => [id, false]))
        }),
      false
    )
  })

  const replaceVisibilityLocally = useStableCallback((visibility: Record<string, boolean>) => {
    setState((prev) => {
      const current = reconcile(prev.stored)
      // Every panel the layout holds that `visibility` omits is hidden, like the
      // legacy wholesale replace.
      const full: Record<string, boolean> = {}
      for (const id of Object.keys(current.instances)) full[id] = false
      Object.assign(full, visibility)
      const next = applyLegacyWrite(current, { panelVisibility: full })
      return {
        ...prev,
        stored: { ...next, rev: prev.stored.rev },
        legacyVisibility: { ...visibility }
      }
    })
  })

  const resizeColumnsLive = useStableCallback((overrides: Partial<PanelSizes>) => {
    edit((current) => resizeColumns(current, overrides as PanelSizes), false)
  })

  // The drag's frames kept the rev; the committed sizes are one edit.
  const commitSizes = useStableCallback(() => {
    setState((prev) => ({
      ...prev,
      stored: { ...prev.stored, rev: prev.stored.rev + 1 },
      saveSeq: prev.saveSeq + 1
    }))
  })

  const resetAllSizes = useStableCallback(() => {
    edit(
      (current) =>
        resizeColumns(current, Object.fromEntries(current.columns.map((c) => [c.id, null]))),
      true
    )
  })

  const resizeSlots = useStableCallback(
    (columnId: string, weights: Record<string, number>, persist: boolean) => {
      edit((current) => resizeSlotsOp(current, columnId, weights), persist)
    }
  )

  const dropPanel = useStableCallback((item: DragItem, target: DropTarget) => {
    edit((current) => applyDrop(current, item, target), true)
  })

  const splitTab = useStableCallback((instanceId: string, zone: 'after' | 'right') => {
    edit((current) => {
      const loc = findTab(current, instanceId)
      if (!loc) return null
      const slot = current.columns[loc.columnIndex].slots[loc.slotIndex]
      if (slot.tabs.length < 2) return null
      return splitAt(current, instanceId, slot.id, zone)
    }, true)
  })

  const hideTab = useStableCallback((instanceId: string) => {
    edit((current) => (findTab(current, instanceId) ? hideTabOp(current, instanceId) : null), true)
  })

  const closeTab = useStableCallback((instanceId: string) => {
    edit((current) => (findTab(current, instanceId) ? closeTabOp(current, instanceId) : null), true)
  })

  const renameTab = useStableCallback((instanceId: string, name: string) => {
    edit(
      (current) =>
        current.instances[instanceId] ? renameInstance(current, instanceId, name) : null,
      true
    )
  })

  const renameGroup = useStableCallback((slotId: string, name: string) => {
    edit((current) => (findSlot(current, slotId) ? renameSlot(current, slotId, name) : null), true)
  })

  const moveColumn = useStableCallback((columnId: string, toIndex: number) => {
    edit((current) => {
      const from = current.columns.findIndex((c) => c.id === columnId)
      return from < 0 || from === toIndex ? null : moveColumnOp(current, columnId, toIndex)
    }, true)
  })

  const addInstance = useStableCallback(
    (kind: PanelKind, placement: InstancePlacement, settings?: Record<string, unknown>): string => {
      // The id is decided here, against the layout this render shows, so the caller
      // can use it right away; the edit below applies the same op to the latest state.
      const { instanceId } = addInstanceOp(layout, kind, placement, { settings })
      edit(
        (current) =>
          current.instances[instanceId]
            ? null
            : addInstanceOp(current, kind, placement, { id: instanceId, settings }).layout,
        true
      )
      return instanceId
    }
  )

  const updateInstanceSettings = useStableCallback(
    (instanceId: string, patch: Record<string, unknown>) => {
      edit(
        (current) =>
          current.instances[instanceId]
            ? updateInstanceSettingsOp(current, instanceId, patch)
            : null,
        true
      )
    }
  )

  const applyDefinition = useStableCallback(
    (def: LayoutDefinition, hasLiveState: (inst: PanelInstance) => boolean): SwitchLayoutResult => {
      // Decided against the layout this render shows, so the caller can act on the
      // result right away (release dropped instances, start terminals for new ones).
      const result = switchLayout(layout, def, { hasLiveState })
      edit(() => result.layout, true)
      return result
    }
  )

  const unpark = useStableCallback((instanceId: string) => {
    edit(
      (current) => (findTab(current, instanceId) ? unparkInstance(current, instanceId) : null),
      true
    )
  })

  const setLayoutId = useStableCallback((layoutId: string) => {
    edit((current) => ({ ...current, layoutId, rev: current.rev + 1 }), true)
  })

  const restoreLayout = useStableCallback((before: TaskLayout, rev: number): boolean => {
    if (state.stored.rev > rev) return false
    setState((prev) => ({
      ...prev,
      stored: { ...before, rev: Math.max(prev.stored.rev, rev) + 1 },
      saveSeq: prev.saveSeq + 1
    }))
    return true
  })

  return {
    layout,
    panelVisibility,
    slotOf,
    setPanelVisible,
    activateTab,
    hidePanelsLocally,
    replaceVisibilityLocally,
    resizeColumns: resizeColumnsLive,
    commitSizes,
    resetAllSizes,
    resizeSlots,
    dropPanel,
    splitTab,
    hideTab,
    closeTab,
    renameTab,
    renameGroup,
    moveColumn,
    addInstance,
    supportsInstances: hubHasLayout && !isSecondaryWindow,
    updateInstanceSettings,
    applyDefinition,
    unpark,
    setLayoutId,
    restoreLayout
  }
}
