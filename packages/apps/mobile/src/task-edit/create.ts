/**
 * A new task as the create screen holds it, and the `task.create` input it becomes.
 * The hub does the rest the way it does for desktop and the CLI: the template (the one
 * named, else the project's default), a status the project doesn't know → its default.
 */
import type { CreateTaskInput } from '@slayzone/task-contracts'
import { NO_TEMPLATE } from './fields'

export interface NewTaskDraft {
  projectId: string
  /** A subtask's parent; null = a top-level task. */
  parentId: string | null
  title: string
  status: string
  priority: number
  /** `YYYY-MM-DD`; null = none. */
  dueDate: string | null
  /** A template id, or `NO_TEMPLATE`. */
  templateId: string
}

/** The create call; null = no title or no project yet, nothing to create. */
export function createTaskInput(draft: NewTaskDraft): CreateTaskInput | null {
  const title = draft.title.trim()
  if (!title || !draft.projectId) return null
  const input: CreateTaskInput = {
    projectId: draft.projectId,
    title,
    status: draft.status,
    priority: draft.priority
  }
  if (draft.dueDate) input.dueDate = draft.dueDate
  if (draft.parentId) input.parentId = draft.parentId
  if (draft.templateId !== NO_TEMPLATE) input.templateId = draft.templateId
  return input
}
