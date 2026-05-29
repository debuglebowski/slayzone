import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Column } from './kanban'

export interface KanbanSelectionAPI {
  selectedIds: Set<string>
  anchorId: string | null
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
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

  // Reset on key change (project switch, etc.)
  useEffect(() => {
    setSelectedIds(new Set())
    setAnchorId(null)
  }, [resetKey])

  // Prune ids no longer present (filter changes, archive, etc.)
  const visibleIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const visible = new Set<string>()
    for (const c of columns) for (const t of c.tasks) visible.add(t.id)
    visibleIdsRef.current = visible
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
  }, [columns])

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

  return useMemo(
    () => ({
      selectedIds,
      anchorId,
      isSelected,
      toggle,
      replace,
      clear,
      selectAll,
      size: selectedIds.size
    }),
    [selectedIds, anchorId, isSelected, toggle, replace, clear, selectAll]
  )
}
