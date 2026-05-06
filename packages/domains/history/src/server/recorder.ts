import type { Database } from 'better-sqlite3'
import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityActorType,
  ActivityEntityType,
  ActivitySource,
  AutomationActionRun,
  ListTaskHistoryOptions,
  ListTaskHistoryResult,
} from '../shared/types'

export const AUTOMATION_OUTPUT_TAIL_MAX = 4000
export const ACTIVITY_EVENT_PAYLOAD_MAX_BYTES = 16_000
const DEFAULT_TASK_HISTORY_LIMIT = 100
const MAX_TASK_HISTORY_LIMIT = 250

interface ActivityEventRow {
  id: string
  entity_type: ActivityEntityType
  entity_id: string
  project_id: string | null
  task_id: string | null
  kind: ActivityEventKind
  actor_type: ActivityActorType
  source: ActivitySource
  summary: string
  payload_json: string | null
  created_at: string
}

interface AutomationActionRunRow {
  id: string
  run_id: string
  automation_id: string
  task_id: string | null
  project_id: string | null
  action_index: number
  action_type: string
  command: string
  status: 'running' | 'success' | 'error'
  output_tail: string | null
  error: string | null
  started_at: string
  completed_at: string | null
  duration_ms: number | null
}

export interface RecordActivityEventInput {
  entityType: ActivityEntityType
  entityId: string
  projectId?: string | null
  taskId?: string | null
  kind: ActivityEventKind
  actorType: ActivityActorType
  source: ActivitySource
  summary: string
  payload?: Record<string, unknown> | null
}

export interface StartAutomationActionRunInput {
  runId: string
  automationId: string
  taskId?: string | null
  projectId?: string | null
  actionIndex: number
  actionType: string
  command: string
}

export interface FinishAutomationActionRunInput {
  status: 'success' | 'error'
  outputTail?: string | null
  error?: string | null
  durationMs: number
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed payloads
  }
  return null
}

function serializePayload(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null

  const serialized = JSON.stringify(payload)
  if (serialized.length > ACTIVITY_EVENT_PAYLOAD_MAX_BYTES) {
    throw new Error(`Activity event payload exceeds ${ACTIVITY_EVENT_PAYLOAD_MAX_BYTES} bytes`)
  }
  return serialized
}

function clampTaskHistoryLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TASK_HISTORY_LIMIT
  if (!Number.isFinite(limit)) return DEFAULT_TASK_HISTORY_LIMIT
  return Math.max(1, Math.min(MAX_TASK_HISTORY_LIMIT, Math.floor(limit)))
}

export function trimOutputTail(value: string | null | undefined, maxLength = AUTOMATION_OUTPUT_TAIL_MAX): string | null {
  if (!value) return null
  if (value.length <= maxLength) return value
  return value.slice(-maxLength)
}

export function recordActivityEvent(db: Database, input: RecordActivityEventInput): string {
  return recordActivityEvents(db, [input])[0]
}

export function recordActivityEvents(db: Database, inputs: RecordActivityEventInput[]): string[] {
  if (inputs.length === 0) return []

  const insert = db.prepare(`
    INSERT INTO activity_events (
      id, entity_type, entity_id, project_id, task_id,
      kind, actor_type, source, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const ids: string[] = []
  for (const input of inputs) {
    const id = crypto.randomUUID()
    insert.run(
      id,
      input.entityType,
      input.entityId,
      input.projectId ?? null,
      input.taskId ?? null,
      input.kind,
      input.actorType,
      input.source,
      input.summary,
      serializePayload(input.payload)
    )
    ids.push(id)
  }
  return ids
}

export function startAutomationActionRun(db: Database, input: StartAutomationActionRunInput): string {
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO automation_action_runs (
      id, run_id, automation_id, task_id, project_id,
      action_index, action_type, command, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'))
  `).run(
    id,
    input.runId,
    input.automationId,
    input.taskId ?? null,
    input.projectId ?? null,
    input.actionIndex,
    input.actionType,
    input.command
  )
  return id
}

export function finishAutomationActionRun(db: Database, id: string, input: FinishAutomationActionRunInput): void {
  db.prepare(`
    UPDATE automation_action_runs
    SET status = ?, output_tail = ?, error = ?, duration_ms = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(
    input.status,
    trimOutputTail(input.outputTail),
    input.error ?? null,
    input.durationMs,
    id
  )
}

function mapActivityEvent(row: ActivityEventRow): ActivityEvent {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: row.kind,
    actorType: row.actor_type,
    source: row.source,
    summary: row.summary,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
  }
}

export function listActivityEventsForTask(
  db: Database,
  taskId: string,
  options: ListTaskHistoryOptions = {}
): ListTaskHistoryResult {
  const limit = clampTaskHistoryLimit(options.limit)

  const rows = options.before
    ? db.prepare(`
        SELECT *
        FROM activity_events
        WHERE task_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(taskId, options.before.createdAt, options.before.createdAt, options.before.id, limit + 1) as ActivityEventRow[]
    : db.prepare(`
        SELECT *
        FROM activity_events
        WHERE task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(taskId, limit + 1) as ActivityEventRow[]

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const events = pageRows.map(mapActivityEvent)
  const tail = events.at(-1)

  return {
    events,
    nextCursor: hasMore && tail
      ? { createdAt: tail.createdAt, id: tail.id }
      : null,
  }
}

export function listAutomationActionRuns(db: Database, runId: string): AutomationActionRun[] {
  const rows = db.prepare(`
    SELECT *
    FROM automation_action_runs
    WHERE run_id = ?
    ORDER BY action_index ASC, started_at ASC
  `).all(runId) as AutomationActionRunRow[]

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    automationId: row.automation_id,
    taskId: row.task_id,
    projectId: row.project_id,
    actionIndex: row.action_index,
    actionType: row.action_type,
    command: row.command,
    status: row.status,
    outputTail: row.output_tail,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  }))
}
