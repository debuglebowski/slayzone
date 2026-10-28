import { useMemo } from 'react'
import {
  Info,
  AlignLeft,
  AlignRight,
  PanelLeft,
  PanelRight,
  Rows3,
  Menu,
  type LucideIcon
} from 'lucide-react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Switch,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  buildStatusOptions,
  cn
} from '@slayzone/ui'
import { useTabStore } from '@slayzone/tabs-state'
import type {
  TreeGroupBy,
  TreeOrderBy,
  TreeOrderDir,
  TaskHeaderPanelMode,
  TaskHeaderAlign
} from '@slayzone/tabs-state'
import { SettingsTabIntro } from './SettingsTabIntro'

const SIDEBAR_VIEWS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'projects', label: 'Projects' },
  { value: 'tree', label: 'Tree' }
]

function SettingLabel({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <span className="text-sm flex items-center gap-1.5">
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="size-3 text-muted-foreground/50 hover:text-muted-foreground shrink-0 cursor-default" />
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs leading-relaxed">
          {tip}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

function Row({ label, tip, children }: { label: string; tip: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
      <SettingLabel tip={tip}>{label}</SettingLabel>
      {children}
    </div>
  )
}

function ToggleRow({
  label,
  tip,
  checked,
  onChange,
  disabled
}: {
  label: string
  tip: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Row label={label} tip={tip}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </Row>
  )
}

function ButtonToggle({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: ReadonlyArray<{ value: string; label: string; icon?: LucideIcon }>
}) {
  return (
    <div className="inline-flex w-fit justify-self-start items-center rounded-md border border-input bg-input/30 p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function SelectChoice({
  value,
  onChange,
  options,
  width = 'w-48'
}: {
  value: string
  onChange: (v: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  width?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={width}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" side="bottom" className="max-h-none">
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function LayoutSettingsTab() {
  const sidebarView = useTabStore((s) => s.sidebarView)
  const setSidebarView = useTabStore((s) => s.setSidebarView)
  const sidebarAutoHide = useTabStore((s) => s.sidebarAutoHide)
  const setSidebarAutoHide = useTabStore((s) => s.setSidebarAutoHide)

  const taskHeaderPanelMode = useTabStore((s) => s.taskHeaderPanelMode)
  const setTaskHeaderPanelMode = useTabStore((s) => s.setTaskHeaderPanelMode)
  const taskHeaderPanelAlign = useTabStore((s) => s.taskHeaderPanelAlign)
  const setTaskHeaderPanelAlign = useTabStore((s) => s.setTaskHeaderPanelAlign)
  const taskHeaderTitleAlign = useTabStore((s) => s.taskHeaderTitleAlign)
  const setTaskHeaderTitleAlign = useTabStore((s) => s.setTaskHeaderTitleAlign)

  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeShowSubtasks = useTabStore((s) => s.treeShowSubtasks)
  const treeShowAllSubtasks = useTabStore((s) => s.treeShowAllSubtasks)
  const treeShowAllUndoneSubtasks = useTabStore((s) => s.treeShowAllUndoneSubtasks)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowOnlyActive = useTabStore((s) => s.treeShowOnlyActive)
  const treeShowTemporary = useTabStore((s) => s.treeShowTemporary)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  const treeShowTags = useTabStore((s) => s.treeShowTags)
  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const treeGroupBy = useTabStore((s) => s.treeGroupBy)
  const treeOrderBy = useTabStore((s) => s.treeOrderBy)
  const treeOrderDir = useTabStore((s) => s.treeOrderDir)
  const treeGroupTemporary = useTabStore((s) => s.treeGroupTemporary)
  const treeGroupPinned = useTabStore((s) => s.treeGroupPinned)
  const treeShowEmptyGroups = useTabStore((s) => s.treeShowEmptyGroups)
  const setTreeGroupBy = useTabStore((s) => s.setTreeGroupBy)
  const setTreeOrderBy = useTabStore((s) => s.setTreeOrderBy)
  const setTreeOrderDir = useTabStore((s) => s.setTreeOrderDir)
  const setTreeGroupTemporary = useTabStore((s) => s.setTreeGroupTemporary)
  const setTreeGroupPinned = useTabStore((s) => s.setTreeGroupPinned)
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
  const setTreeShowTags = useTabStore((s) => s.setTreeShowTags)
  const setTreeStatusFilter = useTabStore((s) => s.setTreeStatusFilter)

  const statusOptions = useMemo(() => buildStatusOptions(null), [])
  const selectedStatusSet = useMemo(() => new Set(treeStatusFilter), [treeStatusFilter])
  const toggleStatus = (value: string) => {
    setTreeStatusFilter(
      treeStatusFilter.includes(value)
        ? treeStatusFilter.filter((s) => s !== value)
        : [...treeStatusFilter, value]
    )
  }

  const isTree = sidebarView === 'tree'

  return (
    <>
      <SettingsTabIntro
        title="Layout"
        description="Pick the sidebar view and tune how it lists projects and tasks."
      />

      {/* Sidebar */}
      <Card>
        <CardHeader>
          <CardTitle>Sidebar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Row label="View" tip="Choose between the Projects rail or the Tree task list">
            <SelectChoice value={sidebarView} onChange={setSidebarView} options={SIDEBAR_VIEWS} />
          </Row>
          <ToggleRow
            label="Auto-hide"
            tip="Collapse the sidebar to a hover-revealed floating panel"
            checked={sidebarAutoHide}
            onChange={setSidebarAutoHide}
          />
        </CardContent>
      </Card>

      {/* Task header */}
      <Card>
        <CardHeader>
          <CardTitle>Task header</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Row label="Panel toggle mode" tip="Tabs row or a compact icon menu">
            <ButtonToggle
              value={taskHeaderPanelMode}
              onChange={(v) => setTaskHeaderPanelMode(v as TaskHeaderPanelMode)}
              options={[
                { value: 'tabs', label: 'Tabs', icon: Rows3 },
                { value: 'menu', label: 'Menu', icon: Menu }
              ]}
            />
          </Row>
          <Row label="Panel toggle alignment" tip="Where the panel toggle sits in the header">
            <ButtonToggle
              value={taskHeaderPanelAlign}
              onChange={(v) => setTaskHeaderPanelAlign(v as TaskHeaderAlign)}
              options={[
                { value: 'left', label: 'Left', icon: PanelLeft },
                { value: 'right', label: 'Right', icon: PanelRight }
              ]}
            />
          </Row>
          <Row label="Title alignment" tip="Where the task title sits in the header">
            <ButtonToggle
              value={taskHeaderTitleAlign}
              onChange={(v) => setTaskHeaderTitleAlign(v as TaskHeaderAlign)}
              options={[
                { value: 'left', label: 'Left', icon: AlignLeft },
                { value: 'right', label: 'Right', icon: AlignRight }
              ]}
            />
          </Row>
        </CardContent>
      </Card>

      {/* Tree view */}
      {isTree && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Groups</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Group by" tip="How root tasks are bucketed into sections">
                <SelectChoice
                  value={treeGroupBy}
                  onChange={(v) => setTreeGroupBy(v as TreeGroupBy)}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'status', label: 'Status' },
                    { value: 'priority', label: 'Priority' }
                  ]}
                />
              </Row>
              <Row label="Order by" tip="Row order within each group">
                <SelectChoice
                  value={treeOrderBy}
                  onChange={(v) => setTreeOrderBy(v as TreeOrderBy)}
                  options={[
                    { value: 'manual', label: 'Manual' },
                    { value: 'priority', label: 'Priority' },
                    { value: 'due_date', label: 'Due date' },
                    { value: 'title', label: 'Title' },
                    { value: 'created', label: 'Created' },
                    { value: 'last_interaction', label: 'Last interaction' }
                  ]}
                />
              </Row>
              <Row label="Order direction" tip="Ascending or descending">
                <SelectChoice
                  value={treeOrderDir}
                  onChange={(v) => setTreeOrderDir(v as TreeOrderDir)}
                  options={[
                    { value: 'asc', label: 'Ascending' },
                    { value: 'desc', label: 'Descending' }
                  ]}
                  width="w-32"
                />
              </Row>
              <ToggleRow
                label="Show empty groups"
                tip="Render section headers even when the group has no tasks"
                checked={treeShowEmptyGroups}
                onChange={setTreeShowEmptyGroups}
              />
              <ToggleRow
                label="Group pinned tasks"
                tip="Show pinned tasks in their own section at the top"
                checked={treeGroupPinned}
                onChange={setTreeGroupPinned}
              />
              <ToggleRow
                label="Group temporary tasks"
                tip="Show temporary tasks in their own section at the top"
                checked={treeGroupTemporary}
                onChange={setTreeGroupTemporary}
              />
            </CardContent>
          </Card>

          {/* Tasks */}
          <Card>
            <CardHeader>
              <CardTitle>Tasks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <ToggleRow
                label="Show only active"
                tip="Only tasks with an active PTY or chat session"
                checked={treeShowOnlyActive}
                onChange={setTreeShowOnlyActive}
              />
              <ToggleRow
                label="Show temporary"
                tip="Include temporary scratch tasks"
                checked={treeShowTemporary}
                onChange={setTreeShowTemporary}
              />
              <ToggleRow
                label="Show sub-tasks"
                tip="Render children under matching parents"
                checked={treeShowSubtasks}
                onChange={setTreeShowSubtasks}
              />
              {treeShowSubtasks && (
                <div className="pl-4 border-l border-border/40 space-y-3">
                  <ToggleRow
                    label="Show all sub-tasks"
                    tip="Include every descendant of a matching parent, even non-matches"
                    checked={treeShowAllSubtasks}
                    onChange={setTreeShowAllSubtasks}
                  />
                  <ToggleRow
                    label="Show all undone sub-tasks"
                    tip="Include every non-completed descendant of a matching parent"
                    checked={treeShowAllUndoneSubtasks}
                    onChange={setTreeShowAllUndoneSubtasks}
                    disabled={treeShowAllSubtasks}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Task row */}
          <Card>
            <CardHeader>
              <CardTitle>Task</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <ToggleRow
                label="Show status"
                tip="Status icon after the title"
                checked={treeShowStatus}
                onChange={setTreeShowStatus}
              />
              <ToggleRow
                label="Show priority"
                tip="Priority icon after the title"
                checked={treeShowPriority}
                onChange={setTreeShowPriority}
              />
              <ToggleRow
                label="Show worktree"
                tip="Branch icon when task has a worktree"
                checked={treeShowWorktree}
                onChange={setTreeShowWorktree}
              />
              <ToggleRow
                label="Show tags"
                tip="Tag chips after the title"
                checked={treeShowTags}
                onChange={setTreeShowTags}
              />
              <ToggleRow
                label="Cross out completed"
                tip="Strikethrough done tasks"
                checked={treeCrossOutDone}
                onChange={setTreeCrossOutDone}
              />
            </CardContent>
          </Card>

          {/* Filters */}
          <Card>
            <CardHeader>
              <CardTitle>Filters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground/80 leading-snug">
                Limit by status. Pinned and open tasks always show.
              </p>
              <div className="flex flex-wrap gap-1">
                {statusOptions.map((opt) => {
                  const Icon = opt.icon
                  const checked = selectedStatusSet.has(opt.value)
                  const button = (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={opt.label}
                      onClick={() => toggleStatus(opt.value)}
                      className={cn(
                        'inline-flex items-center justify-center rounded-md border transition-colors',
                        checked
                          ? 'border-border bg-accent/60 text-foreground hover:border-foreground/40 gap-1.5 px-2 h-7 text-xs'
                          : 'border-transparent bg-input/30 text-muted-foreground/70 hover:text-foreground hover:border-border size-7'
                      )}
                    >
                      <Icon
                        className={cn('size-3.5 shrink-0', checked ? opt.iconClass : 'opacity-50')}
                      />
                      {checked && <span>{opt.label}</span>}
                    </button>
                  )
                  if (checked) return <span key={opt.value}>{button}</span>
                  return (
                    <Tooltip key={opt.value} delayDuration={300}>
                      <TooltipTrigger asChild>{button}</TooltipTrigger>
                      <TooltipContent side="top">{opt.label}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  )
}
