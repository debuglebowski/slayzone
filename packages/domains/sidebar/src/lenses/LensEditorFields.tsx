import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import {
  buildStatusOptions,
  cn,
  Label,
  PriorityIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '@slayzone/ui'
import { PRIORITY_LABELS } from '@slayzone/tasks'
import {
  useTabStore,
  type LensGroup,
  type LensLook,
  type TreeGroupBy,
  type TreeOrderBy,
  type TreeOrderDir
} from '@slayzone/tabs-state'
import { LensRowPreview } from './LensRowPreview'
import type { LensEditorTab } from './lens-editor-store'

/**
 * The lens editor's settings, in three sections (Structure / What to show / How rows
 * look). Every control edits the LIVE sidebar fields, so the sidebar previews each
 * change at once; the dialog or settings page saves them into the lens.
 *
 * Together these reach every tree display setting the old display popover had.
 */
export function LensEditorSection({ section }: { section: LensEditorTab }): React.JSX.Element {
  if (section === 'structure') return <StructureSection />
  if (section === 'show') return <ShowSection />
  return <RowsSection />
}

const STATUS_OPTIONS = buildStatusOptions(null)
const PRIORITIES = [1, 2, 3, 4, 5] as const

function StructureSection(): React.JSX.Element {
  const group = useTabStore((s) => s.treeLensGroup)
  const look = useTabStore((s) => s.treeLensLook)
  const groupBy = useTabStore((s) => s.treeGroupBy)
  const showAll = useTabStore((s) => s.treeShowAllProjects)
  const needsYou = useTabStore((s) => s.treeNeedsYou)
  const orderBy = useTabStore((s) => s.treeOrderBy)
  const orderDir = useTabStore((s) => s.treeOrderDir)
  const st = useTabStore.getState
  return (
    <div className="space-y-4" data-testid="lens-section-structure">
      <Line label="Group by">
        <Seg<LensGroup>
          label="Group by"
          value={group}
          onChange={(v) => st().setTreeLensGroup(v)}
          options={[
            ['project', 'Project'],
            ['agent', 'Agent'],
            ['status', 'Status'],
            ['recent', 'Recent']
          ]}
        />
      </Line>
      {group === 'project' && (
        <>
          <Line label="Look">
            <Seg<LensLook>
              label="Look"
              value={look}
              onChange={(v) => st().setTreeLensLook(v)}
              options={[
                ['cards', 'Cards'],
                ['flat', 'Flat'],
                ['accordion', 'Accordion'],
                ['dense', 'Dense']
              ]}
            />
          </Line>
          <Line label="Inside projects" hint="How root tasks are bucketed in each project">
            <Seg<TreeGroupBy>
              label="Inside projects"
              value={groupBy}
              onChange={(v) => st().setTreeGroupBy(v)}
              options={[
                ['status', 'Status'],
                ['priority', 'Priority'],
                ['none', 'None']
              ]}
            />
          </Line>
        </>
      )}
      <Line label="Projects">
        <Seg<'active' | 'all'>
          label="Projects"
          value={showAll ? 'all' : 'active'}
          onChange={(v) => st().setTreeShowAllProjects(v === 'all')}
          options={[
            ['active', 'Active & starred'],
            ['all', 'All']
          ]}
        />
      </Line>
      <SwitchLine
        id="lens-needs-you"
        label="“Needs you” at the top"
        hint="Tasks waiting for you, from every project"
        checked={needsYou}
        onChange={(v) => st().setTreeNeedsYou(v)}
      />
      <Line label="Order by" hint="Row order within each group">
        <div className="flex items-center gap-2">
          <Select value={orderBy} onValueChange={(v) => st().setTreeOrderBy(v as TreeOrderBy)}>
            <SelectTrigger
              aria-label="Order by"
              size="sm"
              className="!h-7 !min-h-0 w-[150px] gap-1 px-2 py-0 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                [
                  ['manual', 'Manual'],
                  ['priority', 'Priority'],
                  ['due_date', 'Due date'],
                  ['title', 'Title'],
                  ['created', 'Created'],
                  ['last_interaction', 'Last interaction']
                ] as const
              ).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Seg<TreeOrderDir>
            label="Order direction"
            value={orderDir}
            onChange={(v) => st().setTreeOrderDir(v)}
            options={[
              ['asc', 'Asc'],
              ['desc', 'Desc']
            ]}
          />
        </div>
      </Line>
    </div>
  )
}

function ShowSection(): React.JSX.Element {
  const onlyActive = useTabStore((s) => s.treeShowOnlyActive)
  const allOpen = useTabStore((s) => s.treeShowAllOpen)
  const showTemp = useTabStore((s) => s.treeShowTemporary)
  const showBlocked = useTabStore((s) => s.treeShowBlocked)
  const showSnoozed = useTabStore((s) => s.treeShowSnoozed)
  const showSub = useTabStore((s) => s.treeShowSubtasks)
  const allSub = useTabStore((s) => s.treeShowAllSubtasks)
  const allUndoneSub = useTabStore((s) => s.treeShowAllUndoneSubtasks)
  const groupPinned = useTabStore((s) => s.treeGroupPinned)
  const groupBlocked = useTabStore((s) => s.treeGroupBlocked)
  const groupTemp = useTabStore((s) => s.treeGroupTemporary)
  const showEmpty = useTabStore((s) => s.treeShowEmptyGroups)
  const statusFilter = useTabStore((s) => s.treeStatusFilter)
  const priorityFilter = useTabStore((s) => s.treePriorityFilter)
  const st = useTabStore.getState
  const subMode = allSub ? 'all' : allUndoneSub ? 'undone' : 'matching'
  return (
    <div className="space-y-4" data-testid="lens-section-show">
      <Line label="Tasks" hint="Only tasks with an active agent session (or pinned)">
        <Seg<'all' | 'active'>
          label="Tasks"
          value={onlyActive ? 'active' : 'all'}
          onChange={(v) => st().setTreeShowOnlyActive(v === 'active')}
          options={[
            ['all', 'Everything'],
            ['active', 'Only running agents']
          ]}
        />
      </Line>
      <Line label="Open tabs" hint="Tasks with an open tab, regardless of filters">
        <Seg<'always' | 'filters'>
          label="Open tabs"
          value={allOpen ? 'always' : 'filters'}
          onChange={(v) => st().setTreeShowAllOpen(v === 'always')}
          options={[
            ['always', 'Always show'],
            ['filters', 'Follow filters']
          ]}
        />
      </Line>
      <Column label="Include">
        <Chip
          label="Temporary"
          aria="Show temporary"
          on={showTemp}
          onChange={(v) => st().setTreeShowTemporary(v)}
        />
        <Chip
          label="Blocked"
          aria="Show blocked"
          on={showBlocked}
          onChange={(v) => st().setTreeShowBlocked(v)}
        />
        <Chip
          label="Snoozed"
          aria="Show snoozed"
          on={showSnoozed}
          onChange={(v) => st().setTreeShowSnoozed(v)}
        />
        <Chip
          label="Sub-tasks"
          aria="Show sub-tasks"
          on={showSub}
          onChange={(v) => st().setTreeShowSubtasks(v)}
        />
      </Column>
      {showSub && (
        <Line label="Sub-tasks of a match" hint="Which descendants of a matching parent show">
          <Seg<'matching' | 'undone' | 'all'>
            label="Sub-tasks of a match"
            value={subMode}
            onChange={(v) => {
              st().setTreeShowAllSubtasks(v === 'all')
              st().setTreeShowAllUndoneSubtasks(v === 'undone')
            }}
            options={[
              ['matching', 'Matching'],
              ['undone', 'All undone'],
              ['all', 'All']
            ]}
          />
        </Line>
      )}
      <Column label="Own group for">
        <Chip
          label="Pinned"
          aria="Group pinned tasks"
          on={groupPinned}
          onChange={(v) => st().setTreeGroupPinned(v)}
        />
        <Chip
          label="Blocked"
          aria="Group blocked tasks"
          on={groupBlocked}
          onChange={(v) => st().setTreeGroupBlocked(v)}
        />
        <Chip
          label="Temporary"
          aria="Group temporary tasks"
          on={groupTemp}
          onChange={(v) => st().setTreeGroupTemporary(v)}
        />
      </Column>
      <SwitchLine
        id="lens-show-empty-groups"
        label="Show empty groups"
        hint="Section headers even when the group has no tasks"
        checked={showEmpty}
        onChange={(v) => st().setTreeShowEmptyGroups(v)}
      />
      <Column
        label="Only these statuses"
        hint="Pinned tasks and active sessions show regardless of status"
      >
        {STATUS_OPTIONS.map((opt) => {
          const Icon = opt.icon
          const on = statusFilter.includes(opt.value)
          return (
            <Chip
              key={opt.value}
              label={opt.label}
              aria={`Status ${opt.label}`}
              icon={<Icon className={cn('size-3.5', on ? opt.iconClass : 'opacity-50')} />}
              on={on}
              onChange={(next) =>
                st().setTreeStatusFilter(
                  next ? [...statusFilter, opt.value] : statusFilter.filter((v) => v !== opt.value)
                )
              }
            />
          )
        })}
      </Column>
      <Column label="Only these priorities" hint="None selected = every priority. Always applied">
        {PRIORITIES.map((p) => {
          const on = priorityFilter.includes(p)
          return (
            <Chip
              key={p}
              label={PRIORITY_LABELS[p]}
              aria={`Priority ${PRIORITY_LABELS[p]}`}
              icon={<PriorityIcon priority={p} className={cn('size-3.5', !on && 'opacity-50')} />}
              on={on}
              onChange={(next) =>
                st().setTreePriorityFilter(
                  next ? [...priorityFilter, p] : priorityFilter.filter((v) => v !== p)
                )
              }
            />
          )
        })}
      </Column>
    </div>
  )
}

function RowsSection(): React.JSX.Element {
  const showStatus = useTabStore((s) => s.treeShowStatus)
  const showPriority = useTabStore((s) => s.treeShowPriority)
  const showWorktree = useTabStore((s) => s.treeShowWorktree)
  const showTags = useTabStore((s) => s.treeShowTags)
  const showBlockedBadge = useTabStore((s) => s.treeShowBlockedBadge)
  const crossOut = useTabStore((s) => s.treeCrossOutDone)
  const st = useTabStore.getState
  return (
    <div className="space-y-4" data-testid="lens-section-rows">
      <LensRowPreview />
      <Column label="Show on each row">
        <Chip
          label="Status"
          aria="Show status"
          on={showStatus}
          onChange={(v) => st().setTreeShowStatus(v)}
        />
        <Chip
          label="Priority"
          aria="Show priority"
          on={showPriority}
          onChange={(v) => st().setTreeShowPriority(v)}
        />
        <Chip
          label="Worktree"
          aria="Show worktree"
          on={showWorktree}
          onChange={(v) => st().setTreeShowWorktree(v)}
        />
        <Chip
          label="Tags"
          aria="Show tags"
          on={showTags}
          onChange={(v) => st().setTreeShowTags(v)}
        />
        <Chip
          label="Blocked"
          aria="Show blocked badge"
          on={showBlockedBadge}
          onChange={(v) => st().setTreeShowBlockedBadge(v)}
        />
      </Column>
      <Line label="Completed tasks">
        <Seg<'cross' | 'normal'>
          label="Completed tasks"
          value={crossOut ? 'cross' : 'normal'}
          onChange={(v) => st().setTreeCrossOutDone(v === 'cross')}
          options={[
            ['cross', 'Crossed out'],
            ['normal', 'Normal']
          ]}
        />
      </Line>
    </div>
  )
}

function Line({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      <span className="text-sm" title={hint}>
        {label}
      </span>
      {children}
    </div>
  )
}

function Column({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-sm">
        {label}
        {hint && <span className="ml-2 text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

function SwitchLine({
  id,
  label,
  hint,
  checked,
  onChange
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal" title={hint}>
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** A segmented control: one radio button per option. */
function Seg<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: ReadonlyArray<readonly [T, string]>
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 rounded-md border border-border bg-input/30 p-0.5"
    >
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'rounded px-2 py-0.5 text-xs transition-colors',
            value === v
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

/** An on/off chip; a switch to assistive tech, named by `aria`. */
function Chip({
  label,
  aria,
  icon,
  on,
  onChange
}: {
  label: string
  aria: string
  icon?: ReactNode
  on: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={aria}
      onClick={() => onChange(!on)}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
        on
          ? 'border-border bg-accent/60 text-foreground hover:border-foreground/40'
          : 'border-transparent bg-input/30 text-muted-foreground hover:border-border hover:text-foreground'
      )}
    >
      {icon ?? (on ? <Check className="size-3" /> : null)}
      {label}
    </button>
  )
}
