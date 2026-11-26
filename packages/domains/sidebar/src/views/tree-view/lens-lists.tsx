import { useState, type ReactNode } from 'react'
import { Ban, ChevronDown, Clock, Pin } from 'lucide-react'
import { cn, getColumnStatusStyle, useNow } from '@slayzone/ui'
import type { Task } from '@slayzone/task-contracts'
import type { TerminalState } from '@slayzone/terminal-contracts'
import type { LensGroup, TreeDisplay } from '@slayzone/tabs-state'
import { groupTreeRows, orderTreeRows, type TreeGroup } from '../treeGrouping'
import { groupByAgent, groupByRecent, type ListGroup } from '../lensLists'
import { TaskRow } from './rows'
import type { TaskBranchCtx } from './tree-view.types'

interface Section {
  key: string
  label: string
  icon?: ReactNode
  tone?: 'warning'
  tasks: Task[]
}

/** A status group's label and icon (shared column styles, default columns). */
function statusSection(g: TreeGroup): Section {
  if (g.isPinned)
    return {
      key: g.key,
      label: 'Pinned',
      icon: <Pin className="size-3 -rotate-45 fill-current text-muted-foreground/60" />,
      tasks: g.tasks
    }
  if (g.isTemp)
    return {
      key: g.key,
      label: 'Temporary',
      icon: <Clock className="size-3 text-muted-foreground/60" />,
      tasks: g.tasks
    }
  if (g.isBlocked)
    return {
      key: g.key,
      label: 'Blocked',
      icon: <Ban className="size-3 text-muted-foreground/60" />,
      tasks: g.tasks
    }
  const style = getColumnStatusStyle(g.key, null)
  const Icon = style?.icon
  return {
    key: g.key,
    label: style?.label ?? g.key,
    icon: Icon ? <Icon className={cn('size-3', style?.iconClass)} /> : undefined,
    tasks: g.tasks
  }
}

const fromList = (g: ListGroup): Section => ({
  key: g.key,
  label: g.label,
  tone: g.key === 'needs-you' ? 'warning' : undefined,
  tasks: g.tasks
})

/**
 * The cross-project lenses: every visible task from the lens's projects in one list,
 * grouped by agent state, by task status, or by recency. Rows are the tree's own task
 * rows (outside drag-and-drop), each led by its project's color dot.
 */
export function LensTaskLists({
  group,
  tasks,
  ctx,
  display,
  pinnedIds,
  stateOf
}: {
  group: Exclude<LensGroup, 'project'>
  tasks: Task[]
  ctx: TaskBranchCtx
  display: TreeDisplay
  pinnedIds: Set<string>
  stateOf: (taskId: string) => TerminalState | undefined
}): React.JSX.Element {
  const now = useNow(60_000)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const ordered = orderTreeRows(tasks, display.treeOrderBy, display.treeOrderDir)

  let sections: Section[]
  if (group === 'agent') sections = groupByAgent(ordered, stateOf).map(fromList)
  else if (group === 'recent') sections = groupByRecent(tasks, new Date(now)).map(fromList)
  else
    sections = groupTreeRows(ordered, 'status', null, {
      showEmpty: display.treeShowEmptyGroups,
      statusFilter: new Set(display.treeStatusFilter),
      groupTemporary: display.treeGroupTemporary,
      groupPinned: display.treeGroupPinned,
      pinnedIds,
      groupBlocked: display.treeGroupBlocked,
      blockedIds: ctx.blockedTaskIds
    }).map(statusSection)

  if (sections.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs italic text-muted-foreground/60">
        Nothing to show with this lens
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="lens-task-lists" data-lens-group={group}>
      {sections.map((s) => {
        const isCollapsed = collapsed.has(s.key)
        return (
          <section key={s.key} data-testid="lens-group" data-group-key={s.key}>
            <ListHeader
              label={s.label}
              count={s.tasks.length}
              icon={s.icon}
              tone={s.tone}
              collapsed={isCollapsed}
              onToggle={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(s.key)) next.delete(s.key)
                  else next.add(s.key)
                  return next
                })
              }
            />
            {!isCollapsed &&
              s.tasks.map((t) => (
                <TaskRow key={t.id} task={t} depth={0} ancestorFlags={[]} inTempGroup ctx={ctx} />
              ))}
          </section>
        )
      })}
    </div>
  )
}

/** "Needs you · N": tasks waiting for the user, from every project, above the lens body. */
export function NeedsYouStrip({
  tasks,
  ctx
}: {
  tasks: Task[]
  ctx: TaskBranchCtx
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  if (tasks.length === 0) return null
  return (
    <section data-testid="tree-needs-you" className="mb-3 rounded-lg bg-surface-1 pb-1">
      <ListHeader
        label="Needs you"
        count={tasks.length}
        tone="warning"
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      {!collapsed &&
        tasks.map((t) => (
          <TaskRow key={t.id} task={t} depth={0} ancestorFlags={[]} inTempGroup ctx={ctx} />
        ))}
    </section>
  )
}

function ListHeader({
  label,
  count,
  icon,
  tone,
  collapsed,
  onToggle
}: {
  label: string
  count: number
  icon?: ReactNode
  tone?: 'warning'
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={cn(
        'flex w-full items-center gap-1.5 px-2 pt-2 pb-1 text-left text-[11px] font-medium uppercase tracking-wider transition-colors hover:text-foreground',
        tone === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground/60'
      )}
    >
      <ChevronDown className={cn('size-3 transition-transform', collapsed && '-rotate-90')} />
      {icon}
      <span>
        {label} · {count}
      </span>
    </button>
  )
}
