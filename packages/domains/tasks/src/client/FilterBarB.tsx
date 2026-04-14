import type { Tag } from '@slayzone/tags/shared'
import { resolveColumns, type ColumnConfig } from '@slayzone/projects/shared'
import type { FilterState, GroupKey, DueDateRange, SortKey, ViewMode, ViewConfig } from './FilterState'
import { getViewConfig } from './FilterState'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { Switch } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { ListFilter, SlidersHorizontal, LayoutList, Kanban } from 'lucide-react'
import { track } from '@slayzone/telemetry/client'

interface FilterBarBProps {
  filter: FilterState
  onChange: (f: FilterState) => void
  tags: Tag[]
  columns?: ColumnConfig[] | null
}

const PRIORITY_OPTIONS = [
  { value: '1', label: 'Urgent' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Medium' },
  { value: '4', label: 'Low' },
  { value: '5', label: 'None' }
]

const DUE_DATE_OPTIONS: { value: DueDateRange; label: string }[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'later', label: 'Later' }
]

const GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'due_date', label: 'Due Date' }
]

const LIST_GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: 'none', label: 'No groups' },
  { value: 'active', label: 'Activity' },
  ...GROUP_OPTIONS
]

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'priority', label: 'Priority' },
  { value: 'due_date', label: 'Due date' },
  { value: 'title', label: 'Title' },
  { value: 'created', label: 'Newest first' }
]


export function FilterBarB({ filter, onChange, tags, columns }: FilterBarBProps): React.JSX.Element {
  const activeFilterCount =
    (filter.priority !== null ? 1 : 0) +
    (filter.dueDateRange !== 'all' ? 1 : 0) +
    (filter.tagIds.length > 0 ? 1 : 0)

  const isList = filter.viewMode === 'list'
  const vc = getViewConfig(filter)
  const groupOptions = isList ? LIST_GROUP_OPTIONS : GROUP_OPTIONS

  /** Update the active view's config */
  const setVc = (updates: Partial<ViewConfig>) => {
    onChange({ ...filter, [filter.viewMode]: { ...vc, ...updates } })
  }

  return (
    <div className="flex items-center gap-1">
        {/* ──────── Filter Popover ──────── */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={`h-7 gap-1.5 px-2 text-xs font-medium ${activeFilterCount > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              <ListFilter className="size-3.5" />
              Filter
              {activeFilterCount > 0 && (
                <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3" align="end">
            <div className="space-y-3">
              {/* Priority — multi-select pills */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Priority</span>
                <div className="flex gap-1.5">
                  {PRIORITY_OPTIONS.map((opt) => {
                    const isActive = filter.priority === parseInt(opt.value, 10)
                    return (
                      <button
                        key={opt.value}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                          isActive
                            ? 'bg-foreground text-background'
                            : 'border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent'
                        }`}
                        onClick={() => {
                          track('filter_applied', { type: 'priority' })
                          onChange({ ...filter, priority: isActive ? null : parseInt(opt.value, 10) })
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Due date — pills */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Due date</span>
                <div className="flex gap-1.5">
                  {DUE_DATE_OPTIONS.map((opt) => {
                    const isActive = filter.dueDateRange === opt.value
                    return (
                      <button
                        key={opt.value}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                          isActive
                            ? 'bg-foreground text-background'
                            : 'border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent'
                        }`}
                        onClick={() => {
                          track('filter_applied', { type: 'due_date' })
                          onChange({ ...filter, dueDateRange: isActive ? 'all' : opt.value })
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Tags — toggle pills */}
              {tags.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Tags</span>
                  <div className="flex gap-1.5">
                    {tags.map((tag) => {
                      const isActive = filter.tagIds.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                            isActive
                              ? 'bg-foreground text-background'
                              : 'border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent'
                          }`}
                          onClick={() => {
                            track('filter_applied', { type: 'tag' })
                            const tagIds = isActive
                              ? filter.tagIds.filter((id) => id !== tag.id)
                              : [...filter.tagIds, tag.id]
                            onChange({ ...filter, tagIds })
                          }}
                        >
                          <span
                            className="size-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: tag.color }}
                          />
                          {tag.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Reset */}
              {activeFilterCount > 0 && (
                <>
                  <div className="h-px bg-border" />
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => onChange({ ...filter, priority: null, dueDateRange: 'all', tagIds: [] })}
                  >
                    Reset filters
                  </button>
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>

        <div className="h-4 w-px bg-border" />

        {/* ──────── Display Popover ──────── */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground">
              <SlidersHorizontal className="size-3.5" />
              Display
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="end">
            <div className="space-y-8">
              {/* View mode toggle */}
              <div className="grid grid-cols-2 rounded-md border border-border/50 p-0.5 gap-0.5">
                {([
                  { value: 'list' as ViewMode, icon: LayoutList, label: 'List' },
                  { value: 'board' as ViewMode, icon: Kanban, label: 'Board' }
                ]).map(({ value, icon: Icon, label }) => {
                  const isActive = filter.viewMode === value
                  return (
                    <button
                      key={value}
                      className={`flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium rounded transition-colors ${
                        isActive
                          ? 'bg-foreground text-background'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                      }`}
                      onClick={() => onChange({ ...filter, viewMode: value })}
                    >
                      <Icon className="size-5" />
                      {label}
                    </button>
                  )
                })}
              </div>

              {/* Grouping & Ordering */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Grouping</Label>
                  <Select value={vc.groupBy} onValueChange={(v) => setVc({ groupBy: v as GroupKey })}>
                    <SelectTrigger size="sm" className="h-7 w-30 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {groupOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Ordering</Label>
                  <Select value={vc.sortBy} onValueChange={(v) => setVc({ sortBy: v as SortKey })}>
                    <SelectTrigger size="sm" className="h-7 w-30 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SORT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Tasks */}
              <div className="space-y-3">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">Tasks</span>
                <div className="flex items-center justify-between">
                  <Label htmlFor="display-completed" className="text-sm cursor-pointer">Show completed</Label>
                  <Switch id="display-completed" checked={vc.completedFilter === 'all'} onCheckedChange={(v) => setVc({ completedFilter: v ? 'all' : 'none' })} />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="display-archived" className="text-sm cursor-pointer">Show archived</Label>
                  <Switch id="display-archived" checked={vc.showArchived} onCheckedChange={(v) => setVc({ showArchived: v })} />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="display-subtasks" className="text-sm cursor-pointer">Show sub-tasks</Label>
                  <Switch id="display-subtasks" checked={vc.showSubTasks} onCheckedChange={(v) => setVc({ showSubTasks: v })} />
                </div>
              </div>

              {/* Columns */}
              <div className="space-y-3">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3 block">{isList ? 'Groups' : 'Columns'}</span>
                <div className="flex items-center justify-between">
                  <Label htmlFor="display-empty-cols" className="text-sm cursor-pointer">{isList ? 'Show empty groups' : 'Show empty columns'}</Label>
                  <Switch id="display-empty-cols" checked={vc.showEmptyColumns} onCheckedChange={(v) => setVc({ showEmptyColumns: v })} />
                </div>
                {(() => {
                  const positionOptions = resolveColumns(columns)
                  return [
                    { key: 'showBlockedColumn' as const, afterKey: 'blockedColumnAfter' as const, label: 'blocked' },
                    { key: 'showSnoozedColumn' as const, afterKey: 'snoozedColumnAfter' as const, label: 'snoozed' }
                  ].map(({ key, afterKey, label }) => {
                    const enabled = vc[key]
                    const afterId = vc[afterKey]
                    return (
                      <div key={key} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label htmlFor={`display-${label}`} className="text-sm cursor-pointer">Show {label}</Label>
                          <Switch id={`display-${label}`} checked={enabled} onCheckedChange={(v) => setVc({ [key]: v })} />
                        </div>
                        {enabled && (
                          <div className="flex items-center justify-between pl-4">
                            <Label className="text-xs text-muted-foreground">Position after</Label>
                            <Select
                              value={afterId ?? '__default__'}
                              onValueChange={(v) => setVc({ [afterKey]: v === '__default__' ? null : v })}
                            >
                              <SelectTrigger size="sm" className="h-7 w-30 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__default__">Default</SelectItem>
                                {positionOptions.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
          </PopoverContent>
        </Popover>
    </div>
  )
}
