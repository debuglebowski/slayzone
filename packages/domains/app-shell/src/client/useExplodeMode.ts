import {
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

// The arrangement actions read the store at call time rather than closing over the
// subscribed lists, so they keep one identity for the hook's lifetime: they are
// handed to every memoized task pane, and a new identity per minimize would
// re-render all of them.
function minimizeExplodeTask(taskId: string): void {
  const { explodeMinimized, setExplodeArrangement } = useTabStore.getState()
  if (explodeMinimized.includes(taskId)) return
  setExplodeArrangement({ minimized: [...explodeMinimized, taskId] })
}

function restoreExplodeTask(taskId: string): void {
  const { explodeMinimized, setExplodeArrangement } = useTabStore.getState()
  if (!explodeMinimized.includes(taskId)) return
  setExplodeArrangement({ minimized: explodeMinimized.filter((id) => id !== taskId) })
}

function restoreAllExplodeTasks(): void {
  const { explodeMinimized, setExplodeArrangement } = useTabStore.getState()
  if (explodeMinimized.length === 0) return
  setExplodeArrangement({ minimized: [] })
}

// Explode mode = multi-task grid. Owns its toggle, the keyboard-focused cell,
// the grid ref, the responsive grid size, and the user's arrangement (order +
// which terminals are parked in the header tray). Effects keep all of it in sync
// with the open task tabs. Blind to the active tab index on purpose: the shell that
// calls it must not re-render on a tab switch (the seed reads the store instead).
export function useExplodeMode(openTaskIds: string[]): ExplodeModeApi {
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

  // Auto-disable explode mode when fewer than 2 task tabs
  useEffect(() => {
    if (openTaskIds.length < 2) setExplodeMode(false)
  }, [openTaskIds.length])

  // Drop tray entries for tasks that are no longer open, so a closed-then-reopened
  // task comes back visible instead of invisibly stuck in the tray.
  useEffect(() => {
    const open = new Set(openTaskIds)
    const pruned = minimizedList.filter((id) => open.has(id))
    if (pruned.length !== minimizedList.length) {
      useTabStore.getState().setExplodeArrangement({ minimized: pruned })
    }
  }, [openTaskIds, minimizedList])

  const orderedTaskIds = useMemo(
    () => reconcileExplodeOrder(order, openTaskIds),
    [order, openTaskIds]
  )
  const explodeVisibleTaskIds = useMemo(
    () => orderedTaskIds.filter((id) => !minimizedList.includes(id)),
    [orderedTaskIds, minimizedList]
  )
  const explodeMinimizedTaskIds = useMemo(
    () => orderedTaskIds.filter((id) => minimizedList.includes(id)),
    [orderedTaskIds, minimizedList]
  )

  // Persist the RECONCILED order, not the stale stored one: a swap against an
  // order that predates a newly-opened task would otherwise drop that task.
  const swapExplodeTasks = (a: string, b: string): void => {
    const { explodeOrder, setExplodeArrangement } = useTabStore.getState()
    setExplodeArrangement({
      order: swapExplodeOrder(reconcileExplodeOrder(explodeOrder, openTaskIds), a, b)
    })
  }

  // No focused explode cell outside explode mode: cleared while rendering, and only when
  // set, so a tab switch never re-renders the whole shell. Every reader gates the cell on
  // `explodeMode`, so this changes no rendered output; it also clears a focusin that lands
  // before the grid listener below is removed.
  if (!explodeMode && focusedExplodeTaskId !== null) setFocusedExplodeTaskId(null)

  // Seed the focused explode cell on entering explode mode; keep it valid as tabs change.
  // A minimized task must never hold focus — its cell is gone, so shortcuts would
  // route to a terminal the user cannot see.
  useEffect(() => {
    if (!explodeMode) return
    setFocusedExplodeTaskId((prev) => {
      if (prev && explodeVisibleTaskIds.includes(prev)) return prev
      const { tabs, activeTabIndex } = useTabStore.getState()
      const activeTab = tabs[activeTabIndex]
      if (activeTab?.type === 'task' && explodeVisibleTaskIds.includes(activeTab.taskId)) {
        return activeTab.taskId
      }
      return explodeVisibleTaskIds[0] ?? null
    })
  }, [explodeMode, explodeVisibleTaskIds])

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
  // Height matters too: cells are positioned as explicit rects rather than `1fr`
  // grid tracks, so the layout cannot fall back on the container stretching.
  useEffect(() => {
    if (!explodeMode) return
    const grid = explodeGridRef.current
    if (!grid) return
    setExplodeGridWidth(grid.clientWidth)
    setExplodeGridHeight(grid.clientHeight)
    // Always the padding box (`clientWidth`/`clientHeight`), never `contentRect`:
    // absolutely positioned cells are offset from the padding edge, so the caller
    // subtracts the padding itself — mixing in the content box here would subtract
    // it twice after the first resize. Both are whole pixels, and a same-value
    // setState bails out, so sub-pixel jitter never re-lays out every terminal.
    const ro = new ResizeObserver(() => {
      setExplodeGridWidth(grid.clientWidth)
      setExplodeGridHeight(grid.clientHeight)
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
