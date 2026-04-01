import type { RecordActivityEventInput } from '@slayzone/history/main'
import type { Task } from '../shared/types'

function toTitleCase(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildTaskEvent(
  task: Pick<Task, 'id' | 'project_id'>,
  kind: RecordActivityEventInput['kind'],
  summary: string,
  payload?: Record<string, unknown> | null
): RecordActivityEventInput {
  return {
    entityType: 'task',
    entityId: task.id,
    projectId: task.project_id,
    taskId: task.id,
    kind,
    actorType: 'user',
    source: 'task',
    summary,
    payload,
  }
}

export function buildTaskCreatedEvents(task: Task): RecordActivityEventInput[] {
  return [
    buildTaskEvent(task, 'task.created', 'Task created', {
      title: task.title,
      status: task.status,
      priority: task.priority,
    }),
  ]
}

export function buildTaskUpdatedEvents(before: Task, after: Task): RecordActivityEventInput[] {
  const events: RecordActivityEventInput[] = []

  if (before.title !== after.title) {
    events.push(buildTaskEvent(after, 'task.title_changed', 'Title changed', {
      from: before.title,
      to: after.title,
    }))
  }

  if (before.description !== after.description) {
    events.push(buildTaskEvent(after, 'task.description_changed', 'Description updated', {
      beforeLength: before.description?.length ?? 0,
      afterLength: after.description?.length ?? 0,
      beforeFormat: before.description_format,
      afterFormat: after.description_format,
    }))
  }

  if (before.status !== after.status) {
    events.push(buildTaskEvent(
      after,
      'task.status_changed',
      `Status changed from ${toTitleCase(before.status)} to ${toTitleCase(after.status)}`,
      {
        from: before.status,
        to: after.status,
      }
    ))
  }

  if (before.priority !== after.priority) {
    events.push(buildTaskEvent(after, 'task.priority_changed', 'Priority changed', {
      from: before.priority,
      to: after.priority,
    }))
  }

  if (before.assignee !== after.assignee) {
    events.push(buildTaskEvent(after, 'task.assignee_changed', 'Assignee changed', {
      from: before.assignee,
      to: after.assignee,
    }))
  }

  if (before.due_date !== after.due_date) {
    events.push(buildTaskEvent(after, 'task.due_date_changed', 'Due date changed', {
      from: before.due_date,
      to: after.due_date,
    }))
  }

  return events
}

export function buildTaskArchivedEvents(tasks: Task[]): RecordActivityEventInput[] {
  return tasks.map((task) => buildTaskEvent(task, 'task.archived', 'Task archived'))
}

export function buildTaskUnarchivedEvents(task: Task): RecordActivityEventInput[] {
  return [buildTaskEvent(task, 'task.unarchived', 'Task restored from archive')]
}

export function buildTaskDeletedEvents(task: Task): RecordActivityEventInput[] {
  return [buildTaskEvent(task, 'task.deleted', 'Task deleted')]
}

export function buildTaskRestoredEvents(task: Task): RecordActivityEventInput[] {
  return [buildTaskEvent(task, 'task.restored', 'Task restored')]
}

export function buildTaskTagsChangedEvents(
  task: Pick<Task, 'id' | 'project_id'>,
  previousTagIds: string[],
  nextTagIds: string[]
): RecordActivityEventInput[] {
  const previousSet = new Set(previousTagIds)
  const nextSet = new Set(nextTagIds)
  const addedTagIds = nextTagIds.filter((tagId) => !previousSet.has(tagId))
  const removedTagIds = previousTagIds.filter((tagId) => !nextSet.has(tagId))

  if (addedTagIds.length === 0 && removedTagIds.length === 0) {
    return []
  }

  return [
    buildTaskEvent(task, 'task.tags_changed', 'Tags updated', {
      addedTagIds,
      removedTagIds,
    }),
  ]
}
