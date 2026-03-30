import { useState, useEffect, useRef, useCallback } from 'react'
import { type FilterState, type ViewConfig, defaultFilterState, defaultCardProperties, defaultBoardConfig, defaultListConfig } from './FilterState'

function getFilterKey(projectId: string): string {
  return projectId ? `filter:${projectId}` : 'filter:none'
}

function migrateViewConfig(raw: Record<string, unknown>, defaults: ViewConfig, allowListOnly: boolean): ViewConfig {
  const config = { ...defaults }
  const groupBy = raw.groupBy as string | undefined
  if (groupBy === 'status' || groupBy === 'priority' || groupBy === 'due_date') {
    config.groupBy = groupBy
  } else if (allowListOnly && (groupBy === 'none' || groupBy === 'active')) {
    config.groupBy = groupBy
  }
  if (['manual', 'priority', 'due_date', 'title', 'created'].includes(raw.sortBy as string)) config.sortBy = raw.sortBy as ViewConfig['sortBy']
  if (typeof raw.showEmptyColumns === 'boolean') config.showEmptyColumns = raw.showEmptyColumns
  if (raw.completedFilter === 'none' || raw.completedFilter === 'all') config.completedFilter = raw.completedFilter
  else if (raw.completedFilter === 'day' || raw.completedFilter === 'week') config.completedFilter = 'all'
  else if ('showDone' in raw) config.completedFilter = raw.showDone ? 'all' : 'none'
  if (typeof raw.showArchived === 'boolean') config.showArchived = raw.showArchived
  if (typeof raw.showSubTasks === 'boolean') config.showSubTasks = raw.showSubTasks
  if (typeof raw.showBlockedColumn === 'boolean') config.showBlockedColumn = raw.showBlockedColumn
  if (typeof raw.blockedColumnAfter === 'string' || raw.blockedColumnAfter === null) config.blockedColumnAfter = raw.blockedColumnAfter as string | null
  if (typeof raw.showSnoozedColumn === 'boolean') config.showSnoozedColumn = raw.showSnoozedColumn
  if (typeof raw.snoozedColumnAfter === 'string' || raw.snoozedColumnAfter === null) config.snoozedColumnAfter = raw.snoozedColumnAfter as string | null
  return config
}

/** Migrate old persisted state and fill missing fields with defaults */
function migrateFilterState(raw: Record<string, unknown>): FilterState {
  const state = { ...defaultFilterState }

  // View mode
  if (raw.viewMode === 'board' || raw.viewMode === 'list') state.viewMode = raw.viewMode

  // Per-view configs
  if (raw.board && typeof raw.board === 'object') {
    // New shape — already has nested configs
    state.board = migrateViewConfig(raw.board as Record<string, unknown>, defaultBoardConfig, false)
  } else if ('groupBy' in raw) {
    // Old flat shape — copy into both views
    const flat = raw as Record<string, unknown>
    state.board = migrateViewConfig(flat, defaultBoardConfig, false)
  }

  if (raw.list && typeof raw.list === 'object') {
    state.list = migrateViewConfig(raw.list as Record<string, unknown>, defaultListConfig, true)
  } else if ('groupBy' in raw) {
    const flat = raw as Record<string, unknown>
    state.list = migrateViewConfig(flat, defaultListConfig, true)
  }

  // Migrate old groupActiveTasks toggle → 'active' grouping (list only)
  if (raw.groupActiveTasks === true && state.list.groupBy === 'none') state.list.groupBy = 'active'

  // Shared fields
  if (raw.priority === null || (typeof raw.priority === 'number' && raw.priority >= 1 && raw.priority <= 5)) state.priority = raw.priority as number | null
  if (['all', 'overdue', 'today', 'week', 'later'].includes(raw.dueDateRange as string)) state.dueDateRange = raw.dueDateRange as FilterState['dueDateRange']
  if (Array.isArray(raw.tagIds)) state.tagIds = raw.tagIds.filter((id): id is string => typeof id === 'string')

  // Card properties — merge with defaults so new properties get default value
  if (raw.cardProperties && typeof raw.cardProperties === 'object') {
    const cp = raw.cardProperties as Record<string, unknown>
    state.cardProperties = { ...defaultCardProperties }
    for (const key of Object.keys(defaultCardProperties) as (keyof typeof defaultCardProperties)[]) {
      if (typeof cp[key] === 'boolean') state.cardProperties[key] = cp[key] as boolean
    }
  }

  return state
}

export function useFilterState(
  projectId: string
): [FilterState, (filter: FilterState) => void] {
  const [filterState, setFilterState] = useState<FilterState>(defaultFilterState)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevProjectIdRef = useRef<string>(projectId)

  // Load filter from settings on mount and when projectId changes
  useEffect(() => {
    const key = getFilterKey(projectId)

    // Only reset loaded state if projectId actually changed
    if (prevProjectIdRef.current !== projectId) {
      // Set default filter immediately to prevent flicker
      setFilterState(defaultFilterState)
      prevProjectIdRef.current = projectId
    }

    window.api.settings.get(key).then((value) => {
      if (value) {
        try {
          const parsed = JSON.parse(value)
          setFilterState(migrateFilterState(parsed))
        } catch {
          setFilterState(defaultFilterState)
        }
      } else {
        setFilterState(defaultFilterState)
      }
    })
  }, [projectId])

  // Debounced save
  const pendingRef = useRef<FilterState | null>(null)

  const flushSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (pendingRef.current) {
      const key = getFilterKey(projectId)
      window.api.settings.set(key, JSON.stringify(pendingRef.current))
      pendingRef.current = null
    }
  }, [projectId])

  const setFilter = useCallback(
    (newFilter: FilterState) => {
      setFilterState(newFilter)
      pendingRef.current = newFilter

      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        pendingRef.current = null
        const key = getFilterKey(projectId)
        window.api.settings.set(key, JSON.stringify(newFilter))
      }, 500)
    },
    [projectId]
  )

  // Flush pending save on unmount
  useEffect(() => {
    return () => flushSave()
  }, [flushSave])

  return [filterState, setFilter]
}
