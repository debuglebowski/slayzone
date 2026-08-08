import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { useTabStore } from '@slayzone/settings'
import { reconcileExplodeOrder, swapExplodeOrder } from './explodeLayout'

type Tabs = ReturnType<typeof useTabStore.getState>['tabs']

export interface ExplodeModeApi {
  explodeMode: boolean
  setExplodeMode: Dispatch<SetStateAction<boolean>>
  focusedExplodeTaskId: string | null
  explodeGridRef: RefObject<HTMLDivElement | null>
  explodeGridWidth: number
  explodeGridHeight: number
  /** Open task ids in user-arranged order, minimized ones removed — exactly what
   *  the grid lays out. */
  explodeVisibleTaskIds: string[]
  /** Parked in the header tray; still open tabs, just not given grid space. */
  explodeMinimizedTaskIds: string[]
  minimizeExplodeTask: (taskId: string) => void
  restoreExplodeTask: (taskId: string) => void
  restoreAllExplodeTasks: () => void
  /** Exchange two cells' positions (drag-to-swap). */
  swapExplodeTasks: (a: string, b: string) => void
}

// Explode mode = multi-task grid. Owns its toggle, the keyboard-focused cell,
// the grid ref, the responsive grid size, and the user's arrangement (order +
// which terminals are parked in the header tray). Effects keep all of it in sync
// with the open task tabs.
export function useExplodeMode(
  openTaskIds: string[],
  tabs: Tabs,
  activeTabIndex: number
): ExplodeModeApi {
  const [explodeMode, setExplodeMode] = useState(false)
  // In explode mode, tracks which grid cell owns keyboard shortcuts (Cmd+D etc.).
  // Null outside explode mode. Updated via focusin bubble on the grid wrapper.
  const [focusedExplodeTaskId, setFocusedExplodeTaskId] = useState<string | null>(null)
  const explodeGridRef = useRef<HTMLDivElement | null>(null)
  const [explodeGridWidth, setExplodeGridWidth] = useState(0)
  const [explodeGridHeight, setExplodeGridHeight] = useState(0)
  // User arrangement, persisted in the tab store's `viewState` slice so a renderer
  // reload or restart keeps the layout the user built. May lag the open tabs (a
  // task opened or closed since the last drag), so every read goes through
  // reconcile rather than trusting it.
  const order = useTabStore((s) => s.explodeOrder)
  const minimizedList = useTabStore((s) => s.explodeMinimized)
  const setExplodeArrangement = useTabStore((s) => s.setExplodeArrangement)
  const minimized = useMemo<ReadonlySet<string>>(() => new Set(minimizedList), [minimizedList])

  // Auto-disable explode mode when fewer than 2 task tabs
  useEffect(() => {
    if (openTaskIds.length < 2) setExplodeMode(false)
  }, [openTaskIds.length])

  // Drop arrangement state for tasks that are no longer open, so a closed-then-
  // reopened task comes back visible instead of invisibly stuck in the tray.
  useEffect(() => {
    const open = new Set(openTaskIds)
    const pruned = minimizedList.filter((id) => open.has(id))
    if (pruned.length !== minimizedList.length) {
      setExplodeArrangement({ minimized: pruned })
    }
  }, [openTaskIds, minimizedList, setExplodeArrangement])

  const orderedTaskIds = useMemo(
    () => reconcileExplodeOrder(order, openTaskIds),
    [order, openTaskIds]
  )

  const explodeVisibleTaskIds = useMemo(
    () => orderedTaskIds.filter((id) => !minimized.has(id)),
    [orderedTaskIds, minimized]
  )

  const explodeMinimizedTaskIds = useMemo(
    () => orderedTaskIds.filter((id) => minimized.has(id)),
    [orderedTaskIds, minimized]
  )

  const minimizeExplodeTask = useCallback(
    (taskId: string) => {
      if (minimizedList.includes(taskId)) return
      setExplodeArrangement({ minimized: [...minimizedList, taskId] })
    },
    [minimizedList, setExplodeArrangement]
  )

  const restoreExplodeTask = useCallback(
    (taskId: string) => {
      if (!minimizedList.includes(taskId)) return
      setExplodeArrangement({ minimized: minimizedList.filter((id) => id !== taskId) })
    },
    [minimizedList, setExplodeArrangement]
  )

  const restoreAllExplodeTasks = useCallback(() => {
    if (minimizedList.length === 0) return
    setExplodeArrangement({ minimized: [] })
  }, [minimizedList.length, setExplodeArrangement])

  // Persist the RECONCILED order, not the stale stored one: a swap against an
  // order that predates a newly-opened task would otherwise drop that task.
  const swapExplodeTasks = useCallback(
    (a: string, b: string) => {
      setExplodeArrangement({
        order: swapExplodeOrder(reconcileExplodeOrder(order, openTaskIds), a, b)
      })
    },
    [order, openTaskIds, setExplodeArrangement]
  )

  // Seed / clear focused explode cell on mode toggle; keep valid as tabs change.
  // A minimized task must never hold focus — its cell is gone, so shortcuts would
  // route to a terminal the user cannot see.
  useEffect(() => {
    if (!explodeMode) {
      setFocusedExplodeTaskId(null)
      return
    }
    setFocusedExplodeTaskId((prev) => {
      if (prev && explodeVisibleTaskIds.includes(prev)) return prev
      const activeTab = tabs[activeTabIndex]
      if (activeTab?.type === 'task' && explodeVisibleTaskIds.includes(activeTab.taskId)) {
        return activeTab.taskId
      }
      return explodeVisibleTaskIds[0] ?? null
    })
  }, [explodeMode, explodeVisibleTaskIds, activeTabIndex, tabs])

  // Delegated focusin: bubble from xterm / editor / browser → grid cell; resolve task id.
  useEffect(() => {
    if (!explodeMode) return
    const grid = explodeGridRef.current
    if (!grid) return
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null
      const cell = target?.closest('[data-explode-task-id]')
      const id = cell?.getAttribute('data-explode-task-id')
      if (id) setFocusedExplodeTaskId(id)
    }
    grid.addEventListener('focusin', handleFocusIn)
    return () => grid.removeEventListener('focusin', handleFocusIn)
  }, [explodeMode])

  // Track grid size so explode mode can pack more columns as the window grows.
  // Height matters too now: cells are positioned as explicit rects rather than
  // `1fr` grid tracks, so the layout cannot fall back on the container stretching.
  useEffect(() => {
    if (!explodeMode) return
    const grid = explodeGridRef.current
    if (!grid) return
    setExplodeGridWidth(grid.clientWidth)
    setExplodeGridHeight(grid.clientHeight)
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      // Round and bail on no-change. `contentRect` reports sub-pixel values, so a
      // raw set re-rendered the whole app tree — and re-laid out every terminal —
      // on jitter far below one pixel. Same-value setState is a bail-out in React,
      // so this collapses that churn to real size changes only.
      const w = Math.round(rect?.width ?? 0)
      const h = Math.round(rect?.height ?? 0)
      setExplodeGridWidth((prev) => (prev === w ? prev : w))
      setExplodeGridHeight((prev) => (prev === h ? prev : h))
    })
    ro.observe(grid)
    return () => ro.disconnect()
  }, [explodeMode])

  return {
    explodeMode,
    setExplodeMode,
    focusedExplodeTaskId,
    explodeGridRef,
    explodeGridWidth,
    explodeGridHeight,
    explodeVisibleTaskIds,
    explodeMinimizedTaskIds,
    minimizeExplodeTask,
    restoreExplodeTask,
    restoreAllExplodeTasks,
    swapExplodeTasks
  }
}
