import { useMemo } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Label,
  buildStatusOptions,
  cn,
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/settings'

export function TreeDisplaySettings() {
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeShowSubtasks = useTabStore((s) => s.treeShowSubtasks)
  const treeShowAllSubtasks = useTabStore((s) => s.treeShowAllSubtasks)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowOnlyActive = useTabStore((s) => s.treeShowOnlyActive)
  const treeShowTemporary = useTabStore((s) => s.treeShowTemporary)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const setTreeShowStatus = useTabStore((s) => s.setTreeShowStatus)
  const setTreeShowPriority = useTabStore((s) => s.setTreeShowPriority)
  const setTreeShowSubtasks = useTabStore((s) => s.setTreeShowSubtasks)
  const setTreeShowAllSubtasks = useTabStore((s) => s.setTreeShowAllSubtasks)
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
      <PopoverContent className="w-[400px] p-3" align="start">
        <div className="space-y-6">
          {/* Tasks (plural) — list-level visibility */}
          <div className="space-y-3">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
              Tasks
            </span>
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
            <Row
              id="tree-show-subtasks"
              label="Show sub-tasks"
              hint="Render children under matching parents"
              checked={treeShowSubtasks}
              onChange={setTreeShowSubtasks}
            />
            {treeShowSubtasks && (
              <div className="pl-4 border-l border-border/40">
                <Row
                  id="tree-show-all-subtasks"
                  label="Show all sub-tasks"
                  hint="Include every descendant of a matching parent, even non-matches"
                  checked={treeShowAllSubtasks}
                  onChange={setTreeShowAllSubtasks}
                />
              </div>
            )}
          </div>

          {/* Task (singular) — per-row markers + style */}
          <div className="space-y-3">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">
              Task
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
