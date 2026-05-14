import { useMemo } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Label,
  buildStatusOptions,
  cn,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@slayzone/ui'
import { useTabStore, type TreeGroupBy, type TreeOrderBy, type TreeOrderDir } from '@slayzone/settings'

export function TreeDisplaySettings() {
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeShowSubtasks = useTabStore((s) => s.treeShowSubtasks)
  const treeShowAllSubtasks = useTabStore((s) => s.treeShowAllSubtasks)
  const treeShowAllUndoneSubtasks = useTabStore((s) => s.treeShowAllUndoneSubtasks)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowOnlyActive = useTabStore((s) => s.treeShowOnlyActive)
  const treeShowTemporary = useTabStore((s) => s.treeShowTemporary)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const treeGroupBy = useTabStore((s) => s.treeGroupBy)
  const treeOrderBy = useTabStore((s) => s.treeOrderBy)
  const treeOrderDir = useTabStore((s) => s.treeOrderDir)
  const treeGroupTemporary = useTabStore((s) => s.treeGroupTemporary)
  const treeShowEmptyGroups = useTabStore((s) => s.treeShowEmptyGroups)
  const setTreeGroupBy = useTabStore((s) => s.setTreeGroupBy)
  const setTreeOrderBy = useTabStore((s) => s.setTreeOrderBy)
  const setTreeOrderDir = useTabStore((s) => s.setTreeOrderDir)
  const setTreeGroupTemporary = useTabStore((s) => s.setTreeGroupTemporary)
  const setTreeShowEmptyGroups = useTabStore((s) => s.setTreeShowEmptyGroups)
  const setTreeShowStatus = useTabStore((s) => s.setTreeShowStatus)
  const setTreeShowPriority = useTabStore((s) => s.setTreeShowPriority)
  const setTreeShowSubtasks = useTabStore((s) => s.setTreeShowSubtasks)
  const setTreeShowAllSubtasks = useTabStore((s) => s.setTreeShowAllSubtasks)
  const setTreeShowAllUndoneSubtasks = useTabStore((s) => s.setTreeShowAllUndoneSubtasks)
  const setTreeCrossOutDone = useTabStore((s) => s.setTreeCrossOutDone)
  const setTreeShowOnlyActive = useTabStore((s) => s.setTreeShowOnlyActive)
  const setTreeShowTemporary = useTabStore((s) => s.setTreeShowTemporary)
  const setTreeShowWorktree = useTabStore((s) => s.setTreeShowWorktree)
  const setTreeStatusFilter = useTabStore((s) => s.setTreeStatusFilter)

  const statusOptions = useMemo(() => buildStatusOptions(null), [])
  const toggleStatus = (value: string) => {
    setTreeStatusFilter(
      treeStatusFilter.includes(value)
        ? treeStatusFilter.filter((s) => s !== value)
        : [...treeStatusFilter, value]
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="View settings"
          title="View settings"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <SlidersHorizontal className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[400px] p-3 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
        side="right"
        align="start"
      >
        <div className="space-y-8">
          {/* Groups — bucketing & ordering (decoupled from kanban) */}
          <div className="space-y-3">
            <SectionHeader>Groups</SectionHeader>
            <SelectRow
              id="tree-group-by"
              label="Group by"
              hint="How root tasks are bucketed into sections"
              value={treeGroupBy}
              onChange={(v) => setTreeGroupBy(v as TreeGroupBy)}
              options={[
                { value: 'status', label: 'Status' },
                { value: 'priority', label: 'Priority' },
              ]}
            />
            <SelectRow
              id="tree-order-by"
              label="Order by"
              hint="Row order within each group"
              value={treeOrderBy}
              onChange={(v) => setTreeOrderBy(v as TreeOrderBy)}
              options={[
                { value: 'manual', label: 'Manual' },
                { value: 'priority', label: 'Priority' },
                { value: 'due_date', label: 'Due date' },
                { value: 'title', label: 'Title' },
                { value: 'created', label: 'Created' },
              ]}
            />
            <SelectRow
              id="tree-order-dir"
              label="Order direction"
              hint="Ascending or descending"
              value={treeOrderDir}
              onChange={(v) => setTreeOrderDir(v as TreeOrderDir)}
              options={[
                { value: 'asc', label: 'Ascending' },
                { value: 'desc', label: 'Descending' },
              ]}
            />
            <Row
              id="tree-show-empty-groups"
              label="Show empty groups"
              hint="Render section headers even when the group has no tasks"
              checked={treeShowEmptyGroups}
              onChange={setTreeShowEmptyGroups}
            />
          </div>

          {/* Tasks (plural) — list-level visibility */}
          <div className="space-y-3">
            <SectionHeader>Tasks</SectionHeader>
            <Row
              id="tree-show-only-active"
              label="Show only active"
              hint="Only tasks with an active PTY or chat session"
              checked={treeShowOnlyActive}
              onChange={setTreeShowOnlyActive}
            />
            <Row
              id="tree-show-temporary"
              label="Show temporary"
              hint="Include temporary scratch tasks"
              checked={treeShowTemporary}
              onChange={setTreeShowTemporary}
            />
            {treeShowTemporary && (
              <div className="pl-4 border-l border-border/40 space-y-3">
                <Row
                  id="tree-group-temporary"
                  label="Group temporary tasks"
                  hint="Show temporary tasks in their own section at the top"
                  checked={treeGroupTemporary}
                  onChange={setTreeGroupTemporary}
                />
              </div>
            )}
            <Row
              id="tree-show-subtasks"
              label="Show sub-tasks"
              hint="Render children under matching parents"
              checked={treeShowSubtasks}
              onChange={setTreeShowSubtasks}
            />
            {treeShowSubtasks && (
              <div className="pl-4 border-l border-border/40 space-y-3">
                <Row
                  id="tree-show-all-subtasks"
                  label="Show all sub-tasks"
                  hint="Include every descendant of a matching parent, even non-matches"
                  checked={treeShowAllSubtasks}
                  onChange={setTreeShowAllSubtasks}
                />
                <Row
                  id="tree-show-all-undone-subtasks"
                  label="Show all undone sub-tasks"
                  hint="Include every non-completed descendant of a matching parent"
                  checked={treeShowAllUndoneSubtasks}
                  onChange={setTreeShowAllUndoneSubtasks}
                  disabled={treeShowAllSubtasks}
                />
              </div>
            )}
          </div>

          {/* Task (singular) — per-row markers + style */}
          <div className="space-y-3">
            <SectionHeader>Task</SectionHeader>
            <Row
              id="tree-show-status"
              label="Show status"
              hint="Status icon after the title"
              checked={treeShowStatus}
              onChange={setTreeShowStatus}
            />
            <Row
              id="tree-show-priority"
              label="Show priority"
              hint="Priority icon after the title"
              checked={treeShowPriority}
              onChange={setTreeShowPriority}
            />
            <Row
              id="tree-show-worktree"
              label="Show worktree"
              hint="Branch icon when task has a worktree"
              checked={treeShowWorktree}
              onChange={setTreeShowWorktree}
            />
            <Row
              id="tree-cross-out-done"
              label="Cross out completed"
              hint="Strikethrough done tasks"
              checked={treeCrossOutDone}
              onChange={setTreeCrossOutDone}
            />
          </div>

          <FiltersSection
            statusOptions={statusOptions}
            selected={treeStatusFilter}
            onToggle={toggleStatus}
          />

        </div>
      </PopoverContent>
    </Popover>
  )
}

type StatusOpt = ReturnType<typeof buildStatusOptions>[number]

function FiltersSection({
  statusOptions,
  selected,
  onToggle,
}: {
  statusOptions: StatusOpt[]
  selected: string[]
  onToggle: (v: string) => void
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected])
  return (
    <div className="space-y-2">
      <SectionHeader>Filters</SectionHeader>
      <div className="flex flex-wrap gap-1">
        {statusOptions.map((opt) => {
          const Icon = opt.icon
          const checked = selectedSet.has(opt.value)
          const buttonInner = (
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={opt.label}
              onClick={() => onToggle(opt.value)}
              className={cn(
                'inline-flex items-center justify-center rounded-md border transition-colors',
                checked
                  ? 'border-border bg-accent/60 text-foreground hover:border-foreground/40 gap-1.5 px-2 h-7 text-xs'
                  : 'border-transparent bg-input/30 text-muted-foreground/70 hover:text-foreground hover:border-border size-7'
              )}
            >
              <Icon className={cn('size-3.5 shrink-0', checked ? opt.iconClass : 'opacity-50')} />
              {checked && <span>{opt.label}</span>}
            </button>
          )
          // Tooltip only for inactive (icon-only) state.
          if (checked) return <span key={opt.value}>{buttonInner}</span>
          return (
            <Tooltip key={opt.value} delayDuration={300}>
              <TooltipTrigger asChild>{buttonInner}</TooltipTrigger>
              <TooltipContent side="top">{opt.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
      {children}
    </span>
  )
}

function Row({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <Label htmlFor={id} className="text-sm cursor-pointer min-w-0 flex-1" title={hint}>
        {label}
      </Label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="shrink-0"
      />
    </div>
  )
}

function SelectRow({
  id,
  label,
  hint,
  value,
  onChange,
  options,
}: {
  id: string
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sm min-w-0 flex-1" title={hint}>
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          size="sm"
          className="!h-6 !min-h-0 w-[120px] px-2 py-0 text-xs shrink-0 gap-1"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
