import { format } from 'date-fns'
import { CalendarIcon, X } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import { priorityOptions } from '@slayzone/task/shared'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Calendar } from '@slayzone/ui'
import { Button } from '@slayzone/ui'
import { cn, PriorityIcon } from '@slayzone/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'

interface PriorityDueDateCardProps {
  task: Task
  onUpdate: (task: Task) => void
}

export function PriorityDueDateCard({
  task,
  onUpdate
}: PriorityDueDateCardProps): React.JSX.Element {
  const handlePriorityChange = async (priority: number): Promise<void> => {
    track('task_priority_changed', { priority: String(priority) })
    const updated = await window.api.db.updateTask({ id: task.id, priority })
    onUpdate(updated)
  }

  const handleDueDateChange = async (date: Date | undefined): Promise<void> => {
    track('due_date_set')
    const dueDate = date ? format(date, 'yyyy-MM-dd') : null
    const updated = await window.api.db.updateTask({ id: task.id, dueDate })
    onUpdate(updated)
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Priority</label>
        <Select
          value={String(task.priority)}
          onValueChange={(v) => handlePriorityChange(Number(v))}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {priorityOptions.map((opt) => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                <span className="flex items-center gap-1.5">
                  <PriorityIcon priority={opt.value} className="h-3.5 w-3.5" />
                  {opt.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Due Date</label>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                'w-full justify-start text-left font-normal',
                !task.due_date && 'text-muted-foreground'
              )}
            >
              <CalendarIcon className="mr-2 size-4" />
              <span className="flex-1">
                {task.due_date ? format(new Date(task.due_date), 'MMM d, yyyy') : 'No date'}
              </span>
              {task.due_date && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDueDateChange(undefined)
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={task.due_date ? new Date(task.due_date) : undefined}
              onSelect={handleDueDateChange}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
