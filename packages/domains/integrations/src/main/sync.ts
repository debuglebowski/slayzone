import type { Database } from 'better-sqlite3'
import type {
  ExternalLink,
  IntegrationProjectMapping,
  LinearIssueSummary,
  SyncNowInput,
  SyncNowResult
} from '../shared'
import { getIssue, updateIssue } from './linear-client'
import { readCredential } from './credentials'
import { htmlToMarkdown, markdownToHtml } from './markdown'
import {
  getColumnById,
  getDefaultStatus,
  getDoneStatus,
  getStatusByCategories,
  isKnownStatus,
  parseColumnsConfig,
  type ColumnConfig,
  type WorkflowCategory
} from '@slayzone/workflow'

type Task = {
  id: string
  project_id: string
  title: string
  description: string | null
  status: string
  priority: number
  updated_at: string
}

type ProjectMapping = IntegrationProjectMapping

interface LinkRow extends ExternalLink {
  credential_ref: string
}

function toMs(value: string | null | undefined): number {
  if (!value) return 0
  // SQLite datetime('now') returns UTC as 'YYYY-MM-DD HH:MM:SS' without timezone.
  // Date.parse treats that as local time — normalize to UTC.
  let s = value
  if (s.includes(' ') && !s.includes('T')) {
    s = s.replace(' ', 'T') + 'Z'
  }
  const ts = Date.parse(s)
  return Number.isNaN(ts) ? 0 : ts
}

function getProjectColumns(db: Database, projectId: string): ColumnConfig[] | null {
  const row = db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(projectId) as
    | { columns_config: string | null }
    | undefined
  return parseColumnsConfig(row?.columns_config)
}

function linearStateToTaskStatus(stateType: string, columns: ColumnConfig[] | null): string {
  switch (stateType) {
    case 'backlog':
      return getStatusByCategories(['backlog', 'unstarted', 'triage'], columns) ?? getDefaultStatus(columns)
    case 'started':
      return getStatusByCategories(['started'], columns) ?? getDefaultStatus(columns)
    case 'completed':
      return getStatusByCategories(['completed'], columns) ?? getDoneStatus(columns)
    case 'canceled':
      return getStatusByCategories(['canceled', 'completed'], columns) ?? getDoneStatus(columns)
    case 'unstarted':
      return getStatusByCategories(['unstarted', 'triage', 'backlog'], columns) ?? getDefaultStatus(columns)
    case 'triage':
      return getStatusByCategories(['triage', 'unstarted', 'backlog'], columns) ?? getDefaultStatus(columns)
    default:
      return getDefaultStatus(columns)
  }
}

function linearPriorityToLocal(priority: number): number {
  if (priority <= 1) return 5
  if (priority === 2) return 4
  if (priority === 3) return 3
  if (priority === 4) return 2
  if (priority >= 5) return 1
  return 3
}

function localPriorityToLinear(priority: number): number {
  if (priority <= 1) return 4
  if (priority === 2) return 4
  if (priority === 3) return 3
  if (priority === 4) return 2
  if (priority >= 5) return 1
  return 3
}

function applyRemoteTaskUpdate(
  db: Database,
  taskId: string,
  issue: LinearIssueSummary,
  localStatus: string
): void {
  db.prepare(`
    UPDATE tasks
    SET title = ?,
        description = ?,
        status = ?,
        priority = ?,
        assignee = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    issue.title,
    issue.description ? markdownToHtml(issue.description) : null,
    localStatus,
    linearPriorityToLocal(issue.priority),
    issue.assignee?.name ?? null,
    issue.updatedAt,
    taskId
  )
}

function getDesiredLinearStateId(
  db: Database,
  mapping: IntegrationProjectMapping | undefined,
  projectId: string,
  taskStatus: string
): string | undefined {
  if (!mapping) return undefined
  const direct = db.prepare(`
    SELECT state_id FROM integration_state_mappings
    WHERE provider = 'linear' AND project_mapping_id = ? AND local_status = ?
  `).get(mapping.id, taskStatus) as { state_id: string } | undefined
  if (direct?.state_id) return direct.state_id

  const projectColumns = getProjectColumns(db, projectId)
  const statusColumn = getColumnById(taskStatus, projectColumns)
  if (!statusColumn) return undefined

  const stateTypeCandidates: Record<WorkflowCategory, string[]> = {
    triage: ['triage', 'unstarted', 'backlog'],
    backlog: ['backlog', 'unstarted', 'triage'],
    unstarted: ['unstarted', 'triage', 'backlog'],
    started: ['started'],
    completed: ['completed', 'canceled'],
    canceled: ['canceled', 'completed']
  }

  for (const stateType of stateTypeCandidates[statusColumn.category]) {
    const byType = db.prepare(`
      SELECT state_id FROM integration_state_mappings
      WHERE provider = 'linear' AND project_mapping_id = ? AND state_type = ?
      ORDER BY rowid ASC
      LIMIT 1
    `).get(mapping.id, stateType) as { state_id: string } | undefined
    if (byType?.state_id) return byType.state_id
  }

  return undefined
}

function getLocalStatusForRemoteState(
  db: Database,
  mapping: IntegrationProjectMapping | undefined,
  projectId: string,
  remoteStateType: string
): string {
  if (mapping) {
    const mapped = db.prepare(`
      SELECT local_status FROM integration_state_mappings
      WHERE provider = 'linear' AND project_mapping_id = ? AND state_type = ?
      ORDER BY rowid ASC
      LIMIT 1
    `).get(mapping.id, remoteStateType) as { local_status: string } | undefined

    const projectColumns = getProjectColumns(db, projectId)
    if (mapped && isKnownStatus(mapped.local_status, projectColumns)) {
      return mapped.local_status
    }
    return linearStateToTaskStatus(remoteStateType, projectColumns)
  }

  return linearStateToTaskStatus(remoteStateType, getProjectColumns(db, projectId))
}

function upsertFieldState(db: Database, externalLinkId: string, field: string, localValue: unknown, externalValue: unknown, localUpdatedAt: string, externalUpdatedAt: string): void {
  db.prepare(`
    INSERT INTO external_field_state (
      id, external_link_id, field_name, last_local_value_json, last_external_value_json,
      last_local_updated_at, last_external_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(external_link_id, field_name) DO UPDATE SET
      last_local_value_json = excluded.last_local_value_json,
      last_external_value_json = excluded.last_external_value_json,
      last_local_updated_at = excluded.last_local_updated_at,
      last_external_updated_at = excluded.last_external_updated_at,
      updated_at = datetime('now')
  `).run(
    crypto.randomUUID(),
    externalLinkId,
    field,
    JSON.stringify(localValue),
    JSON.stringify(externalValue),
    localUpdatedAt,
    externalUpdatedAt
  )
}

function loadTask(db: Database, taskId: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  return row ?? null
}

function loadProjectMappingByTask(db: Database, taskId: string): ProjectMapping | undefined {
  return db.prepare(`
    SELECT pm.*
    FROM integration_project_mappings pm
    JOIN tasks t ON t.project_id = pm.project_id
    WHERE t.id = ? AND pm.provider = 'linear'
  `).get(taskId) as ProjectMapping | undefined
}

export async function runSyncNow(db: Database, input: SyncNowInput): Promise<SyncNowResult> {
  const result: SyncNowResult = {
    scanned: 0,
    pushed: 0,
    pulled: 0,
    conflictsResolved: 0,
    errors: [],
    at: new Date().toISOString()
  }

  const where: string[] = ["l.provider = 'linear'", "c.enabled = 1"]
  const values: unknown[] = []

  if (input.connectionId) {
    where.push('l.connection_id = ?')
    values.push(input.connectionId)
  }
  if (input.taskId) {
    where.push('l.task_id = ?')
    values.push(input.taskId)
  }
  if (input.projectId) {
    where.push('t.project_id = ?')
    values.push(input.projectId)
  }

  const links = db.prepare(`
    SELECT l.*, c.credential_ref
    FROM external_links l
    JOIN integration_connections c ON c.id = l.connection_id
    JOIN tasks t ON t.id = l.task_id
    JOIN integration_project_mappings pm ON pm.project_id = t.project_id AND pm.provider = l.provider
    WHERE ${where.join(' AND ')} AND pm.status_setup_complete = 1
  `).all(...values) as LinkRow[]

  for (const link of links) {
    result.scanned += 1

    try {
      const apiKey = readCredential(db, link.credential_ref)
      const remoteIssue = await getIssue(apiKey, link.external_id)
      if (!remoteIssue) {
        db.prepare(`
          UPDATE external_links
          SET sync_state = 'error', last_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run('Remote issue not found', link.id)
        result.errors.push(`Issue missing: ${link.external_key}`)
        continue
      }

      const task = loadTask(db, link.task_id)
      if (!task) continue

      const localUpdatedMs = toMs(task.updated_at)
      const remoteUpdatedMs = toMs(remoteIssue.updatedAt)

      const mapping = loadProjectMappingByTask(db, task.id)
      const syncMode = mapping?.sync_mode ?? 'one_way'

      if (remoteUpdatedMs > localUpdatedMs) {
        const localStatus = getLocalStatusForRemoteState(
          db,
          mapping,
          task.project_id,
          remoteIssue.state.type
        )
        applyRemoteTaskUpdate(db, task.id, remoteIssue, localStatus)
        result.pulled += 1
        result.conflictsResolved += 1
      } else if (localUpdatedMs > remoteUpdatedMs && syncMode === 'two_way') {
        const stateId = getDesiredLinearStateId(db, mapping, task.project_id, task.status)

        const updatedIssue = await updateIssue(apiKey, link.external_id, {
          title: task.title,
          description: task.description ? htmlToMarkdown(task.description) : null,
          priority: localPriorityToLinear(task.priority),
          stateId,
          assigneeId: null
        })

        if (updatedIssue) {
          result.pushed += 1
          upsertFieldState(db, link.id, 'title', task.title, updatedIssue.title, task.updated_at, updatedIssue.updatedAt)
          upsertFieldState(db, link.id, 'description', task.description, updatedIssue.description, task.updated_at, updatedIssue.updatedAt)
          upsertFieldState(db, link.id, 'priority', task.priority, updatedIssue.priority, task.updated_at, updatedIssue.updatedAt)
          upsertFieldState(db, link.id, 'status', task.status, updatedIssue.state.type, task.updated_at, updatedIssue.updatedAt)
        }
      }

      db.prepare(`
        UPDATE external_links
        SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(link.id)
      db.prepare(`
        UPDATE integration_connections
        SET last_synced_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(link.connection_id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.prepare(`
        UPDATE external_links
        SET sync_state = 'error', last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(message, link.id)
      result.errors.push(`${link.external_key}: ${message}`)
    }
  }

  return result
}

export function startLinearSyncPoller(db: Database): NodeJS.Timeout {
  return setInterval(() => {
    void runSyncNow(db, {}).catch((err) => {
      console.error('Linear periodic sync failed:', err)
    })
  }, 5 * 60 * 1000)
}
