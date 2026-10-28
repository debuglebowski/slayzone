import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  MountWhenOpened,
  Button,
  Textarea,
  getColumnStatusStyle,
  cn,
  type StatusOption
} from '@slayzone/ui'
import { Circle, ShieldAlert, AlarmClock, Check, ListChecks, MessageSquare } from 'lucide-react'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { track } from '@slayzone/telemetry/client'
import { CustomSnoozeDialog } from './SnoozePicker'
import { BlockerDialog } from './BlockerDialog'

interface TaskStatusMenuProps {
  task: Task
  project?: Project | null
  statusOptions: StatusOption[]
  onTaskUpdate: (task: Task) => void
}

/**
 * Status icon + dropdown for the task-detail header. Lists status options, then a
 * separator and Blocked / Blocked by / Snooze actions. "Blocked by" is a native
 * hover submenu (DropdownMenuSub).
 */
export function TaskStatusMenu({
  task,
  project,
  statusOptions,
  onTaskUpdate
}: TaskStatusMenuProps): React.JSX.Element | null {
  const trpc = useTRPC()
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  const [blockerOpen, setBlockerOpen] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [blockedComment, setBlockedComment] = useState('')

  const statusStyle = getColumnStatusStyle(task.status, project?.columns_config)
  if (!statusStyle) return null
  const StatusIcon = statusStyle.icon

  const isSnoozed = Boolean(task.snoozed_until && new Date(task.snoozed_until) > new Date())

  // camelCase update input — the server ignores snake_case row keys.
  const update = async (patch: Omit<UpdateTaskInput, 'id'>): Promise<void> => {
    const updated = await updateTask.mutateAsync({ id: task.id, ...patch })
    onTaskUpdate(updated)
  }

  const handleStatusChange = async (value: string): Promise<void> => {
    track('task_status_changed', { from: task.status, to: value })
    await update({ status: value })
  }

  const handleToggleBlocked = async (): Promise<void> => {
    if (task.is_blocked) {
      track('task_unblocked')
      await update({ isBlocked: false, blockedComment: null })
    } else {
      track('task_blocked', {})
      await update({ isBlocked: true })
    }
  }

  const handleSetBlockedWithComment = async (): Promise<void> => {
    track('task_blocked', { hasComment: 'true' })
    await update({ isBlocked: true, blockedComment: blockedComment.trim() || null })
    setCommentOpen(false)
    setBlockedComment('')
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="task-status-menu-trigger"
            className="shrink-0 cursor-pointer transition-opacity hover:opacity-70"
          >
            <StatusIcon className={cn('size-5', statusStyle.iconClass)} strokeWidth={3} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {statusOptions.map((opt) => {
            const optStyle = getColumnStatusStyle(opt.value, project?.columns_config)
            const OptIcon = optStyle?.icon ?? Circle
            const isCurrent = opt.value === task.status
            return (
              <DropdownMenuItem
                key={opt.value}
                onSelect={() => handleStatusChange(opt.value)}
                className={cn(isCurrent && 'bg-accent font-medium')}
              >
                <OptIcon className={cn('size-4', optStyle?.iconClass)} />
                <span>{opt.label}</span>
              </DropdownMenuItem>
            )
          })}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              handleToggleBlocked()
            }}
          >
            <ShieldAlert className="size-4 text-red-500" strokeWidth={2.5} />
            <span>Blocked</span>
            {task.is_blocked && <Check className="col-start-3 size-3.5" />}
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ShieldAlert className="size-4" />
              <span>Blocked by</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => setBlockerOpen(true)}>
                <ListChecks className="size-4" />
                <span>Set blocking task</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setBlockedComment(task.blocked_comment ?? '')
                  setCommentOpen(true)
                }}
              >
                <MessageSquare className="size-4" />
                <span>Set blocked with comment</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuItem onSelect={() => setSnoozeOpen(true)}>
            <AlarmClock className="size-4 text-orange-500" />
            <span>{isSnoozed ? 'Snoozed' : 'Snooze'}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dialogs mount on first open: this menu is mounted in every open task tab. */}
      {/* Blocking task dialog */}
      <MountWhenOpened open={blockerOpen}>
        <BlockerDialog
          taskId={blockerOpen ? task.id : null}
          projects={project ? [project] : undefined}
          onClose={() => setBlockerOpen(false)}
        />
      </MountWhenOpened>

      {/* Snooze date/time dialog */}
      <MountWhenOpened open={snoozeOpen}>
        <CustomSnoozeDialog
          open={snoozeOpen}
          onOpenChange={setSnoozeOpen}
          onSnooze={(until) => {
            track('task_snoozed')
            update({ snoozedUntil: until })
          }}
        />
      </MountWhenOpened>

      {/* Blocked with comment dialog */}
      <MountWhenOpened open={commentOpen}>
        <Dialog
          open={commentOpen}
          onOpenChange={(o) => {
            setCommentOpen(o)
            if (!o) setBlockedComment('')
          }}
        >
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
              <Button variant="outline" size="sm" onClick={() => setCommentOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSetBlockedWithComment}>
                Set blocked
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </MountWhenOpened>
    </>
  )
}
