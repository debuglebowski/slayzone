import { useMemo, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  buildStatusOptions,
  getColumnStatusStyle,
  PriorityIcon
} from '@slayzone/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@slayzone/ui'
import type { Task, TaskStatus } from '@slayzone/task/shared'
import type { Project, ColumnConfig } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import {
  AlarmClock,
  X,
  CircleDot,
  Signal,
  Tag as TagIcon,
  FolderInput,
  Archive,
  Trash2,
  ShieldAlert
} from 'lucide-react'
import { format } from 'date-fns'
import { getSnoozePresets } from '@slayzone/task/client'

interface BulkTaskContextMenuProps {
  taskIds: string[]
  tasks: Task[]
  projects: Project[]
  columns?: ColumnConfig[] | null
  tags?: Tag[]
  taskTagsMap?: Map<string, string[]>
  onBulkUpdate: (taskIds: string[], updates: Partial<Task>) => void
  onBulkArchive?: (taskIds: string[]) => void
  onBulkDelete?: (taskIds: string[]) => void
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
  children: React.ReactNode
}

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
  5: 'Someday'
}

const MIXED = '__mixed__'

function commonValue<T>(values: T[]): T | typeof MIXED {
  if (values.length === 0) return MIXED as never
  const first = values[0]
  for (const v of values) if (v !== first) return MIXED as unknown as T | typeof MIXED
  return first
}

export function BulkTaskContextMenu({
  taskIds,
  tasks,
  projects,
  columns,
  tags,
  taskTagsMap,
  onBulkUpdate,
  onBulkArchive,
  onBulkDelete,
  onTaskTagsChange,
  children
}: BulkTaskContextMenuProps): React.JSX.Element {
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const statusOptions = buildStatusOptions(columns)

  const commonStatus = useMemo(() => commonValue(tasks.map((t) => t.status)), [tasks])
  const commonPriority = useMemo(() => commonValue(tasks.map((t) => t.priority)), [tasks])
  const commonProject = useMemo(() => commonValue(tasks.map((t) => t.project_id)), [tasks])
  const allBlocked = useMemo(() => tasks.length > 0 && tasks.every((t) => t.is_blocked), [tasks])
  const noneBlocked = useMemo(() => tasks.every((t) => !t.is_blocked), [tasks])
  const isSnoozedAll = useMemo(
    () =>
      tasks.length > 0 &&
      tasks.every((t) => t.snoozed_until && new Date(t.snoozed_until) > new Date()),
    [tasks]
  )

  // Tag tri-state per tag id (counts how many of selected have it)
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (!taskTagsMap) return counts
    for (const id of taskIds) {
      const ids = taskTagsMap.get(id) ?? []
      for (const tagId of ids) counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
    }
    return counts
  }, [taskIds, taskTagsMap])

  const handleStatusChange = (status: string): void => {
    onBulkUpdate(taskIds, { status: status as TaskStatus })
  }

  const handlePriorityChange = (priority: string): void => {
    onBulkUpdate(taskIds, { priority: parseInt(priority, 10) })
  }

  const handleProjectChange = (projectId: string): void => {
    onBulkUpdate(taskIds, { project_id: projectId })
  }

  const handleToggleBlocked = (): void => {
    if (allBlocked) {
      onBulkUpdate(taskIds, { is_blocked: false, blocked_comment: null } as Partial<Task>)
    } else {
      onBulkUpdate(taskIds, { is_blocked: true } as Partial<Task>)
    }
  }

  const handleSnooze = (date: Date): void => {
    onBulkUpdate(taskIds, { snoozed_until: date.toISOString() } as Partial<Task>)
  }

  const handleUnsnooze = (): void => {
    onBulkUpdate(taskIds, { snoozed_until: null } as Partial<Task>)
  }

  const handleTagToggle = (tagId: string, checked: boolean): void => {
    if (!onTaskTagsChange || !taskTagsMap) return
    // Apply same toggle to every selected task: if checked → ensure tag present; else → remove
    for (const id of taskIds) {
      const current = taskTagsMap.get(id) ?? []
      const hasIt = current.includes(tagId)
      if (checked && !hasIt) onTaskTagsChange(id, [...current, tagId])
      else if (!checked && hasIt)
        onTaskTagsChange(
          id,
          current.filter((t) => t !== tagId)
        )
    }
  }

  const handleArchive = (): void => {
    onBulkArchive?.(taskIds)
    setArchiveOpen(false)
  }

  const handleDelete = (): void => {
    onBulkDelete?.(taskIds)
    setDeleteOpen(false)
  }

  const snoozePresets = getSnoozePresets()
  const blockedLabel = allBlocked ? 'Blocked' : noneBlocked ? 'Block' : 'Block (mixed)'

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          <div className="col-span-full px-2 py-1 text-xs text-muted-foreground select-none">
            {taskIds.length} tasks selected
          </div>
          <ContextMenuSeparator />

          {/* Status */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <CircleDot className="mr-2 size-3.5" />
              <span className="flex-1">Status</span>
              {commonStatus === MIXED && (
                <span className="text-muted-foreground text-xs mr-1.5">—</span>
              )}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={commonStatus === MIXED ? '' : (commonStatus as string)}
                onValueChange={handleStatusChange}
              >
                {statusOptions.map((s) => {
                  const style = getColumnStatusStyle(s.value, columns)
                  const Icon = style?.icon
                  return (
                    <ContextMenuRadioItem key={s.value} value={s.value}>
                      {Icon && <Icon className={`mr-1.5 size-3.5 ${style?.iconClass ?? ''}`} />}
                      {s.label}
                    </ContextMenuRadioItem>
                  )
                })}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {/* Priority */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Signal className="mr-2 size-3.5" />
              <span className="flex-1">Priority</span>
              {commonPriority === MIXED && (
                <span className="text-muted-foreground text-xs mr-1.5">—</span>
              )}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={commonPriority === MIXED ? '' : String(commonPriority)}
                onValueChange={handlePriorityChange}
              >
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                  <ContextMenuRadioItem key={value} value={value}>
                    <PriorityIcon priority={Number(value)} className="mr-1.5 size-3.5" />
                    {label}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {/* Tags */}
          {tags && taskTagsMap && onTaskTagsChange && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <TagIcon className="mr-2 size-3.5" />
                Tags
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {tags.map((tag) => {
                  const count = tagCounts.get(tag.id) ?? 0
                  const all = count === taskIds.length
                  return (
                    <ContextMenuCheckboxItem
                      key={tag.id}
                      checked={all}
                      onCheckedChange={(checked) => handleTagToggle(tag.id, checked === true)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <span
                        className="rounded px-1.5 py-0.5 text-xs font-medium"
                        style={{ backgroundColor: tag.color, color: tag.text_color }}
                      >
                        {tag.name}
                      </span>
                      {count > 0 && !all && (
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {count}/{taskIds.length}
                        </span>
                      )}
                    </ContextMenuCheckboxItem>
                  )
                })}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}

          {/* Blocked toggle */}
          <ContextMenuItem onSelect={handleToggleBlocked}>
            <ShieldAlert className="mr-2 size-3.5" />
            <span className="flex-1">{blockedLabel}</span>
          </ContextMenuItem>

          {/* Snooze */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <AlarmClock className="mr-2 size-3.5" />
              {isSnoozedAll ? 'Snoozed' : 'Snooze'}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {tasks.some((t) => t.snoozed_until && new Date(t.snoozed_until) > new Date()) && (
                <>
                  <ContextMenuItem onSelect={handleUnsnooze}>
                    <X className="mr-2 size-3.5" />
                    Unsnooze
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              {snoozePresets.map((preset) => {
                const Icon = preset.icon
                const date = preset.getDate()
                return (
                  <ContextMenuItem key={preset.label} onSelect={() => handleSnooze(date)}>
                    <Icon className="mr-2 size-3.5" />
                    <span className="flex-1">{preset.label}</span>
                    <span className="ml-4 text-xs text-muted-foreground">
                      {format(date, 'EEE, MMM d')}
                    </span>
                  </ContextMenuItem>
                )
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {/* Move to project */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderInput className="mr-2 size-3.5" />
              <span className="flex-1">Move to</span>
              {commonProject === MIXED && (
                <span className="text-muted-foreground text-xs mr-1.5">—</span>
              )}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={commonProject === MIXED ? '' : (commonProject as string)}
                onValueChange={handleProjectChange}
              >
                {projects.map((p) => (
                  <ContextMenuRadioItem key={p.id} value={p.id}>
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-2"
                      style={{ backgroundColor: p.color }}
                    />
                    {p.name}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {onBulkArchive && (
            <ContextMenuItem onSelect={() => setArchiveOpen(true)}>
              <Archive className="size-3.5" />
              Archive {taskIds.length} tasks
            </ContextMenuItem>
          )}
          {onBulkDelete && (
            <ContextMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 className="size-3.5" />
              Delete {taskIds.length} tasks
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {taskIds.length} tasks</AlertDialogTitle>
            <AlertDialogDescription>
              Archive {taskIds.length} selected tasks? You can restore them later from the archive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {taskIds.length} tasks</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {taskIds.length} selected tasks? This can be undone via the toast.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
