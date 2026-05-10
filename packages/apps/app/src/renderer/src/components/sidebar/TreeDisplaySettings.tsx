import { useMemo } from 'react'
import { SlidersHorizontal, EyeOff, ListFilter, ListTree } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Label,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  buildStatusOptions,
  cn,
} from '@slayzone/ui'
import { useTabStore, type TreeSubtaskMode } from '@slayzone/settings'

const SUBTASK_MODES: Array<{
  value: TreeSubtaskMode
  label: string
  Icon: typeof EyeOff
  tooltip: string
}> = [
  { value: 'hide', label: 'Hide', Icon: EyeOff, tooltip: 'Hide all sub-tasks' },
  { value: 'match', label: 'Match', Icon: ListFilter, tooltip: 'Show sub-tasks that pass the status filter' },
  { value: 'all', label: 'All', Icon: ListTree, tooltip: 'Show all sub-tasks of any matching parent' },
]

export function TreeDisplaySettings() {
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeSubtaskMode = useTabStore((s) => s.treeSubtaskMode)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  const treeGroupByStatus = useTabStore((s) => s.treeGroupByStatus)
  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const setTreeShowStatus = useTabStore((s) => s.setTreeShowStatus)
  const setTreeShowPriority = useTabStore((s) => s.setTreeShowPriority)
  const setTreeSubtaskMode = useTabStore((s) => s.setTreeSubtaskMode)
  const setTreeCrossOutDone = useTabStore((s) => s.setTreeCrossOutDone)
  const setTreeShowWorktree = useTabStore((s) => s.setTreeShowWorktree)
  const setTreeGroupByStatus = useTabStore((s) => s.setTreeGroupByStatus)
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
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <SlidersHorizontal className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-3" align="start">
        <div className="space-y-6">
          {/* Tasks — per-row markers + style */}
          <div className="space-y-3">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
              Tasks
            </span>
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
            <Row
              id="tree-group-by-status"
              label="Group by status"
              hint="Bucket root tasks under status headings"
              checked={treeGroupByStatus}
              onChange={setTreeGroupByStatus}
            />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span className="text-sm block">Sub-tasks</span>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5 leading-snug">
                  {treeSubtaskMode === 'hide' && 'Sub-tasks are hidden.'}
                  {treeSubtaskMode === 'match' && 'Shown only when they pass the status filter.'}
                  {treeSubtaskMode === 'all' && 'All sub-tasks of a matching parent shown.'}
                </p>
              </div>
              <div
                role="radiogroup"
                aria-label="Sub-tasks display mode"
                className="inline-flex shrink-0 rounded-md border border-input bg-input/30 p-0.5"
              >
                {SUBTASK_MODES.map(({ value, label, Icon, tooltip }) => {
                  const active = treeSubtaskMode === value
                  return (
                    <Tooltip key={value}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-label={label}
                          onClick={() => setTreeSubtaskMode(value)}
                          className={cn(
                            'inline-flex h-7 w-8 items-center justify-center rounded-sm transition-colors',
                            active
                              ? 'bg-accent text-accent-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                        >
                          <Icon className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{tooltip}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Filters — status visibility */}
          <div className="space-y-2">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
              Filters
            </span>
            <div className="flex flex-wrap gap-1">
              {statusOptions.map((opt) => {
                const Icon = opt.icon
                const checked = treeStatusFilter.includes(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggleStatus(opt.value)}
                    className={cn(
                      'group inline-flex items-center gap-1.5 rounded-full border px-2 h-7 text-xs transition-colors',
                      checked
                        ? 'border-border bg-accent/60 text-foreground hover:border-foreground/40'
                        : 'border-transparent bg-input/30 text-muted-foreground/70 hover:text-foreground hover:border-border'
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-3.5 shrink-0 transition-opacity',
                        checked ? opt.iconClass : 'opacity-50'
                      )}
                    />
                    <span>{opt.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
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
    <div className={`flex items-start justify-between gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-sm cursor-pointer block">
          {label}
        </Label>
        <p className="text-[11px] text-muted-foreground/70 mt-0.5 leading-snug">{hint}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="mt-0.5 shrink-0"
      />
    </div>
  )
}
