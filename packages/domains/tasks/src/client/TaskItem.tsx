import { motion } from 'framer-motion'
import type { Task } from '@slayzone/task/shared'
import { Button, getTaskStatusStyle } from '@slayzone/ui'
import { Pencil, Trash2 } from 'lucide-react'
import { format, isPast, parseISO } from 'date-fns'

interface TaskItemProps {
  task: Task
  onEdit: (task: Task) => void
  onDelete: (task: Task) => void
}

export function TaskItem({ task, onEdit, onDelete }: TaskItemProps): React.JSX.Element {
  const isOverdue = task.due_date && task.status !== 'done' && isPast(parseISO(task.due_date))

  return (
    <motion.div
      className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-muted/50 transition-colors duration-[400ms] hover:duration-[100ms]"
    >
      {/* Priority */}
      <span className="w-12 text-xs font-medium text-muted-foreground">{({ 1: 'Urgent', 2: 'High', 3: 'Med', 4: 'Low', 5: 'Later' } as Record<number, string>)[task.priority]}</span>

      {/* Title */}
      <span
        className={`flex-1 truncate ${task.status === 'done' ? 'line-through text-muted-foreground' : ''}`}
      >
        {task.title}
      </span>

      {/* Status badge */}
      {(() => {
        const style = getTaskStatusStyle(task.status)
        return style && (
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
            {style.label}
          </span>
        )
      })()}

      {/* Due date */}
      {task.due_date && (
        <span
          className={`text-xs ${isOverdue ? 'font-medium text-red-600' : 'text-muted-foreground'}`}
        >
          {format(parseISO(task.due_date), 'MMM d')}
        </span>
      )}

      {/* Actions */}
      <div className="flex gap-1">
        <Button variant="ghost" size="icon-sm" onClick={() => onEdit(task)} aria-label="Edit task">
          <Pencil className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => onDelete(task)} aria-label="Delete task">
          <Trash2 className="size-4" />
        </Button>
      </div>
    </motion.div>
  )
}
