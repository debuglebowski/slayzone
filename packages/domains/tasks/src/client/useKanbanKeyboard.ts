import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGuardedHotkeys } from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import type { Column } from './kanban'

export type PickerType = 'status' | 'priority'

export interface PickerState {
  type: PickerType
  taskId: string
}

interface UseKanbanKeyboardOptions {
  columns: Column[]
  isActive: boolean
  isDragging?: boolean
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
}

interface UseKanbanKeyboardReturn {
  focusedTaskId: string | null
  setHoveredTaskId: (id: string | null) => void
  pickerState: PickerState | null
  closePickerState: () => void
  blockerDialogTaskId: string | null
  closeBlockerDialog: () => void
  cardRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}

export function useKanbanKeyboard({
  columns,
  isActive,
  isDragging,
  onTaskClick,
  onUpdateTask
}: UseKanbanKeyboardOptions): UseKanbanKeyboardReturn {
  // Keyboard focus only — mouse hover never touches this
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [pickerState, setPickerState] = useState<PickerState | null>(null)
  const [blockerDialogTaskId, setBlockerDialogTaskId] = useState<string | null>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // Tracks mouse hover position to seed keyboard navigation start — ref so it doesn't trigger re-renders
  const hoveredTaskIdRef = useRef<string | null>(null)
  // Guard: Radix Popover handles Escape with flushSync, which can cause useHotkeys
  // to see pickerState=null mid-event and accidentally clear focus
  const pickerClosingRef = useRef(false)

  // Grid lookup: taskId → { col, row }
  const gridLookup = useMemo(() => {
    const map = new Map<string, { col: number; row: number }>()
    columns.forEach((col, ci) => {
      col.tasks.forEach((task, ri) => {
        map.set(task.id, { col: ci, row: ri })
      })
    })
    return map
  }, [columns])

  // Clear focus if focused task disappears (filtered/deleted)
  useEffect(() => {
    if (focusedTaskId && !gridLookup.has(focusedTaskId)) {
      setFocusedTaskId(null)
    }
  }, [focusedTaskId, gridLookup])

  // Close picker when focus changes
  useEffect(() => {
    setPickerState(null)
  }, [focusedTaskId])

  const findTask = useCallback(
    (id: string) => {
      for (const col of columns) {
        const t = col.tasks.find((t) => t.id === id)
        if (t) return t
      }
      return null
    },
    [columns]
  )

  const focusFirst = useCallback(() => {
    // Prefer hovered card as starting position
    const hoveredId = hoveredTaskIdRef.current
    if (hoveredId && gridLookup.has(hoveredId)) {
      setFocusedTaskId(hoveredId)
      cardRefs.current.get(hoveredId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return
    }
    for (const col of columns) {
      if (col.tasks.length > 0) {
        setFocusedTaskId(col.tasks[0].id)
        cardRefs.current.get(col.tasks[0].id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        return
      }
    }
  }, [columns, gridLookup])

  const navigate = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      if (!focusedTaskId) {
        focusFirst()
        return
      }
      const pos = gridLookup.get(focusedTaskId)
      if (!pos) {
        focusFirst()
        return
      }

      let nextCol = pos.col
      let nextRow = pos.row

      switch (direction) {
        case 'up':
          nextRow = Math.max(0, pos.row - 1)
          break
        case 'down':
          nextRow = Math.min(columns[pos.col].tasks.length - 1, pos.row + 1)
          break
        case 'left':
          for (let c = pos.col - 1; c >= 0; c--) {
            if (columns[c].tasks.length > 0) {
              nextCol = c
              break
            }
          }
          if (nextCol === pos.col) return // no non-empty column to the left
          nextRow = Math.min(pos.row, columns[nextCol].tasks.length - 1)
          break
        case 'right':
          for (let c = pos.col + 1; c < columns.length; c++) {
            if (columns[c].tasks.length > 0) {
              nextCol = c
              break
            }
          }
          if (nextCol === pos.col) return // no non-empty column to the right
          nextRow = Math.min(pos.row, columns[nextCol].tasks.length - 1)
          break
      }

      const target = columns[nextCol]?.tasks[nextRow]
      if (target) {
        setFocusedTaskId(target.id)
        cardRefs.current.get(target.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    },
    [focusedTaskId, gridLookup, columns, focusFirst]
  )

  const enabled = isActive && !pickerState && !isDragging

  useGuardedHotkeys('j, ArrowDown', (e) => { e.preventDefault(); navigate('down') }, { enabled })
  useGuardedHotkeys('k, ArrowUp', (e) => { e.preventDefault(); navigate('up') }, { enabled })
  useGuardedHotkeys('h, ArrowLeft', (e) => { e.preventDefault(); navigate('left') }, { enabled })
  useGuardedHotkeys('l, ArrowRight', (e) => { e.preventDefault(); navigate('right') }, { enabled })

  useGuardedHotkeys('enter', (e) => {
    if (!focusedTaskId) return
    e.preventDefault()
    const task = findTask(focusedTaskId)
    if (task) onTaskClick?.(task, { metaKey: false })
  }, { enabled })

  useGuardedHotkeys('mod+enter', (e) => {
    if (!focusedTaskId) return
    e.preventDefault()
    const task = findTask(focusedTaskId)
    if (task) onTaskClick?.(task, { metaKey: true })
  }, { enabled })

  useGuardedHotkeys('s', (e) => {
    if (!focusedTaskId || !onUpdateTask) return
    e.preventDefault()
    setPickerState({ type: 'status', taskId: focusedTaskId })
  }, { enabled })

  useGuardedHotkeys('p', (e) => {
    if (!focusedTaskId || !onUpdateTask) return
    e.preventDefault()
    setPickerState({ type: 'priority', taskId: focusedTaskId })
  }, { enabled })

  useGuardedHotkeys('b', (e) => {
    if (!focusedTaskId || !onUpdateTask) return
    e.preventDefault()
    const task = findTask(focusedTaskId)
    if (task) {
      onUpdateTask(focusedTaskId, {
        is_blocked: !task.is_blocked,
        ...(task.is_blocked ? { blocked_comment: null } : {})
      } as Partial<Task>)
    }
  }, { enabled })

  useGuardedHotkeys('shift+b', (e) => {
    if (!focusedTaskId) return
    e.preventDefault()
    setBlockerDialogTaskId(focusedTaskId)
  }, { enabled })

  useGuardedHotkeys('escape', (e) => {
    if (pickerState) {
      e.preventDefault()
      pickerClosingRef.current = true
      setPickerState(null)
      requestAnimationFrame(() => { pickerClosingRef.current = false })
    } else if (focusedTaskId && !pickerClosingRef.current) {
      e.preventDefault()
      setFocusedTaskId(null)
    }
  }, { enabled: isActive })

  const setHoveredTaskId = useCallback((id: string | null) => {
    hoveredTaskIdRef.current = id
  }, [])

  return {
    focusedTaskId,
    setHoveredTaskId,
    pickerState,
    closePickerState: useCallback(() => {
      pickerClosingRef.current = true
      setPickerState(null)
      requestAnimationFrame(() => { pickerClosingRef.current = false })
    }, []),
    blockerDialogTaskId,
    closeBlockerDialog: useCallback(() => setBlockerDialogTaskId(null), []),
    cardRefs
  }
}
