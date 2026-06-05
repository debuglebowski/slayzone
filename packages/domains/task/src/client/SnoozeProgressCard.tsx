import { format } from 'date-fns'
import { AlarmClock, Gauge, X } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { isCompletedStatus } from '@slayzone/projects/shared'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import { TaskProgressPopover } from './TaskProgressPopover'
import { SnoozePicker } from './SnoozePicker'

interface SnoozeProgressCardProps {
  task: Task
  onUpdate: (task: Task) => void
  columnsConfig: Project['columns_config'] | undefined
}

export function SnoozeProgressCard({
  task,
  onUpdate,
  columnsConfig
}: SnoozeProgressCardProps): React.JSX.Element {
  const handleSnooze = async (until: string): Promise<void> => {
    track('task_snoozed')
    const updated = await window.api.db.updateTask({ id: task.id, snoozedUntil: until })
    onUpdate(updated)
  }

  const handleUnsnooze = async (): Promise<void> => {
    track('task_unsnoozed')
    const updated = await window.api.db.updateTask({ id: task.id, snoozedUntil: null })
    onUpdate(updated)
  }

  const handleProgressChange = async (progress: number): Promise<void> => {
    track('task_progress_changed', { value: String(progress) })
    const updated = await window.api.db.updateTask({ id: task.id, progress })
    onUpdate(updated)
  }

  const isSnoozed = task.snoozed_until && new Date(task.snoozed_until) > new Date()

  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Snooze</label>
        {isSnoozed ? (
          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm">
            <AlarmClock className="size-3.5 text-muted-foreground shrink-0" />
            <span className="flex-1 truncate">
              {format(new Date(task.snoozed_until!), 'MMM d · h:mm a')}
            </span>
            <button
              onClick={handleUnsnooze}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-full justify-start text-muted-foreground">
                <AlarmClock className="mr-2 size-4" />
                Not snoozed
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <SnoozePicker onSnooze={handleSnooze} />
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Progress</label>
        {isCompletedStatus(task.status, columnsConfig) ? (
          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground">
            <span className="flex-1 truncate">Complete</span>
          </div>
        ) : (
          <div className="flex items-stretch">
            <TaskProgressPopover
              value={task.progress ?? 0}
              onCommit={handleProgressChange}
              align="start"
            >
              <Button
                variant="outline"
                className={cn(
                  'flex-1 justify-start min-w-0',
                  (task.progress ?? 0) > 0 && 'rounded-r-none border-r-0',
                  (task.progress ?? 0) === 0 && 'text-muted-foreground'
                )}
              >
                <Gauge className="mr-2 size-4 shrink-0" />
                <span className="flex-1 text-left truncate">
                  {(task.progress ?? 0) === 0 ? 'Not started' : `${task.progress}%`}
                </span>
              </Button>
            </TaskProgressPopover>
            {(task.progress ?? 0) > 0 && (
              <Button
                variant="outline"
                className="rounded-l-none px-2 text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => handleProgressChange(0)}
                aria-label="Clear progress"
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
