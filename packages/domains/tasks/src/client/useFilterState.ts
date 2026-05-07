import { useEffect, useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
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

  if (raw.viewMode === 'board' || raw.viewMode === 'list') state.viewMode = raw.viewMode

  if (raw.board && typeof raw.board === 'object') {
    state.board = migrateViewConfig(raw.board as Record<string, unknown>, defaultBoardConfig, false)
  } else if ('groupBy' in raw) {
    const flat = raw as Record<string, unknown>
    state.board = migrateViewConfig(flat, defaultBoardConfig, false)
  }

  if (raw.list && typeof raw.list === 'object') {
    state.list = migrateViewConfig(raw.list as Record<string, unknown>, defaultListConfig, true)
  } else if ('groupBy' in raw) {
    const flat = raw as Record<string, unknown>
    state.list = migrateViewConfig(flat, defaultListConfig, true)
  }

  if (raw.groupActiveTasks === true && state.list.groupBy === 'none') state.list.groupBy = 'active'

  if (raw.priority === null || (typeof raw.priority === 'number' && raw.priority >= 1 && raw.priority <= 5)) state.priority = raw.priority as number | null
  if (['all', 'overdue', 'today', 'week', 'later'].includes(raw.dueDateRange as string)) state.dueDateRange = raw.dueDateRange as FilterState['dueDateRange']
  if (Array.isArray(raw.tagIds)) state.tagIds = raw.tagIds.filter((id): id is string => typeof id === 'string')

  if (raw.cardProperties && typeof raw.cardProperties === 'object') {
    const cp = raw.cardProperties as Record<string, unknown>
    state.cardProperties = { ...defaultCardProperties }
    for (const key of Object.keys(defaultCardProperties) as (keyof typeof defaultCardProperties)[]) {
      if (typeof cp[key] === 'boolean') state.cardProperties[key] = cp[key] as boolean
    }
  }

  return state
}

interface FilterStore {
  filters: Record<string, FilterState>
  loaded: Record<string, true>
  loading: Record<string, true>
  ensureLoaded: (projectId: string) => void
  setFilter: (projectId: string, filter: FilterState) => void
  flushPending: () => void
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingSaves = new Map<string, FilterState>()

function flushOne(projectId: string): void {
  const t = saveTimers.get(projectId)
  if (t) clearTimeout(t)
  saveTimers.delete(projectId)
  const pending = pendingSaves.get(projectId)
  if (pending) {
    pendingSaves.delete(projectId)
    getTrpcVanillaClient().settings.set.mutate({ key: getFilterKey(projectId), value: JSON.stringify(pending) })
  }
}

export const useFilterStore = create<FilterStore>((set, get) => ({
  filters: {},
  loaded: {},
  loading: {},
  ensureLoaded: (projectId) => {
    const s = get()
    if (s.loaded[projectId] || s.loading[projectId]) return
    set({ loading: { ...s.loading, [projectId]: true } })
    getTrpcVanillaClient().settings.get.query({ key: getFilterKey(projectId) }).then((value) => {
      let next: FilterState = defaultFilterState
      if (value) {
        try { next = migrateFilterState(JSON.parse(value)) } catch { /* keep default */ }
      }
      set((s2) => {
        const { [projectId]: _omit, ...restLoading } = s2.loading
        return {
          filters: { ...s2.filters, [projectId]: next },
          loaded: { ...s2.loaded, [projectId]: true },
          loading: restLoading,
        }
      })
    })
  },
  setFilter: (projectId, filter) => {
    set((s) => ({
      filters: { ...s.filters, [projectId]: filter },
      loaded: { ...s.loaded, [projectId]: true },
    }))
    pendingSaves.set(projectId, filter)
    const existing = saveTimers.get(projectId)
    if (existing) clearTimeout(existing)
    saveTimers.set(projectId, setTimeout(() => flushOne(projectId), 500))
  },
  flushPending: () => {
    for (const id of Array.from(saveTimers.keys())) flushOne(id)
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => useFilterStore.getState().flushPending())
}

export function useFilterState(
  projectId: string
): [FilterState, (filter: FilterState) => void] {
  const ensureLoaded = useFilterStore((s) => s.ensureLoaded)
  const setStoreFilter = useFilterStore((s) => s.setFilter)
  const filter = useFilterStore((s) => s.filters[projectId] ?? defaultFilterState)

  useEffect(() => { ensureLoaded(projectId) }, [projectId, ensureLoaded])

  const setFilter = useCallback(
    (next: FilterState) => setStoreFilter(projectId, next),
    [projectId, setStoreFilter]
  )

  return [filter, setFilter]
}

/**
 * Read-only filter state for a set of projects. Triggers loads for any
 * not-yet-loaded ids and re-renders when any tracked project's filter changes.
 */
export function useFilterStateMap(projectIds: string[]): Record<string, FilterState> {
  const ensureLoaded = useFilterStore((s) => s.ensureLoaded)
  const filters = useFilterStore((s) => s.filters)

  const key = useMemo(() => projectIds.slice().sort().join('|'), [projectIds])
  useEffect(() => {
    for (const id of projectIds) ensureLoaded(id)
  }, [key, ensureLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  return filters
}
