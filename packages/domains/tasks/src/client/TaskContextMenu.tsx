import { useState } from 'react'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@slayzone/ui'
import { Button, Textarea } from '@slayzone/ui'
import type { Task, TaskStatus } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { CreateTagDialog } from '@slayzone/tags/client'
import { Plus, AlarmClock, X, CircleDot, Signal, Tag as TagIcon, FolderInput, Copy, Archive, Trash2, ShieldAlert, ListChecks, MessageSquare, Check } from 'lucide-react'
import { track } from '@slayzone/telemetry/client'
import { format } from 'date-fns'
import { getSnoozePresets, CustomSnoozeDialog } from '@slayzone/task/client'
import { BlockerDialog } from './BlockerDialog'

interface TaskContextMenuProps {
  task: Task
  projects: Project[]
  columns?: ColumnConfig[] | null
  tags?: Tag[]
  taskTagIds?: string[]
  isBlocked?: boolean
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask: (taskId: string) => void
  onDeleteTask: (taskId: string) => void
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
  onTagCreated?: (tag: Tag) => void
  children: React.ReactNode
}

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
  5: 'Someday'
}

export function TaskContextMenu({
  task,
  projects,
  columns,
  tags,
  taskTagIds,
  isBlocked,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask,
  onTaskTagsChange,
  onTagCreated,
  children
}: TaskContextMenuProps): React.JSX.Element {
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false)
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [blockerDialogOpen, setBlockerDialogOpen] = useState(false)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [blockedComment, setBlockedComment] = useState('')
  const statusOptions = buildStatusOptions(columns)

  const handleStatusChange = (status: string): void => {
    track('task_status_changed', { from: task.status, to: status })
    onUpdateTask(task.id, { status: status as TaskStatus })
  }

  const handlePriorityChange = (priority: string): void => {
    track('task_priority_changed', { priority })
    onUpdateTask(task.id, { priority: parseInt(priority, 10) })
  }

  const handleTagToggle = (tagId: string, checked: boolean): void => {
    if (!onTaskTagsChange) return
    const current = taskTagIds ?? []
    const next = checked ? [...current, tagId] : current.filter((id) => id !== tagId)
    onTaskTagsChange(task.id, next)
  }

  const handleProjectChange = (projectId: string): void => {
    track('task_moved_to_project')
    onUpdateTask(task.id, { project_id: projectId })
  }

  const handleSnooze = (date: Date): void => {
    track('task_snoozed')
    onUpdateTask(task.id, { snoozed_until: date.toISOString() } as Partial<Task>)
  }

  const handleUnsnooze = (): void => {
    track('task_unsnoozed')
    onUpdateTask(task.id, { snoozed_until: null } as Partial<Task>)
  }

  const isSnoozed = task.snoozed_until && new Date(task.snoozed_until) > new Date()

  const snoozePresets = getSnoozePresets()

  const handleCopyTitle = async (): Promise<void> => {
    track('copy_title')
    await navigator.clipboard.writeText(task.title)
  }

  const handleCopyLink = async (): Promise<void> => {
    track('copy_link')
    await navigator.clipboard.writeText(`slayzone://task/${task.id}`)
  }

  const handleArchiveConfirm = (): void => {
    onArchiveTask(task.id)
    setArchiveDialogOpen(false)
  }

  const handleDeleteConfirm = (): void => {
    track('task_deleted', { was_temporary: Boolean(task.is_temporary) })
    onDeleteTask(task.id)
    setDeleteDialogOpen(false)
  }

  // Blocked handlers
  const handleToggleBlocked = (): void => {
    if (task.is_blocked) {
      track('task_unblocked')
      onUpdateTask(task.id, { is_blocked: false, blocked_comment: null } as Partial<Task>)
    } else {
      track('task_blocked', {})
      onUpdateTask(task.id, { is_blocked: true } as Partial<Task>)
    }
  }

  const handleSetBlockedWithComment = async (): Promise<void> => {
    track('task_blocked', { hasComment: 'true' })
    onUpdateTask(task.id, { is_blocked: true, blocked_comment: blockedComment.trim() || null } as Partial<Task>)
    setCommentDialogOpen(false)
    setBlockedComment('')
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          {/* Status submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger><CircleDot className="mr-2 size-3.5" /><span className="flex-1">Status</span><span className="text-muted-foreground text-xs mr-1.5">S</span></ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup value={task.status} onValueChange={handleStatusChange}>
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

          {/* Priority submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger><Signal className="mr-2 size-3.5" /><span className="flex-1">Priority</span><span className="text-muted-foreground text-xs mr-1.5">P</span></ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={String(task.priority)}
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

          {/* Tags submenu */}
          {tags && onTaskTagsChange && (
            <ContextMenuSub>
              <ContextMenuSubTrigger><TagIcon className="mr-2 size-3.5" />Tags</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {tags.map((tag) => (
                  <ContextMenuCheckboxItem
                    key={tag.id}
                    checked={taskTagIds?.includes(tag.id) ?? false}
                    onCheckedChange={(checked) => handleTagToggle(tag.id, checked === true)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span
                      className="rounded px-1.5 py-0.5 text-xs font-medium"
                      style={{ backgroundColor: tag.color, color: tag.text_color }}
                    >
                      {tag.name}
                    </span>
                  </ContextMenuCheckboxItem>
                ))}
                {tags.length > 0 && <ContextMenuSeparator />}
                <ContextMenuItem onSelect={() => setTagDialogOpen(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  New tag
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}

          {/* Blocked toggle */}
          <ContextMenuItem onSelect={handleToggleBlocked}>
            <ShieldAlert className="size-3.5" />
            <span className="flex-1">Blocked</span>
            {(isBlocked ?? task.is_blocked) && <Check className="size-3.5" />}
            <span className="text-muted-foreground text-xs mr-[22px]">B</span>
          </ContextMenuItem>

          {/* Blocked by submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger><ShieldAlert className="mr-2 size-3.5" /><span className="flex-1">Blocked by</span><span className="text-muted-foreground text-xs mr-1.5">&#8679;B</span></ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => setBlockerDialogOpen(true)}>
                <ListChecks className="mr-2 size-3.5" />
                Set blocking task
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => {
                setBlockedComment(task.blocked_comment ?? '')
                setCommentDialogOpen(true)
              }}>
                <MessageSquare className="mr-2 size-3.5" />
                Set blocked with comment
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {/* Snooze submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <AlarmClock className="mr-2 size-3.5" />
              {isSnoozed ? 'Snoozed' : 'Snooze'}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {isSnoozed && (
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
                    <span className="ml-4 text-xs text-muted-foreground">{format(date, 'EEE, MMM d')}</span>
                  </ContextMenuItem>
                )
              })}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => setCustomSnoozeOpen(true)}>
                <AlarmClock className="mr-2 size-3.5" />
                Custom...
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {/* Move to project */}
          <ContextMenuSub>
            <ContextMenuSubTrigger><FolderInput className="mr-2 size-3.5" />Move to</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={task.project_id}
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

          {/* Copy submenu */}
          <ContextMenuSub>
            <ContextMenuSubTrigger><Copy className="mr-2 size-3.5" />Copy</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={handleCopyTitle}>Title</ContextMenuItem>
              <ContextMenuItem onSelect={handleCopyLink}>Link</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {/* Archive */}
          <ContextMenuItem onSelect={() => setArchiveDialogOpen(true)}><Archive className="size-3.5" />Archive</ContextMenuItem>

          {/* Delete */}
          <ContextMenuItem variant="destructive" onSelect={() => setDeleteDialogOpen(true)}>
            <Trash2 className="size-3.5" />Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Archive confirmation dialog */}
      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Task</AlertDialogTitle>
            <AlertDialogDescription>
              Archive "{task.title}"? You can restore it later from the archive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchiveConfirm}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Task</AlertDialogTitle>
            <AlertDialogDescription>
              Delete "{task.title}"? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Custom snooze dialog */}
      <CustomSnoozeDialog
        open={customSnoozeOpen}
        onOpenChange={setCustomSnoozeOpen}
        onSnooze={(until) => {
          track('task_snoozed')
          onUpdateTask(task.id, { snoozed_until: until } as Partial<Task>)
        }}
      />

      {/* Create tag dialog */}
      {tags && (
        <CreateTagDialog
          open={tagDialogOpen}
          onOpenChange={setTagDialogOpen}
          projectId={task.project_id}
          tag={null}
          existingTags={tags}
          onCreated={(tag) => {
            onTagCreated?.(tag)
            handleTagToggle(tag.id, true)
          }}
          onUpdated={() => {}}
        />
      )}

      {/* Blocking task dialog */}
      <BlockerDialog
        taskId={blockerDialogOpen ? task.id : null}
        projects={projects}
        onClose={() => setBlockerDialogOpen(false)}
      />

      {/* Blocked with comment dialog */}
      <Dialog open={commentDialogOpen} onOpenChange={(open) => { setCommentDialogOpen(open); if (!open) setBlockedComment('') }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Set blocked with comment</DialogTitle>
          </DialogHeader>
          <Textarea
            value={blockedComment}
            onChange={(e) => setBlockedComment(e.target.value)}
            placeholder="Why is this task blocked?"
            rows={3}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setCommentDialogOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSetBlockedWithComment}>Set blocked</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
