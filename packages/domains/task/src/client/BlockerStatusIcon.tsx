import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { cn, getColumnStatusStyle } from '@slayzone/ui'

export function BlockerStatusIcon({
  task,
  columns
}: {
  task: Task
  columns?: Project['columns_config']
}): React.JSX.Element | null {
  const statusStyle = getColumnStatusStyle(task.status, columns)
  const StatusIcon = statusStyle?.icon

  if (!StatusIcon) return null

  return (
    <span className="shrink-0" title={statusStyle.label}>
      <StatusIcon
        aria-hidden="true"
        className={cn('size-3.5', statusStyle.iconClass)}
        strokeWidth={2.5}
      />
    </span>
  )
}
