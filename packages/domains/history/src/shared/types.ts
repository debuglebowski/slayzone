export type ActivityEntityType = 'task' | 'automation_run'
export type ActivityActorType = 'user' | 'automation' | 'system'
export type ActivitySource = 'task' | 'automations'

export type ActivityEventKind =
  | 'task.created'
  | 'task.title_changed'
  | 'task.description_changed'
  | 'task.status_changed'
  | 'task.priority_changed'
  | 'task.assignee_changed'
  | 'task.due_date_changed'
  | 'task.tags_changed'
  | 'task.archived'
  | 'task.unarchived'
  | 'task.deleted'
  | 'task.restored'
  | 'automation.run_succeeded'
  | 'automation.run_failed'

export interface ActivityEvent {
  id: string
  entityType: ActivityEntityType
  entityId: string
  projectId: string | null
  taskId: string | null
  kind: ActivityEventKind
  actorType: ActivityActorType
  source: ActivitySource
  summary: string
  payload: Record<string, unknown> | null
  createdAt: string
}

export interface ActivityEventCursor {
  createdAt: string
  id: string
}

export interface ListTaskHistoryOptions {
  limit?: number
  before?: ActivityEventCursor | null
}

export interface ListTaskHistoryResult {
  events: ActivityEvent[]
  nextCursor: ActivityEventCursor | null
}

export interface AutomationActionRun {
  id: string
  runId: string
  automationId: string
  taskId: string | null
  projectId: string | null
  actionIndex: number
  actionType: string
  command: string
  status: 'running' | 'success' | 'error'
  outputTail: string | null
  error: string | null
  startedAt: string
  completedAt: string | null
  durationMs: number | null
}
