import { useCallback, useState } from 'react'
import type { Column } from './kanban'

export interface KanbanSelectionAPI {
  selectedIds: Set<string>
  anchorId: string | null
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  // Shift-click: additively select the contiguous range from anchor to id, within id's column
  selectRange: (id: string) => void
  replace: (id: string) => void
  clear: () => void
  selectAll: (ids: string[]) => void
  size: number
}

interface UseKanbanSelectionOpts {
  columns: Column[]
  // Reset selection when this key changes (e.g. project id, filter signature)
  resetKey?: string | null
}

export function useKanbanSelection({
  columns,
  resetKey
}: UseKanbanSelectionOpts): KanbanSelectionAPI {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)

  // Reset on key change (project switch, etc.). Both syncs below run while
  // rendering, so no commit shows a selection that no longer applies.
  const [selectionResetKey, setSelectionResetKey] = useState(resetKey)
  if (selectionResetKey !== resetKey) {
    setSelectionResetKey(resetKey)
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  // Prune ids no longer present (filter changes, archive, etc.). A content check,
  // not an identity check: callers rebuild `columns` every render, and every
  // selection write comes from a visible card, so "selection ⊆ visible" is exactly
  // what the prune maintains. Once pruned the check is false, so it settles.
  if (selectedIds.size > 0 || anchorId !== null) {
    const visible = new Set<string>()
    for (const c of columns) for (const t of c.tasks) visible.add(t.id)
    let stale = anchorId !== null && !visible.has(anchorId)
    for (const id of selectedIds) if (!visible.has(id)) stale = true
    if (stale) {
      setSelectedIds((prev) => {
        let changed = false
        const next = new Set<string>()
        for (const id of prev) {
          if (visible.has(id)) next.add(id)
          else changed = true
        }
        return changed ? next : prev
      })
      setAnchorId((prev) => (prev && visible.has(prev) ? prev : prev === null ? null : null))
    }
  }

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds])

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setAnchorId(id)
  }, [])

  // Range-add within the clicked card's column. Same-column anchor → add anchor..id (inclusive),
  // keep anchor so further shift-clicks extend from it. No usable anchor → add single + set anchor.
  const selectRange = useCallback(
    (id: string) => {
      const col = columns.find((c) => c.tasks.some((t) => t.id === id))
      if (!col) return
      const order = col.tasks.map((t) => t.id)
      const toIdx = order.indexOf(id)
      const anchorIdx = anchorId ? order.indexOf(anchorId) : -1
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (anchorIdx === -1) {
          next.add(id)
          return next
        }
        const [lo, hi] = anchorIdx <= toIdx ? [anchorIdx, toIdx] : [toIdx, anchorIdx]
        for (let k = lo; k <= hi; k++) next.add(order[k])
        return next
      })
      if (anchorIdx === -1) setAnchorId(id)
    },
    [columns, anchorId]
  )

  const replace = useCallback((id: string) => {
    setSelectedIds(new Set([id]))
    setAnchorId(id)
  }, [])

  const clear = useCallback(() => {
    setSelectedIds(new Set())
    setAnchorId(null)
  }, [])

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids))
    setAnchorId(ids[ids.length - 1] ?? null)
  }, [])

  return {
    selectedIds,
    anchorId,
    isSelected,
    toggle,
    selectRange,
    replace,
    clear,
    selectAll,
    size: selectedIds.size
  }
}
