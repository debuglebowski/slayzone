import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { useTabStore } from '@slayzone/settings'

type Tabs = ReturnType<typeof useTabStore.getState>['tabs']

export interface ExplodeModeApi {
  explodeMode: boolean
  setExplodeMode: Dispatch<SetStateAction<boolean>>
  focusedExplodeTaskId: string | null
  explodeGridRef: RefObject<HTMLDivElement | null>
  explodeGridWidth: number
}

// Explode mode = multi-task grid. Owns its toggle, the keyboard-focused cell,
// the grid ref, and the responsive grid width. Effects keep all three in sync
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

  // Auto-disable explode mode when fewer than 2 task tabs
  useEffect(() => {
    if (openTaskIds.length < 2) setExplodeMode(false)
  }, [openTaskIds.length])

  // Seed / clear focused explode cell on mode toggle; keep valid as tabs change
  useEffect(() => {
    if (!explodeMode) {
      setFocusedExplodeTaskId(null)
      return
    }
    setFocusedExplodeTaskId((prev) => {
      if (prev && openTaskIds.includes(prev)) return prev
      const activeTab = tabs[activeTabIndex]
      if (activeTab?.type === 'task') return activeTab.taskId
      return openTaskIds[0] ?? null
    })
  }, [explodeMode, openTaskIds, activeTabIndex, tabs])

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

  // Track grid width so explode mode can pack more columns as the window grows.
  useEffect(() => {
    if (!explodeMode) return
    const grid = explodeGridRef.current
    if (!grid) return
    setExplodeGridWidth(grid.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setExplodeGridWidth(w)
    })
    ro.observe(grid)
    return () => ro.disconnect()
  }, [explodeMode])

  return { explodeMode, setExplodeMode, focusedExplodeTaskId, explodeGridRef, explodeGridWidth }
}
