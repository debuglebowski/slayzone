import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task, TaskTemplate } from '@slayzone/task/shared'

/** Loads task templates for the task's project (only for temporary tasks). */
export function useTaskTemplates(task: Task | null): { templates: TaskTemplate[] } {
  const trpc = useTRPC()
  const enabled = Boolean(task?.is_temporary && task.project_id)
  const templatesQuery = useQuery(
    trpc.template.getByProject.queryOptions({ projectId: task?.project_id ?? '' }, { enabled })
  )
  return { templates: enabled ? (templatesQuery.data ?? []) : [] }
}
