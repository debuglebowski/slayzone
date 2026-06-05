import { useState, useEffect } from 'react'
import type { Task, TaskTemplate } from '@slayzone/task/shared'

/** Loads task templates for the task's project (only for temporary tasks). */
export function useTaskTemplates(task: Task | null): { templates: TaskTemplate[] } {
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  useEffect(() => {
    if (!task?.is_temporary || !task.project_id) return
    window.api.taskTemplates.getByProject(task.project_id).then(setTemplates)
  }, [task?.is_temporary, task?.project_id])
  return { templates }
}
