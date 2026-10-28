import type { CreateTaskFormData } from '@slayzone/task-contracts'
import type { CreateTaskDraft } from '@slayzone/task-contracts'

export function buildCreateTaskFormDefaults(
  draft: CreateTaskDraft = {},
  fallbackProjectId?: string
): CreateTaskFormData {
  return {
    projectId: draft.projectId ?? fallbackProjectId ?? '',
    title: draft.title ?? '',
    description: draft.description ?? '',
    status: draft.status ?? 'inbox',
    priority: draft.priority ?? 3,
    dueDate: draft.dueDate ?? null,
    tagIds: []
  }
}
