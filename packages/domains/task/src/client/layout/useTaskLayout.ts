/**
 * The task page's panel layout state (docs/plans/panel-model.md §2).
 *
 * - Starts from the stored `task.panel_layout`, else derives Classic from the
 *   legacy columns the page mounted with (`deriveLayoutFromLegacy`). A secondary
 *   window always derives from its own (lifted) visibility.
 * - Classic follows `panel_config` while it is Classic-shaped
 *   (`reconcileClassicLayout`), so the rendered layout is a view of the stored one.
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
  PanelConfig,
  PanelSizes,
  PanelVisibility,
  Task,
  TaskLayout,
  UpdateTaskInput
} from '@slayzone/task-contracts'
import {
  applyLegacyWrite,
  deriveLayoutFromLegacy,
  findTab,
  legacyKindOf,
  projectToLegacy,
  reconcileClassicLayout,
  resizeColumns,
  setActiveTab,
  setSlotHidden
} from '@slayzone/task-contracts'

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
  onPanelVisibilityChange
}: UseTaskLayoutOptions): TaskLayoutApi {
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
    () => reconcileClassicLayout(state.stored, panelConfig),
    [state.stored, panelConfig]
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
        const current = reconcileClassicLayout(prev.stored, panelConfig)
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
      const current = reconcileClassicLayout(prev.stored, panelConfig)
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
      const current = reconcileClassicLayout(prev.stored, panelConfig)
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
    resetAllSizes
  }
}
