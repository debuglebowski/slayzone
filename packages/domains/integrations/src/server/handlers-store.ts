import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import { listIssues, listProjects, listTeams, getViewer as getLinearViewer } from './linear-client'
import {
  getViewer as getGitHubViewer,
  listIssues as listGitHubRepositoryIssues,
  listRepositories as listGitHubRepositories,
  listProjects as listGitHubProjects,
  listProjectIssues as listGitHubProjectIssues,
  updateIssue as updateGitHubIssue
} from './github-client'
import { deleteCredential, readCredential, storeCredential } from './credentials'
import type {
  ConnectGithubInput,
  ConnectLinearInput,
  UpdateIntegrationConnectionInput,
  ClearProjectProviderInput,
  SetProjectConnectionInput,
  ClearProjectConnectionInput,
  ExternalLink,
  GithubIssueSummary,
  GithubRepositorySummary,
  ImportGithubRepositoryIssuesInput,
  ImportGithubRepositoryIssuesResult,
  ImportGithubIssuesInput,
  ImportGithubIssuesResult,
  ImportLinearIssuesInput,
  ImportLinearIssuesResult,
  IntegrationConnection,
  IntegrationConnectionPublic,
  IntegrationConnectionUsage,
  IntegrationProjectMapping,
  IntegrationProvider,
  ListGithubIssuesInput,
  ListGithubRepositoryIssuesInput,
  ListLinearIssuesInput,
  LinearIssueSummary,
  PullTaskInput,
  PullTaskResult,
  PushTaskInput,
  PushTaskResult,
  SetProjectMappingInput,
  TaskSyncFieldDiff,
  TaskSyncFieldState,
  TaskSyncStatus,
  SyncNowInput,
  FetchProviderStatusesInput,
  ApplyStatusSyncInput,
  ProviderStatus,
  StatusResyncPreview,
  PushUnlinkedTasksInput,
  PushUnlinkedTasksResult,
  BatchTaskSyncStatusItem,
  ListProviderIssuesInput,
  ImportProviderIssuesInput,
  ImportProviderIssuesResult,
  ConnectJiraInput
} from '../shared'
import {
  runProviderSync,
  pushNewTaskToProviders,
  getDesiredRemoteStatusId,
  resolveLocalStatus,
  resolveStatusByCategory
} from './sync'
import { providerStatusesToColumns, computeStatusDiff } from './status-sync'
import { htmlToMarkdown, markdownToHtml } from './markdown'
import {
  toMs,
  getProjectColumns,
  normalizeMarkdown,
  localStatusToGitHubState,
  githubStateToLocal,
  upsertFieldState,
  linearStateToTaskStatus,
  linearPriorityToLocal,
  localPriorityToLinear
} from './sync-helpers'
import {
  getDefaultStatus,
  isTerminalStatus,
  resolveColumns,
  parseColumnsConfig,
  type ColumnConfig,
  type WorkflowCategory
} from '@slayzone/workflow'
import { onTaskReachedTerminal } from '@slayzone/terminal/server'
import { createImportedTaskOp } from '@slayzone/task/server'
import { getAdapter, getRegisteredProviders, normalizeGithubIssue } from './adapters'
import type { NormalizedIssue, ProviderAdapter } from './adapters'

/**
 * Ensure the integration tables exist. Schema DDL is the sync
 * `ensureIntegrationSchemaSync` (worker-safe, single source of truth); this
 * async wrapper routes the registration-time call through the worker.
 */
export async function ensureIntegrationSchema(db: SlayzoneDb): Promise<void> {
  await db.namedTxn('integrations:ensure-schema', {})
}

function toPublicConnection(conn: IntegrationConnection): IntegrationConnectionPublic {
  return {
    id: conn.id,
    provider: conn.provider,
    enabled: Boolean(conn.enabled),
    created_at: conn.created_at,
    updated_at: conn.updated_at,
    last_synced_at: conn.last_synced_at,
    auth_error: conn.auth_error ?? null,
    auth_error_at: conn.auth_error_at ?? null
  }
}

type TaskRow = {
  id: string
  project_id: string
  title: string
  description: string | null
  status: string
  priority: number
  updated_at: string
}

type SyncField = 'title' | 'description' | 'status'

interface ExternalFieldStateRow {
  field_name: string
  last_local_value_json: string
  last_external_value_json: string
}

function parseJsonValue(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

function isSameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function parseGitHubRepositoryFullName(fullName: string): { owner: string; repo: string } | null {
  const match = fullName.trim().match(/^([^/]+)\/([^/]+)$/)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2]
  }
}

function githubRepositoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase()
}

function paginateGithubIssues(
  issues: GithubIssueSummary[],
  limit: number,
  cursor: string | null | undefined
): { issues: GithubIssueSummary[]; nextCursor: string | null } {
  const perPage = Math.max(1, Math.min(limit, 100))
  const page = Math.max(1, Number.parseInt(cursor ?? '1', 10) || 1)
  const start = (page - 1) * perPage
  const end = start + perPage
  return {
    issues: issues.slice(start, end),
    nextCursor: end < issues.length ? String(page + 1) : null
  }
}

function cloneGithubIssue(issue: GithubIssueSummary): GithubIssueSummary {
  return {
    ...issue,
    assignee: issue.assignee ? { ...issue.assignee } : null,
    labels: issue.labels.map((label) => ({ ...label })),
    repository: { ...issue.repository }
  }
}

async function annotateGithubIssueLinks(
  db: SlayzoneDb,
  issues: GithubIssueSummary[]
): Promise<void> {
  const externalIds = issues.map((issue) => issue.id)
  if (externalIds.length === 0) return

  const placeholders = externalIds.map(() => '?').join(',')
  const rows = (await db
    .prepare(`
    SELECT
      l.external_id,
      l.task_id,
      t.project_id,
      p.name AS project_name
    FROM external_links l
    LEFT JOIN tasks t ON t.id = l.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE l.provider = 'github' AND l.external_id IN (${placeholders})
  `)
    .all(...externalIds)) as Array<{
    external_id: string
    task_id: string | null
    project_id: string | null
    project_name: string | null
  }>

  const linkByExternalId = new Map(rows.map((row) => [row.external_id, row]))
  for (const issue of issues) {
    const link = linkByExternalId.get(issue.id)
    issue.linkedTaskId = link?.task_id ?? null
    issue.linkedProjectId = link?.project_id ?? null
    issue.linkedProjectName = link?.project_name ?? null
  }
}

type GithubImportUpsertResult = {
  outcome: 'created' | 'updated' | 'skipped_already_linked'
  taskId: string
  linkedProjectId?: string
}

async function readFieldState(
  db: SlayzoneDb,
  externalLinkId: string
): Promise<Map<SyncField, { local: unknown; external: unknown }>> {
  const rows = (await db
    .prepare(`
    SELECT field_name, last_local_value_json, last_external_value_json
    FROM external_field_state
    WHERE external_link_id = ?
  `)
    .all(externalLinkId)) as ExternalFieldStateRow[]

  const map = new Map<SyncField, { local: unknown; external: unknown }>()
  for (const row of rows) {
    if (
      row.field_name === 'title' ||
      row.field_name === 'description' ||
      row.field_name === 'status'
    ) {
      map.set(row.field_name, {
        local: parseJsonValue(row.last_local_value_json),
        external: parseJsonValue(row.last_external_value_json)
      })
    }
  }
  return map
}

function computeFieldState(
  baseline: { local: unknown; external: unknown } | undefined,
  localValue: unknown,
  remoteValue: unknown,
  localUpdatedAt: string,
  remoteUpdatedAt: string
): TaskSyncFieldState {
  if (!baseline) {
    if (isSameValue(localValue, remoteValue)) return 'in_sync'
    const localUpdatedMs = toMs(localUpdatedAt)
    const remoteUpdatedMs = toMs(remoteUpdatedAt)
    if (localUpdatedMs > remoteUpdatedMs) return 'local_ahead'
    if (remoteUpdatedMs > localUpdatedMs) return 'remote_ahead'
    return 'conflict'
  }

  const localChanged = !isSameValue(localValue, baseline.local)
  const remoteChanged = !isSameValue(remoteValue, baseline.external)
  if (localChanged && remoteChanged) return 'conflict'
  if (localChanged) return 'local_ahead'
  if (remoteChanged) return 'remote_ahead'
  return 'in_sync'
}

function computeOverallState(fields: TaskSyncFieldDiff[]): TaskSyncStatus['state'] {
  const hasConflict = fields.some((field) => field.state === 'conflict')
  const hasLocalAhead = fields.some((field) => field.state === 'local_ahead')
  const hasRemoteAhead = fields.some((field) => field.state === 'remote_ahead')

  if (hasConflict) return 'conflict'
  if (hasLocalAhead && hasRemoteAhead) return 'conflict'
  if (hasLocalAhead) return 'local_ahead'
  if (hasRemoteAhead) return 'remote_ahead'
  return 'in_sync'
}

/**
 * Normalize a baseline external status value to local column ID format.
 * Stored baselines may be in remote format (e.g. 'started' for Linear, 'open' for GitHub).
 */
function normalizeBaselineExternalStatus(
  adapter: ProviderAdapter,
  value: unknown,
  columns: ColumnConfig[] | null
): unknown {
  if (typeof value !== 'string') return value
  // If already a known local column ID, keep it
  if (columns && columns.some((c) => c.id === value)) return value
  // Convert remote status type to local via adapter category mapping
  const category = adapter.remoteStatusToCategory({
    id: value,
    name: value,
    color: '',
    type: value
  })
  return resolveStatusByCategory(category, columns)
}

async function buildTaskSyncStatus(
  db: SlayzoneDb,
  adapter: ProviderAdapter,
  link: ExternalLink,
  task: TaskRow,
  remoteIssue: NormalizedIssue
): Promise<TaskSyncStatus> {
  const columns = await getProjectColumns(db, task.project_id)
  const mapping = (await db
    .prepare(`
    SELECT * FROM integration_project_mappings
    WHERE project_id = ? AND provider = ?
  `)
    .get(task.project_id, adapter.provider)) as IntegrationProjectMapping | undefined

  // Both local and remote status compared in local column ID format
  const remoteStatusAsLocal = await resolveLocalStatus(
    db,
    adapter,
    mapping,
    task.project_id,
    remoteIssue.status.type,
    remoteIssue.status.name
  )

  const localValues: Record<SyncField, unknown> = {
    title: task.title,
    description: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
    status: task.status
  }
  const remoteValues: Record<SyncField, unknown> = {
    title: remoteIssue.title,
    description: normalizeMarkdown(remoteIssue.description),
    status: remoteStatusAsLocal
  }

  const baselineByField = await readFieldState(db, link.id)
  const rawStatusBaseline = baselineByField.get('status')
  const normalizedStatusBaseline = rawStatusBaseline
    ? {
        local: rawStatusBaseline.local,
        external: normalizeBaselineExternalStatus(adapter, rawStatusBaseline.external, columns)
      }
    : undefined

  const fields: TaskSyncFieldDiff[] = (['title', 'description', 'status'] as const).map(
    (field) => ({
      field,
      state: computeFieldState(
        field === 'status' ? normalizedStatusBaseline : baselineByField.get(field),
        localValues[field],
        remoteValues[field],
        task.updated_at,
        remoteIssue.updatedAt
      )
    })
  )

  return {
    provider: adapter.provider,
    taskId: task.id,
    state: computeOverallState(fields),
    fields,
    comparedAt: new Date().toISOString()
  }
}

async function persistGitHubBaseline(
  db: SlayzoneDb,
  linkId: string,
  task: TaskRow,
  remoteIssue: GithubIssueSummary
): Promise<void> {
  await persistNormalizedBaseline(db, linkId, task, normalizeGithubIssue(remoteIssue))
}

async function persistNormalizedBaseline(
  db: SlayzoneDb,
  linkId: string,
  task: TaskRow,
  remoteIssue: NormalizedIssue
): Promise<void> {
  await upsertFieldState(
    db,
    linkId,
    'title',
    task.title,
    remoteIssue.title,
    task.updated_at,
    remoteIssue.updatedAt
  )
  await upsertFieldState(
    db,
    linkId,
    'description',
    normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
    normalizeMarkdown(remoteIssue.description),
    task.updated_at,
    remoteIssue.updatedAt
  )
  await upsertFieldState(
    db,
    linkId,
    'status',
    task.status,
    remoteIssue.status.type,
    task.updated_at,
    remoteIssue.updatedAt
  )
}

async function getTaskById(db: SlayzoneDb, taskId: string): Promise<TaskRow> {
  const row = (await db
    .prepare(`
    SELECT id, project_id, title, description, status, priority, updated_at
    FROM tasks
    WHERE id = ?
  `)
    .get(taskId)) as TaskRow | undefined
  if (!row) throw new Error('Task not found')
  return row
}

async function upsertLinkForIssue(
  db: SlayzoneDb,
  issue: LinearIssueSummary,
  connectionId: string,
  taskId: string
): Promise<ExternalLink> {
  const existing = (await db
    .prepare(
      `SELECT * FROM external_links WHERE provider = 'linear' AND connection_id = ? AND external_id = ?`
    )
    .get(connectionId, issue.id)) as ExternalLink | undefined

  if (existing) {
    await db.prepare(`
      UPDATE external_links
      SET task_id = ?, external_key = ?, external_url = ?, sync_state = 'active',
          last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId, issue.identifier, issue.url, existing.id)
    return (await db
      .prepare('SELECT * FROM external_links WHERE id = ?')
      .get(existing.id)) as ExternalLink
  }

  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO external_links (
      id, provider, connection_id, external_type, external_id, external_key,
      external_url, task_id, sync_state, last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, 'linear', ?, 'issue', ?, ?, ?, ?, 'active', datetime('now'), NULL, datetime('now'), datetime('now'))
  `).run(id, connectionId, issue.id, issue.identifier, issue.url, taskId)

  return (await db.prepare('SELECT * FROM external_links WHERE id = ?').get(id)) as ExternalLink
}

async function upsertTaskFromIssue(
  db: SlayzoneDb,
  localProjectId: string,
  issue: LinearIssueSummary
): Promise<{ outcome: 'created' | 'updated'; taskId: string }> {
  const projectColumns = await getProjectColumns(db, localProjectId)
  const byLink = (await db
    .prepare(`
    SELECT task_id FROM external_links
    WHERE provider = 'linear' AND external_id = ?
  `)
    .get(issue.id)) as { task_id: string } | undefined

  const descHtml = issue.description ? markdownToHtml(issue.description) : null

  if (byLink) {
    await db.prepare(`
      UPDATE tasks
      SET project_id = ?, title = ?, description = ?, status = ?, priority = ?, assignee = ?, updated_at = ?
      WHERE id = ?
    `).run(
      localProjectId,
      issue.title,
      descHtml,
      linearStateToTaskStatus(issue.state.type, projectColumns),
      linearPriorityToLocal(issue.priority),
      issue.assignee?.name ?? null,
      issue.updatedAt,
      byLink.task_id
    )
    return { outcome: 'updated', taskId: byLink.task_id }
  }

  const task = await createImportedTaskOp(db, {
    projectId: localProjectId,
    title: issue.title,
    descriptionHtml: descHtml,
    status: linearStateToTaskStatus(issue.state.type, projectColumns),
    priority: linearPriorityToLocal(issue.priority),
    assignee: issue.assignee?.name ?? null,
    externalUpdatedAt: issue.updatedAt
  })
  if (!task) throw new Error('Failed to create imported Linear task')
  return { outcome: 'created', taskId: task.id }
}

async function upsertLinkForGitHubIssue(
  db: SlayzoneDb,
  issue: GithubIssueSummary,
  connectionId: string,
  taskId: string
): Promise<ExternalLink> {
  const existing = (await db
    .prepare(
      `SELECT * FROM external_links WHERE provider = 'github' AND connection_id = ? AND external_id = ?`
    )
    .get(connectionId, issue.id)) as ExternalLink | undefined

  const externalKey = `${issue.repository.fullName}#${issue.number}`
  if (existing) {
    await db.prepare(`
      UPDATE external_links
      SET task_id = ?, external_key = ?, external_url = ?, sync_state = 'active',
          last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId, externalKey, issue.url, existing.id)
    return (await db
      .prepare('SELECT * FROM external_links WHERE id = ?')
      .get(existing.id)) as ExternalLink
  }

  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO external_links (
      id, provider, connection_id, external_type, external_id, external_key,
      external_url, task_id, sync_state, last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, 'github', ?, 'issue', ?, ?, ?, ?, 'active', datetime('now'), NULL, datetime('now'), datetime('now'))
  `).run(id, connectionId, issue.id, externalKey, issue.url, taskId)

  return (await db.prepare('SELECT * FROM external_links WHERE id = ?').get(id)) as ExternalLink
}

async function upsertTaskFromGitHubIssue(
  db: SlayzoneDb,
  localProjectId: string,
  issue: GithubIssueSummary
): Promise<GithubImportUpsertResult> {
  const projectColumns = await getProjectColumns(db, localProjectId)
  const byLink = (await db
    .prepare(`
    SELECT l.task_id, t.project_id
    FROM external_links l
    LEFT JOIN tasks t ON t.id = l.task_id
    WHERE l.provider = 'github' AND l.external_id = ?
  `)
    .get(issue.id)) as { task_id: string; project_id: string | null } | undefined

  const descHtml = issue.body ? markdownToHtml(issue.body) : null
  if (byLink) {
    if (byLink.project_id && byLink.project_id !== localProjectId) {
      return {
        outcome: 'skipped_already_linked',
        taskId: byLink.task_id,
        linkedProjectId: byLink.project_id
      }
    }

    await db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, status = ?, priority = ?, assignee = ?, updated_at = ?
      WHERE id = ?
    `).run(
      issue.title,
      descHtml,
      githubStateToLocal(issue.state, projectColumns),
      3,
      issue.assignee?.login ?? null,
      issue.updatedAt,
      byLink.task_id
    )
    return {
      outcome: 'updated',
      taskId: byLink.task_id
    }
  }

  const task = await createImportedTaskOp(db, {
    projectId: localProjectId,
    title: issue.title,
    descriptionHtml: descHtml,
    status: githubStateToLocal(issue.state, projectColumns),
    priority: 3,
    assignee: issue.assignee?.login ?? null,
    externalUpdatedAt: issue.updatedAt
  })
  if (!task) throw new Error('Failed to create imported GitHub task')
  return { outcome: 'created', taskId: task.id }
}

type GenericUpsertResult = {
  outcome: 'created' | 'updated' | 'skipped_already_linked'
  taskId: string
}

async function upsertTaskFromNormalizedIssue(
  db: SlayzoneDb,
  adapter: ProviderAdapter,
  localProjectId: string,
  issue: NormalizedIssue,
  projectColumns: ColumnConfig[] | null
): Promise<GenericUpsertResult> {
  const byLink = (await db
    .prepare(`
    SELECT l.task_id, t.project_id
    FROM external_links l
    LEFT JOIN tasks t ON t.id = l.task_id
    WHERE l.provider = ? AND l.external_id = ?
  `)
    .get(adapter.provider, issue.id)) as { task_id: string; project_id: string | null } | undefined

  const descHtml = issue.description ? markdownToHtml(issue.description) : null
  const category = adapter.remoteStatusToCategory({
    id: issue.status.id,
    name: issue.status.name,
    color: '',
    type: issue.status.type
  })
  const localStatus = resolveStatusByCategory(category, projectColumns)

  if (byLink) {
    if (byLink.project_id && byLink.project_id !== localProjectId) {
      return { outcome: 'skipped_already_linked', taskId: byLink.task_id }
    }
    await db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, status = ?, assignee = ?, updated_at = ?
      WHERE id = ?
    `).run(
      issue.title,
      descHtml,
      localStatus,
      issue.assignee?.name ?? null,
      issue.updatedAt,
      byLink.task_id
    )
    return { outcome: 'updated', taskId: byLink.task_id }
  }

  const task = await createImportedTaskOp(db, {
    projectId: localProjectId,
    title: issue.title,
    descriptionHtml: descHtml,
    status: localStatus,
    priority: 3,
    assignee: issue.assignee?.name ?? null,
    externalUpdatedAt: issue.updatedAt
  })
  if (!task) throw new Error(`Failed to create imported ${adapter.provider} task`)
  return { outcome: 'created', taskId: task.id }
}

async function upsertLinkForNormalizedIssue(
  db: SlayzoneDb,
  provider: IntegrationProvider,
  connectionId: string,
  issue: NormalizedIssue,
  adapter: ProviderAdapter,
  taskId: string
): Promise<ExternalLink> {
  const existing = (await db
    .prepare(
      `SELECT * FROM external_links WHERE provider = ? AND connection_id = ? AND external_id = ?`
    )
    .get(provider, connectionId, issue.id)) as ExternalLink | undefined

  const externalKey = adapter.buildExternalKey(issue)
  if (existing) {
    await db.prepare(`
      UPDATE external_links
      SET task_id = ?, external_key = ?, external_url = ?, sync_state = 'active',
          last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId, externalKey, issue.url, existing.id)
    return (await db
      .prepare('SELECT * FROM external_links WHERE id = ?')
      .get(existing.id)) as ExternalLink
  }

  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO external_links (
      id, provider, connection_id, external_type, external_id, external_key,
      external_url, task_id, sync_state, last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, 'issue', ?, ?, ?, ?, 'active', datetime('now'), NULL, datetime('now'), datetime('now'))
  `).run(id, provider, connectionId, issue.id, externalKey, issue.url, taskId)
  return (await db.prepare('SELECT * FROM external_links WHERE id = ?').get(id)) as ExternalLink
}

async function getConnection(db: SlayzoneDb, id: string): Promise<IntegrationConnection> {
  const row = (await db.prepare('SELECT * FROM integration_connections WHERE id = ?').get(id)) as
    | IntegrationConnection
    | undefined
  if (!row) throw new Error('Integration connection not found')
  return row
}

async function getProjectConnectionId(
  db: SlayzoneDb,
  projectId: string,
  provider: IntegrationProvider
): Promise<string | null> {
  const direct = (await db
    .prepare(`
    SELECT connection_id
    FROM integration_project_connections
    WHERE project_id = ? AND provider = ?
  `)
    .get(projectId, provider)) as { connection_id: string } | undefined
  if (direct?.connection_id) {
    return direct.connection_id
  }

  // Backward compatibility for projects mapped before project-scoped connections existed.
  const mapping = (await db
    .prepare(`
    SELECT connection_id
    FROM integration_project_mappings
    WHERE project_id = ? AND provider = ?
  `)
    .get(projectId, provider)) as { connection_id: string } | undefined
  return mapping?.connection_id ?? null
}

async function setProjectConnection(
  db: SlayzoneDb,
  input: SetProjectConnectionInput
): Promise<void> {
  const existing = (await db
    .prepare(`
    SELECT id
    FROM integration_project_connections
    WHERE project_id = ? AND provider = ?
  `)
    .get(input.projectId, input.provider)) as { id: string } | undefined

  await db.prepare(`
    INSERT INTO integration_project_connections (
      id, project_id, provider, connection_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(project_id, provider) DO UPDATE SET
      connection_id = excluded.connection_id,
      updated_at = datetime('now')
  `).run(existing?.id ?? crypto.randomUUID(), input.projectId, input.provider, input.connectionId)
}

async function getConnectionUsage(
  db: SlayzoneDb,
  connection: IntegrationConnection
): Promise<IntegrationConnectionUsage> {
  type ConnectionUsageRow = {
    project_id: string
    project_name: string
    has_mapping: number
    linked_task_count: number
  }

  const rows = (await db
    .prepare(`
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      MAX(CASE WHEN pm.id IS NOT NULL THEN 1 ELSE 0 END) AS has_mapping,
      COUNT(l.id) AS linked_task_count
    FROM projects p
    LEFT JOIN integration_project_mappings pm
      ON pm.project_id = p.id AND pm.connection_id = ?
    LEFT JOIN tasks t
      ON t.project_id = p.id
    LEFT JOIN external_links l
      ON l.task_id = t.id AND l.connection_id = ?
    WHERE pm.id IS NOT NULL OR l.id IS NOT NULL
    GROUP BY p.id, p.name
    ORDER BY p.name COLLATE NOCASE
  `)
    .all(connection.id, connection.id)) as ConnectionUsageRow[]

  const mappedProjectCount = rows.reduce((count, row) => count + (row.has_mapping ? 1 : 0), 0)
  const linkedTaskCount = rows.reduce((count, row) => count + row.linked_task_count, 0)

  return {
    connection_id: connection.id,
    provider: connection.provider,
    mapped_project_count: mappedProjectCount,
    linked_task_count: linkedTaskCount,
    projects: rows.map((row) => ({
      project_id: row.project_id,
      project_name: row.project_name,
      has_mapping: Boolean(row.has_mapping),
      linked_task_count: row.linked_task_count
    }))
  }
}

function assertConnectionProvider(
  connection: IntegrationConnection,
  provider: IntegrationProvider
): void {
  if (connection.provider !== provider) {
    throw new Error(
      `Connection provider mismatch: expected ${provider}, got ${connection.provider}`
    )
  }
}

function getLinearStateTypeForCategory(
  category: WorkflowCategory,
  availableStateTypes: Set<string>
): string | null {
  const candidates: Record<WorkflowCategory, string[]> = {
    triage: ['triage', 'unstarted', 'backlog'],
    backlog: ['backlog', 'unstarted', 'triage'],
    unstarted: ['unstarted', 'triage', 'backlog'],
    started: ['started'],
    completed: ['completed', 'canceled'],
    canceled: ['canceled', 'completed']
  }
  return candidates[category].find((type) => availableStateTypes.has(type)) ?? null
}

async function refreshStateMappings(
  db: SlayzoneDb,
  projectMappingId: string,
  projectId: string,
  states: Array<{ id: string; type: string }>
): Promise<void> {
  const stateIdByType = new Map<string, string>()
  for (const state of states) {
    if (!stateIdByType.has(state.type)) {
      stateIdByType.set(state.type, state.id)
    }
  }

  const columns = resolveColumns(await getProjectColumns(db, projectId))
  const availableStateTypes = new Set(stateIdByType.keys())

  // Atomic delete-then-reinsert; all params are known up-front, so this is a
  // static batch (no read-modify-write).
  const ops: BatchOp[] = [
    {
      type: 'run',
      sql: "DELETE FROM integration_state_mappings WHERE provider = 'linear' AND project_mapping_id = ?",
      params: [projectMappingId]
    }
  ]

  for (const column of columns) {
    const stateType = getLinearStateTypeForCategory(column.category, availableStateTypes)
    if (!stateType) continue
    const stateId = stateIdByType.get(stateType)
    if (!stateId) continue

    ops.push({
      type: 'run',
      sql: `
      INSERT INTO integration_state_mappings (
        id, provider, project_mapping_id, local_status, state_id, state_type, created_at, updated_at
      ) VALUES (?, 'linear', ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(provider, project_mapping_id, local_status) DO UPDATE SET
        state_id = excluded.state_id,
        state_type = excluded.state_type,
        updated_at = datetime('now')
    `,
      params: [crypto.randomUUID(), projectMappingId, column.id, stateId, stateType]
    })
  }

  await db.batchTxn(ops)
}

export type IntegrationOps = ReturnType<typeof createIntegrationOps>

/**
 * Build the integration domain operations bound to `db`. This is the single
 * implementation shared by the IPC handlers (`registerIntegrationHandlers`) and
 * the tRPC `integrationsRouter` while both transports coexist (renderer cutover
 * is a later slice). Electron-free aside from the still-`./main`-sited helper
 * imports; the physical relocation to `src/server/` is the domain-split slice.
 *
 * Test-channel ops (`test*`) are always defined here; the IPC surface still
 * gates their *registration* on `enableTestChannels`. The router exposes them
 * unconditionally (production renderer simply never calls them).
 */
export function createIntegrationOps(
  db: SlayzoneDb,
  _options?: { enableTestChannels?: boolean }
) {
  const githubTestRepositoriesByConnection = new Map<string, GithubRepositorySummary[]>()
  const githubTestIssuesByRepository = new Map<string, GithubIssueSummary[]>()

  const listMockedGithubIssuesForRepository = (
    owner: string,
    repo: string
  ): GithubIssueSummary[] | null => {
    const mockedIssues = githubTestIssuesByRepository.get(githubRepositoryKey(owner, repo))
    return mockedIssues ? mockedIssues.map(cloneGithubIssue) : null
  }

  const getMockedGithubIssue = (
    owner: string,
    repo: string,
    number: number
  ): GithubIssueSummary | null => {
    const mockedIssues = githubTestIssuesByRepository.get(githubRepositoryKey(owner, repo))
    if (!mockedIssues) return null
    const matched = mockedIssues.find((issue) => issue.number === number)
    return matched ? cloneGithubIssue(matched) : null
  }

  const updateGithubIssueWithMocks = async (
    token: string,
    input: {
      owner: string
      repo: string
      number: number
      title: string
      body: string | null
      state: 'open' | 'closed'
    }
  ): Promise<GithubIssueSummary | null> => {
    const repositoryKey = githubRepositoryKey(input.owner, input.repo)
    const mockedIssues = githubTestIssuesByRepository.get(repositoryKey)
    if (mockedIssues) {
      const index = mockedIssues.findIndex((issue) => issue.number === input.number)
      if (index < 0) return null
      const existing = mockedIssues[index]
      const updated: GithubIssueSummary = {
        ...existing,
        title: input.title,
        body: input.body,
        state: input.state,
        updatedAt: new Date().toISOString(),
        assignee: existing.assignee ? { ...existing.assignee } : null,
        labels: existing.labels.map((label) => ({ ...label })),
        repository: { ...existing.repository }
      }
      mockedIssues[index] = updated
      githubTestIssuesByRepository.set(repositoryKey, mockedIssues)
      return cloneGithubIssue(updated)
    }

    return updateGitHubIssue(token, input)
  }

  // Mock-aware adapter helpers: fetch/update remote issues as NormalizedIssue, respecting GitHub test mocks
  const fetchRemoteIssueNormalized = async (
    adapter: ProviderAdapter,
    credential: string,
    link: ExternalLink
  ): Promise<NormalizedIssue | null> => {
    const ctx = adapter.parseExternalKey(link.external_key) ?? undefined
    if (adapter.provider === 'github' && ctx) {
      const { owner, repo, number } = ctx as { owner: string; repo: string; number: number }
      const mocked = getMockedGithubIssue(owner, repo, number)
      if (mocked) return normalizeGithubIssue(mocked)
      if (githubTestIssuesByRepository.has(githubRepositoryKey(owner, repo))) return null
    }
    return adapter.getIssue(credential, link.external_id, ctx)
  }

  const updateRemoteIssueNormalized = async (
    adapter: ProviderAdapter,
    credential: string,
    link: ExternalLink,
    params: {
      title: string
      description: string | null
      statusId?: string
      extras?: Record<string, unknown>
    }
  ): Promise<NormalizedIssue | null> => {
    const ctx = adapter.parseExternalKey(link.external_key) ?? undefined
    if (adapter.provider === 'github' && ctx) {
      const { owner, repo, number } = ctx as { owner: string; repo: string; number: number }
      const updated = await updateGithubIssueWithMocks(credential, {
        owner,
        repo,
        number,
        title: params.title,
        body: params.description,
        state: (params.extras?.state as 'open' | 'closed') ?? 'open'
      })
      return updated ? normalizeGithubIssue(updated) : null
    }
    return adapter.updateIssue(credential, link.external_id, params, ctx)
  }

  const batchFetchRemoteIssuesNormalized = async (
    adapter: ProviderAdapter,
    credential: string,
    links: ExternalLink[]
  ): Promise<Map<string, NormalizedIssue>> => {
    // For GitHub with mocks, fall back to individual fetches
    if (adapter.provider === 'github' && githubTestIssuesByRepository.size > 0) {
      const result = new Map<string, NormalizedIssue>()
      for (const link of links) {
        const issue = await fetchRemoteIssueNormalized(adapter, credential, link)
        if (issue) result.set(link.external_id, issue)
      }
      return result
    }
    const refs = links.map((link) => ({
      id: link.external_id,
      context: adapter.parseExternalKey(link.external_key) ?? undefined
    }))
    return adapter.getIssuesBatch(credential, refs)
  }

  async function pushGithubTask(taskId: string): Promise<void> {
    const adapter = getAdapter('github')
    const link = (await db
      .prepare("SELECT * FROM external_links WHERE task_id = ? AND provider = 'github'")
      .get(taskId)) as ExternalLink | undefined
    if (!link) return

    const task = await getTaskById(db, taskId)
    const mapping = (await db
      .prepare(
        "SELECT * FROM integration_project_mappings WHERE project_id = ? AND provider = 'github'"
      )
      .get(task.project_id)) as IntegrationProjectMapping | undefined
    if (!mapping?.status_setup_complete) return

    const connection = await getConnection(db, link.connection_id)
    assertConnectionProvider(connection, 'github')
    const credential = await readCredential(db, connection.credential_ref)

    const remoteIssue = await fetchRemoteIssueNormalized(adapter, credential, link)
    if (!remoteIssue) return

    const status = await buildTaskSyncStatus(db, adapter, link, task, remoteIssue)
    if (status.state !== 'local_ahead') return

    const columns = await getProjectColumns(db, task.project_id)
    const updatedIssue = await updateRemoteIssueNormalized(adapter, credential, link, {
      title: task.title,
      description: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
      extras: { state: localStatusToGitHubState(task.status, columns) }
    })
    if (!updatedIssue) return

    await persistNormalizedBaseline(db, link.id, task, updatedIssue)
    await db.prepare(
      "UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(link.id)
  }

  return {
    connectGithub: async (input: ConnectGithubInput): Promise<IntegrationConnectionPublic> => {
      const token = input.token.trim()
      if (!token) throw new Error('Token required')

      // Validate credential against provider, but do not persist profile/workspace metadata.
      await getGitHubViewer(token)

      const credentialRef = crypto.randomUUID()
      await storeCredential(db, credentialRef, token)
      const currentProjectConnectionId = input.projectId
        ? await getProjectConnectionId(db, input.projectId, 'github')
        : null

      if (currentProjectConnectionId) {
        const existing = await getConnection(db, currentProjectConnectionId)
        await deleteCredential(db, existing.credential_ref)
        await db.prepare(`
          UPDATE integration_connections
          SET credential_ref = ?, enabled = 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(credentialRef, existing.id)

        if (input.projectId) {
          await setProjectConnection(db, {
            projectId: input.projectId,
            provider: 'github',
            connectionId: existing.id
          })
        }
        return toPublicConnection(await getConnection(db, existing.id))
      }

      const id = crypto.randomUUID()
      await db.prepare(`
        INSERT INTO integration_connections (
          id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
        ) VALUES (?, 'github', ?, 1, datetime('now'), datetime('now'), NULL)
      `).run(id, credentialRef)

      if (input.projectId) {
        await setProjectConnection(db, {
          projectId: input.projectId,
          provider: 'github',
          connectionId: id
        })
      }

      return toPublicConnection(await getConnection(db, id))
    },

    connectLinear: async (input: ConnectLinearInput): Promise<IntegrationConnectionPublic> => {
      const apiKey = input.apiKey.trim()
      if (!apiKey) throw new Error('API key required')

      // Validate credential against provider, but do not persist profile/workspace metadata.
      await getLinearViewer(apiKey)

      const credentialRef = crypto.randomUUID()
      await storeCredential(db, credentialRef, apiKey)
      const currentProjectConnectionId = input.projectId
        ? await getProjectConnectionId(db, input.projectId, 'linear')
        : null

      if (currentProjectConnectionId) {
        const existing = await getConnection(db, currentProjectConnectionId)
        await deleteCredential(db, existing.credential_ref)
        await db.prepare(`
          UPDATE integration_connections
          SET credential_ref = ?, enabled = 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(credentialRef, existing.id)

        if (input.projectId) {
          await setProjectConnection(db, {
            projectId: input.projectId,
            provider: 'linear',
            connectionId: existing.id
          })
        }
        return toPublicConnection(await getConnection(db, existing.id))
      }

      const id = crypto.randomUUID()
      await db.prepare(`
        INSERT INTO integration_connections (
          id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
        ) VALUES (?, 'linear', ?, 1, datetime('now'), datetime('now'), NULL)
      `).run(id, credentialRef)

      if (input.projectId) {
        await setProjectConnection(db, {
          projectId: input.projectId,
          provider: 'linear',
          connectionId: id
        })
      }

      return toPublicConnection(await getConnection(db, id))
    },

    connectJira: async (input: ConnectJiraInput): Promise<IntegrationConnectionPublic> => {
      const domain = input.cloudDomain.trim()
      const email = input.email.trim()
      const apiToken = input.apiToken.trim()
      if (!domain || !email || !apiToken)
        throw new Error('Cloud domain, email, and API token are required')

      const { buildJiraCredential } = await import('./jira-client')
      const credential = buildJiraCredential(email, apiToken, domain)

      const adapter = getAdapter('jira')
      await adapter.validateCredential(credential)

      const credentialRef = crypto.randomUUID()
      await storeCredential(db, credentialRef, credential)
      const currentProjectConnectionId = input.projectId
        ? await getProjectConnectionId(db, input.projectId, 'jira')
        : null

      if (currentProjectConnectionId) {
        const existing = await getConnection(db, currentProjectConnectionId)
        await deleteCredential(db, existing.credential_ref)
        await db.prepare(`
          UPDATE integration_connections
          SET credential_ref = ?, enabled = 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(credentialRef, existing.id)
        if (input.projectId) {
          await setProjectConnection(db, {
            projectId: input.projectId,
            provider: 'jira',
            connectionId: existing.id
          })
        }
        return toPublicConnection(await getConnection(db, existing.id))
      }

      const id = crypto.randomUUID()
      await db.prepare(`
        INSERT INTO integration_connections (
          id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
        ) VALUES (?, 'jira', ?, 1, datetime('now'), datetime('now'), NULL)
      `).run(id, credentialRef)

      if (input.projectId) {
        await setProjectConnection(db, {
          projectId: input.projectId,
          provider: 'jira',
          connectionId: id
        })
      }
      return toPublicConnection(await getConnection(db, id))
    },

    getJiraTransitions: async (taskId: string) => {
      const link = (await db
        .prepare(`
        SELECT * FROM external_links WHERE task_id = ? AND provider = 'jira'
      `)
        .get(taskId)) as ExternalLink | undefined
      if (!link) throw new Error('Task is not linked to Jira')

      const connection = await getConnection(db, link.connection_id)
      const credential = await readCredential(db, connection.credential_ref)
      const { getTransitions } = await import('./jira-client')
      return getTransitions(credential, link.external_key)
    },

    updateConnection: async (
      input: UpdateIntegrationConnectionInput
    ): Promise<IntegrationConnectionPublic> => {
      const connection = await getConnection(db, input.connectionId)
      const credential = input.credential.trim()
      if (!credential) throw new Error('Credential is required')

      const adapter = getAdapter(connection.provider)
      await adapter.validateCredential(credential)

      const credentialRef = crypto.randomUUID()
      await storeCredential(db, credentialRef, credential)
      await deleteCredential(db, connection.credential_ref)
      await db.prepare(`
      UPDATE integration_connections
      SET credential_ref = ?,
          enabled = 1,
          auth_error = NULL,
          auth_error_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(credentialRef, connection.id)
      return toPublicConnection(await getConnection(db, connection.id))
    },

    listConnections: async (
      provider?: IntegrationProvider
    ): Promise<IntegrationConnectionPublic[]> => {
      const rows = provider
        ? await db
            .prepare(
              'SELECT * FROM integration_connections WHERE provider = ? ORDER BY updated_at DESC'
            )
            .all(provider)
        : await db.prepare('SELECT * FROM integration_connections ORDER BY updated_at DESC').all()
      return (rows as IntegrationConnection[]).map(toPublicConnection)
    },

    getConnectionUsage: async (connectionId: string) => {
      const connection = await getConnection(db, connectionId)
      return getConnectionUsage(db, connection)
    },

    disconnect: async (connectionId: string) => {
      const connection = await getConnection(db, connectionId)
      await deleteCredential(db, connection.credential_ref)

      // Cascade delete — all statements + params known up-front, so a static batch.
      await db.batchTxn([
        {
          type: 'run',
          sql: 'DELETE FROM integration_state_mappings WHERE project_mapping_id IN (SELECT id FROM integration_project_mappings WHERE connection_id = ?)',
          params: [connectionId]
        },
        {
          type: 'run',
          sql: 'DELETE FROM integration_project_mappings WHERE connection_id = ?',
          params: [connectionId]
        },
        {
          type: 'run',
          sql: 'DELETE FROM external_field_state WHERE external_link_id IN (SELECT id FROM external_links WHERE connection_id = ?)',
          params: [connectionId]
        },
        {
          type: 'run',
          sql: 'DELETE FROM external_links WHERE connection_id = ?',
          params: [connectionId]
        },
        {
          type: 'run',
          sql: 'DELETE FROM integration_connections WHERE id = ?',
          params: [connectionId]
        }
      ])

      return true
    },

    clearProjectProvider: async (input: ClearProjectProviderInput) => {
      // Cascade clear scoped to (project, provider) — all params known, static batch.
      await db.batchTxn([
        {
          type: 'run',
          sql: `
        DELETE FROM integration_state_mappings
        WHERE project_mapping_id IN (
          SELECT id FROM integration_project_mappings
          WHERE project_id = ? AND provider = ?
        )
      `,
          params: [input.projectId, input.provider]
        },
        {
          type: 'run',
          sql: `
        DELETE FROM integration_project_mappings
        WHERE project_id = ? AND provider = ?
      `,
          params: [input.projectId, input.provider]
        },
        {
          type: 'run',
          sql: `
        DELETE FROM external_field_state
        WHERE external_link_id IN (
          SELECT el.id FROM external_links el
          JOIN tasks t ON t.id = el.task_id
          WHERE el.provider = ? AND t.project_id = ?
        )
      `,
          params: [input.provider, input.projectId]
        },
        {
          type: 'run',
          sql: `
        DELETE FROM external_links
        WHERE provider = ? AND task_id IN (
          SELECT id FROM tasks WHERE project_id = ?
        )
      `,
          params: [input.provider, input.projectId]
        },
        {
          type: 'run',
          sql: `
        DELETE FROM integration_project_connections
        WHERE project_id = ? AND provider = ?
      `,
          params: [input.projectId, input.provider]
        }
      ])
      return true
    },

    getProjectConnection: async (projectId: string, provider: IntegrationProvider) => {
      return getProjectConnectionId(db, projectId, provider)
    },

    setProjectConnection: async (input: SetProjectConnectionInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, input.provider)
      // Read existing row id then upsert — conditional, runs as one worker txn.
      await db.namedTxn('integrations:set-project-connection', input)
      return true
    },

    clearProjectConnection: async (input: ClearProjectConnectionInput) => {
      const connectionId = await getProjectConnectionId(db, input.projectId, input.provider)
      // Cascade clear + GC connection if now unreferenced (count-then-conditional
      // delete) — conditional, runs as one worker txn.
      await db.namedTxn('integrations:clear-project-connection', {
        projectId: input.projectId,
        provider: input.provider,
        connectionId
      })
      return true
    },

    listGithubRepositories: async (connectionId: string) => {
      const mocked = githubTestRepositoriesByConnection.get(connectionId)
      if (mocked) return mocked
      const connection = await getConnection(db, connectionId)
      assertConnectionProvider(connection, 'github')
      const token = await readCredential(db, connection.credential_ref)
      return listGitHubRepositories(token)
    },

    listGithubProjects: async (connectionId: string) => {
      const connection = await getConnection(db, connectionId)
      assertConnectionProvider(connection, 'github')
      const token = await readCredential(db, connection.credential_ref)
      return listGitHubProjects(token)
    },

    listLinearTeams: async (connectionId: string) => {
      const connection = await getConnection(db, connectionId)
      assertConnectionProvider(connection, 'linear')
      const apiKey = await readCredential(db, connection.credential_ref)
      return listTeams(apiKey)
    },

    listLinearProjects: async (connectionId: string, teamId: string) => {
      const connection = await getConnection(db, connectionId)
      assertConnectionProvider(connection, 'linear')
      const apiKey = await readCredential(db, connection.credential_ref)
      return listProjects(apiKey, teamId)
    },

    setProjectMapping: async (input: SetProjectMappingInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, input.provider)
      const otherProvider: IntegrationProvider = input.provider === 'github' ? 'linear' : 'github'

      // Clear sibling provider, (re)point connection, then upsert mapping. Reads
      // the existing mapping id to reuse it (conditional), so this runs as one
      // worker txn that returns the id used.
      const mappingId = await db.namedTxn('integrations:set-project-mapping', {
        input,
        otherProvider
      })

      if (input.provider === 'linear') {
        const apiKey = await readCredential(db, connection.credential_ref)
        const adapter = getAdapter('linear')
        const states = await adapter.fetchStatuses(apiKey, input.externalTeamId)
        await refreshStateMappings(
          db,
          mappingId,
          input.projectId,
          states.map((s) => ({ id: s.id, type: s.type ?? 'unknown' }))
        )
      }

      return (await db
        .prepare('SELECT * FROM integration_project_mappings WHERE id = ?')
        .get(mappingId)) as IntegrationProjectMapping
    },

    getProjectMapping: async (projectId: string, provider: IntegrationProvider) => {
      const row = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `)
        .get(projectId, provider)) as IntegrationProjectMapping | undefined
      return row ?? null
    },

    listGithubIssues: async (input: ListGithubIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, 'github')
      const token = await readCredential(db, connection.credential_ref)
      const mapping = input.projectId
        ? ((await db
            .prepare(`
          SELECT * FROM integration_project_mappings
          WHERE project_id = ? AND provider = 'github'
        `)
            .get(input.projectId)) as IntegrationProjectMapping | undefined)
        : undefined

      const githubProjectId = input.githubProjectId ?? mapping?.external_project_id ?? undefined
      if (!githubProjectId) {
        throw new Error('No GitHub Project selected and project is not mapped to a GitHub Project')
      }

      const data = await listGitHubProjectIssues(token, {
        projectId: githubProjectId,
        limit: input.limit ?? 50,
        cursor: input.cursor ?? null
      })

      await annotateGithubIssueLinks(db, data.issues)

      return data
    },

    listGithubRepositoryIssues: async (input: ListGithubRepositoryIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, 'github')
      const repository = parseGitHubRepositoryFullName(input.repositoryFullName)
      if (!repository) {
        throw new Error('Repository must be in owner/repo format')
      }

      const mockedIssues = listMockedGithubIssuesForRepository(repository.owner, repository.repo)
      const data = mockedIssues
        ? paginateGithubIssues(mockedIssues, input.limit ?? 50, input.cursor ?? null)
        : await (async () => {
            const token = await readCredential(db, connection.credential_ref)
            return listGitHubRepositoryIssues(token, {
              owner: repository.owner,
              repo: repository.repo,
              limit: input.limit ?? 50,
              cursor: input.cursor ?? null
            })
          })()

      await annotateGithubIssueLinks(db, data.issues)

      return data
    },

    listLinearIssues: async (input: ListLinearIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, 'linear')
      const apiKey = await readCredential(db, connection.credential_ref)
      const mapping = input.projectId
        ? ((await db
            .prepare(`
          SELECT * FROM integration_project_mappings
          WHERE project_id = ? AND provider = 'linear'
        `)
            .get(input.projectId)) as IntegrationProjectMapping | undefined)
        : undefined

      const data = await listIssues(apiKey, {
        teamId: input.teamId ?? mapping?.external_team_id,
        projectId: input.linearProjectId ?? mapping?.external_project_id ?? undefined,
        first: input.limit ?? 50,
        after: input.cursor ?? null,
        assignedToMe: input.assignedToMe
      })

      const externalIds = data.issues.map((i) => i.id)
      if (externalIds.length > 0) {
        const placeholders = externalIds.map(() => '?').join(',')
        const links = (await db
          .prepare(`
        SELECT external_id, task_id FROM external_links
        WHERE provider = 'linear' AND external_id IN (${placeholders})
      `)
          .all(...externalIds)) as Array<{ external_id: string; task_id: string }>
        const linkMap = new Map(links.map((l) => [l.external_id, l.task_id]))
        for (const issue of data.issues) {
          issue.linkedTaskId = linkMap.get(issue.id) ?? null
        }
      }

      return data
    },

    importGithubIssues: async (input: ImportGithubIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, 'github')
      const mapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = 'github'
    `)
        .get(input.projectId)) as IntegrationProjectMapping | undefined

      if (mapping && !mapping.status_setup_complete) {
        throw new Error('Status setup must be completed before importing issues')
      }

      const token = await readCredential(db, connection.credential_ref)
      const githubProjectId = input.githubProjectId ?? mapping?.external_project_id ?? undefined
      if (!githubProjectId) {
        throw new Error('No GitHub Project selected and project is not mapped to a GitHub Project')
      }

      const data = await listGitHubProjectIssues(token, {
        projectId: githubProjectId,
        limit: input.limit ?? 50,
        cursor: input.cursor ?? null
      })

      let imported = 0
      let linked = 0
      let created = 0
      let updated = 0
      let skippedAlreadyLinked = 0
      const selectedIds = input.selectedIssueIds?.length ? new Set(input.selectedIssueIds) : null

      for (const issue of data.issues) {
        if (selectedIds && !selectedIds.has(issue.id)) continue
        const upsert = await upsertTaskFromGitHubIssue(db, input.projectId, issue)
        if (upsert.outcome === 'skipped_already_linked') {
          skippedAlreadyLinked += 1
          continue
        }
        const link = await upsertLinkForGitHubIssue(db, issue, input.connectionId, upsert.taskId)
        const task = await getTaskById(db, upsert.taskId)
        await persistGitHubBaseline(db, link.id, task, issue)
        imported += 1
        linked += 1
        if (upsert.outcome === 'created') created += 1
        if (upsert.outcome === 'updated') updated += 1
      }

      const result: ImportGithubIssuesResult = {
        imported,
        linked,
        created,
        updated,
        skippedAlreadyLinked,
        nextCursor: data.nextCursor
      }
      return result
    },

    importGithubRepositoryIssues: async (input: ImportGithubRepositoryIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, 'github')

      const ghMapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = 'github'
    `)
        .get(input.projectId)) as IntegrationProjectMapping | undefined
      if (ghMapping && !ghMapping.status_setup_complete) {
        throw new Error('Status setup must be completed before importing issues')
      }

      const repository = parseGitHubRepositoryFullName(input.repositoryFullName)
      if (!repository) {
        throw new Error('Repository must be in owner/repo format')
      }

      const mockedIssues = listMockedGithubIssuesForRepository(repository.owner, repository.repo)
      const data = mockedIssues
        ? paginateGithubIssues(mockedIssues, input.limit ?? 50, input.cursor ?? null)
        : await (async () => {
            const token = await readCredential(db, connection.credential_ref)
            return listGitHubRepositoryIssues(token, {
              owner: repository.owner,
              repo: repository.repo,
              limit: input.limit ?? 50,
              cursor: input.cursor ?? null
            })
          })()

      let imported = 0
      let linked = 0
      let created = 0
      let updated = 0
      let skippedAlreadyLinked = 0
      const selectedIds = input.selectedIssueIds?.length ? new Set(input.selectedIssueIds) : null

      for (const issue of data.issues) {
        if (selectedIds && !selectedIds.has(issue.id)) continue
        const upsert = await upsertTaskFromGitHubIssue(db, input.projectId, issue)
        if (upsert.outcome === 'skipped_already_linked') {
          skippedAlreadyLinked += 1
          continue
        }
        const link = await upsertLinkForGitHubIssue(db, issue, input.connectionId, upsert.taskId)
        const task = await getTaskById(db, upsert.taskId)
        await persistGitHubBaseline(db, link.id, task, issue)
        imported += 1
        linked += 1
        if (upsert.outcome === 'created') created += 1
        if (upsert.outcome === 'updated') updated += 1
      }

      const result: ImportGithubRepositoryIssuesResult = {
        imported,
        linked,
        created,
        updated,
        skippedAlreadyLinked,
        nextCursor: data.nextCursor
      }
      return result
    },

    importLinearIssues: async (input: ImportLinearIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, 'linear')
      const mapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = 'linear'
    `)
        .get(input.projectId)) as IntegrationProjectMapping | undefined

      if (mapping && !mapping.status_setup_complete) {
        throw new Error('Status setup must be completed before importing issues')
      }

      const teamId = input.teamId ?? mapping?.external_team_id
      if (!teamId) {
        throw new Error('No team specified and project is not mapped to Linear')
      }

      const apiKey = await readCredential(db, connection.credential_ref)
      const data = await listIssues(apiKey, {
        teamId,
        projectId: input.linearProjectId ?? mapping?.external_project_id ?? undefined,
        first: input.limit ?? 25,
        after: input.cursor ?? null
      })

      let imported = 0
      let linked = 0

      const selectedIds = input.selectedIssueIds?.length ? new Set(input.selectedIssueIds) : null

      for (const issue of data.issues) {
        if (selectedIds && !selectedIds.has(issue.id)) continue
        const upsert = await upsertTaskFromIssue(db, input.projectId, issue)
        await upsertLinkForIssue(db, issue, input.connectionId, upsert.taskId)
        imported += 1
        linked += 1
      }

      const result: ImportLinearIssuesResult = {
        imported,
        linked,
        nextCursor: data.nextCursor
      }

      return result
    },

    syncNow: async (input: SyncNowInput) => {
      const providers = getRegisteredProviders()
      const results = await Promise.all(
        providers.map((provider) => runProviderSync(db, provider, input))
      )
      return {
        scanned: results.reduce((s, r) => s + r.scanned, 0),
        pushed: results.reduce((s, r) => s + r.pushed, 0),
        pulled: results.reduce((s, r) => s + r.pulled, 0),
        conflictsResolved: results.reduce((s, r) => s + r.conflictsResolved, 0),
        errors: results.flatMap((r) => r.errors),
        at: results[0]?.at ?? new Date().toISOString()
      }
    },

    getTaskSyncStatus: async (taskId: string, provider: IntegrationProvider) => {
      const adapter = getAdapter(provider)
      const link = (await db
        .prepare(`
      SELECT * FROM external_links WHERE task_id = ? AND provider = ?
    `)
        .get(taskId, provider)) as ExternalLink | undefined

      if (!link) {
        return {
          provider,
          taskId,
          state: 'unknown',
          fields: [],
          comparedAt: new Date().toISOString()
        } as TaskSyncStatus
      }

      const connection = await getConnection(db, link.connection_id)
      assertConnectionProvider(connection, provider)
      const credential = await readCredential(db, connection.credential_ref)
      const remoteIssue = await fetchRemoteIssueNormalized(adapter, credential, link)
      if (!remoteIssue) {
        throw new Error(`Linked ${provider} issue no longer exists`)
      }

      const task = await getTaskById(db, taskId)
      return buildTaskSyncStatus(db, adapter, link, task, remoteIssue)
    },

    getBatchTaskSyncStatus: async (
      taskIds: string[],
      provider: IntegrationProvider
    ): Promise<BatchTaskSyncStatusItem[]> => {
      if (taskIds.length === 0) return []
      const adapter = getAdapter(provider)
      const placeholders = taskIds.map(() => '?').join(',')
      const links = (await db
        .prepare(`
      SELECT * FROM external_links WHERE task_id IN (${placeholders}) AND provider = ?
    `)
        .all(...taskIds, provider)) as ExternalLink[]
      const linkByTaskId = new Map(links.map((l) => [l.task_id, l]))

      const connectionIds = [...new Set(links.map((l) => l.connection_id))]
      const results: BatchTaskSyncStatusItem[] = []
      const now = new Date().toISOString()

      for (const connId of connectionIds) {
        const connection = await getConnection(db, connId)
        assertConnectionProvider(connection, provider)
        const credential = await readCredential(db, connection.credential_ref)
        const connLinks = links.filter((l) => l.connection_id === connId)
        const issueMap = await batchFetchRemoteIssuesNormalized(adapter, credential, connLinks)

        for (const link of connLinks) {
          const remoteIssue = issueMap.get(link.external_id)
          if (!remoteIssue) {
            results.push({
              taskId: link.task_id,
              link,
              status: {
                provider,
                taskId: link.task_id,
                state: 'unknown',
                fields: [],
                comparedAt: now
              }
            })
            continue
          }
          const task = await getTaskById(db, link.task_id)
          results.push({
            taskId: link.task_id,
            link,
            status: await buildTaskSyncStatus(db, adapter, link, task, remoteIssue)
          })
        }
      }

      for (const taskId of taskIds) {
        if (!linkByTaskId.has(taskId)) {
          results.push({
            taskId,
            link: null,
            status: { provider, taskId, state: 'unknown', fields: [], comparedAt: now }
          })
        }
      }

      return results
    },

    pushTask: async (input: PushTaskInput) => {
      const adapter = getAdapter(input.provider)
      const link = (await db
        .prepare(`
      SELECT * FROM external_links WHERE task_id = ? AND provider = ?
    `)
        .get(input.taskId, input.provider)) as ExternalLink | undefined
      if (!link) throw new Error(`Task is not linked to ${input.provider}`)

      const pushTaskRow = await getTaskById(db, input.taskId)
      const pushMapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings WHERE project_id = ? AND provider = ?
    `)
        .get(pushTaskRow.project_id, input.provider)) as IntegrationProjectMapping | undefined
      if (pushMapping && !pushMapping.status_setup_complete)
        throw new Error('Status setup must be completed before pushing')

      const connection = await getConnection(db, link.connection_id)
      assertConnectionProvider(connection, input.provider)
      const credential = await readCredential(db, connection.credential_ref)
      const task = await getTaskById(db, input.taskId)
      const providerName = input.provider.charAt(0).toUpperCase() + input.provider.slice(1)

      const remoteIssue = await fetchRemoteIssueNormalized(adapter, credential, link)
      if (!remoteIssue) throw new Error(`Linked ${providerName} issue no longer exists`)

      const statusBefore = await buildTaskSyncStatus(db, adapter, link, task, remoteIssue)
      if (statusBefore.state === 'in_sync') {
        return {
          pushed: false,
          status: statusBefore,
          message: `Task is already in sync with ${providerName}`
        } as PushTaskResult
      }
      if (
        !input.force &&
        (statusBefore.state === 'remote_ahead' || statusBefore.state === 'conflict')
      ) {
        return {
          pushed: false,
          status: statusBefore,
          message: 'Remote changes detected. Refresh diff and resolve before pushing.'
        } as PushTaskResult
      }

      const statusId = await getDesiredRemoteStatusId(db, pushMapping, task.project_id, task.status)
      const extras: Record<string, unknown> = {}
      if (input.provider === 'linear') extras.priority = localPriorityToLinear(task.priority)
      if (input.provider === 'github') {
        const columns = await getProjectColumns(db, task.project_id)
        extras.state = localStatusToGitHubState(task.status, columns)
      }

      const updatedIssue = await updateRemoteIssueNormalized(adapter, credential, link, {
        title: task.title,
        description: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
        statusId,
        extras
      })
      if (!updatedIssue) throw new Error(`Failed to update ${providerName} issue`)

      await persistNormalizedBaseline(db, link.id, task, updatedIssue)
      await db.prepare(
        `UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(link.id)
      await db.prepare(
        `UPDATE integration_connections SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(connection.id)

      const statusAfter = await buildTaskSyncStatus(db, adapter, link, task, updatedIssue)
      return {
        pushed: true,
        status: statusAfter,
        message: `Pushed local changes to ${providerName}`
      } as PushTaskResult
    },

    pullTask: async (input: PullTaskInput) => {
      const adapter = getAdapter(input.provider)
      const link = (await db
        .prepare(`
      SELECT * FROM external_links WHERE task_id = ? AND provider = ?
    `)
        .get(input.taskId, input.provider)) as ExternalLink | undefined
      if (!link) throw new Error(`Task is not linked to ${input.provider}`)

      const pullTaskRow = await getTaskById(db, input.taskId)
      const pullMapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings WHERE project_id = ? AND provider = ?
    `)
        .get(pullTaskRow.project_id, input.provider)) as IntegrationProjectMapping | undefined
      if (pullMapping && !pullMapping.status_setup_complete)
        throw new Error('Status setup must be completed before pulling')

      const connection = await getConnection(db, link.connection_id)
      assertConnectionProvider(connection, input.provider)
      const credential = await readCredential(db, connection.credential_ref)
      const task = await getTaskById(db, input.taskId)
      const providerName = input.provider.charAt(0).toUpperCase() + input.provider.slice(1)

      const remoteIssue = await fetchRemoteIssueNormalized(adapter, credential, link)
      if (!remoteIssue) throw new Error(`Linked ${providerName} issue no longer exists`)

      const statusBefore = await buildTaskSyncStatus(db, adapter, link, task, remoteIssue)
      if (statusBefore.state === 'in_sync') {
        return {
          pulled: false,
          status: statusBefore,
          message: `Task is already in sync with ${providerName}`
        } as PullTaskResult
      }
      if (
        !input.force &&
        (statusBefore.state === 'local_ahead' || statusBefore.state === 'conflict')
      ) {
        return {
          pulled: false,
          status: statusBefore,
          message:
            'Local changes detected. Push local changes or force pull to overwrite local fields.'
        } as PullTaskResult
      }

      // Apply remote changes to local task
      const localStatus = await resolveLocalStatus(
        db,
        adapter,
        pullMapping,
        task.project_id,
        remoteIssue.status.type,
        remoteIssue.status.name
      )
      const hasPriority = remoteIssue.extras.priority !== undefined
      if (hasPriority) {
        await db.prepare(
          `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee = ?, updated_at = ? WHERE id = ?`
        ).run(
          remoteIssue.title,
          remoteIssue.description ? markdownToHtml(remoteIssue.description) : null,
          localStatus,
          linearPriorityToLocal(remoteIssue.extras.priority as number),
          remoteIssue.assignee?.name ?? null,
          remoteIssue.updatedAt,
          task.id
        )
      } else {
        await db.prepare(
          `UPDATE tasks SET title = ?, description = ?, status = ?, assignee = ?, updated_at = ? WHERE id = ?`
        ).run(
          remoteIssue.title,
          remoteIssue.description ? markdownToHtml(remoteIssue.description) : null,
          localStatus,
          remoteIssue.assignee?.name ?? null,
          remoteIssue.updatedAt,
          task.id
        )
      }
      const updatedTask = await getTaskById(db, task.id)
      await persistNormalizedBaseline(db, link.id, updatedTask, remoteIssue)

      const pullProjectColumns = (await db
        .prepare('SELECT columns_config FROM projects WHERE id = ?')
        .get(task.project_id)) as { columns_config: string | null } | undefined
      if (
        isTerminalStatus(localStatus, parseColumnsConfig(pullProjectColumns?.columns_config ?? null))
      ) {
        onTaskReachedTerminal(task.id)
      }

      await db.prepare(
        `UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(link.id)
      await db.prepare(
        `UPDATE integration_connections SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(connection.id)

      const statusAfter = await buildTaskSyncStatus(db, adapter, link, updatedTask, remoteIssue)
      return {
        pulled: true,
        status: statusAfter,
        message: `Pulled remote changes from ${providerName}`
      } as PullTaskResult
    },

    getLink: async (taskId: string, provider: IntegrationProvider) => {
      const row = (await db
        .prepare(`
      SELECT * FROM external_links
      WHERE task_id = ? AND provider = ?
    `)
        .get(taskId, provider)) as ExternalLink | undefined
      return row ?? null
    },

    unlinkTask: async (taskId: string, provider: IntegrationProvider) => {
      await db.prepare(`
      DELETE FROM external_field_state
      WHERE external_link_id IN (
        SELECT id FROM external_links WHERE task_id = ? AND provider = ?
      )
    `).run(taskId, provider)

      const res = await db
        .prepare('DELETE FROM external_links WHERE task_id = ? AND provider = ?')
        .run(taskId, provider)
      return res.changes > 0
    },

    pushUnlinkedTasks: async (input: PushUnlinkedTasksInput): Promise<PushUnlinkedTasksResult> => {
      const unlinkedTasks = (await db
        .prepare(`
      SELECT t.id, t.project_id FROM tasks t
      WHERE t.project_id = ?
        AND t.is_temporary = 0
        AND NOT EXISTS (
          SELECT 1 FROM external_links el WHERE el.task_id = t.id AND el.provider = ?
        )
    `)
        .all(input.projectId, input.provider)) as Array<{ id: string; project_id: string }>

      let pushed = 0
      const errors: string[] = []
      for (const task of unlinkedTasks) {
        try {
          // Re-check right before push to prevent duplicate creation from concurrent calls
          const alreadyLinked = await db
            .prepare('SELECT id FROM external_links WHERE task_id = ? AND provider = ?')
            .get(task.id, input.provider)
          if (alreadyLinked) continue

          await pushNewTaskToProviders(db, task.id, task.project_id)
          const link = await db
            .prepare('SELECT id FROM external_links WHERE task_id = ? AND provider = ?')
            .get(task.id, input.provider)
          if (link) pushed++
        } catch (err) {
          errors.push(`${task.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return { pushed, errors }
    },

    fetchProviderStatuses: async (
      input: FetchProviderStatusesInput
    ): Promise<ProviderStatus[]> => {
      const connection = await getConnection(db, input.connectionId)
      assertConnectionProvider(connection, input.provider)
      const credential = await readCredential(db, connection.credential_ref)
      const adapter = getAdapter(input.provider)
      return adapter.fetchStatuses(credential, input.externalTeamId, input.externalProjectId)
    },

    applyStatusSync: async (input: ApplyStatusSyncInput) => {
      const mapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `)
        .get(input.projectId, input.provider)) as IntegrationProjectMapping | undefined
      if (!mapping) throw new Error('No integration mapping found for this project')

      const { columns: newColumns, providerIdToColumnId } = providerStatusesToColumns(
        input.provider,
        input.statuses
      )

      // Remap existing tasks
      if (input.taskRemapping && Object.keys(input.taskRemapping).length > 0) {
        for (const [oldStatus, newStatus] of Object.entries(input.taskRemapping)) {
          if (!newColumns.some((c) => c.id === newStatus)) continue
          const reachedTerminal = isTerminalStatus(newStatus, newColumns)
          const affectedIds = reachedTerminal
            ? ((await db
                .prepare('SELECT id FROM tasks WHERE project_id = ? AND status = ?')
                .all(input.projectId, oldStatus)) as Array<{ id: string }>).map((r) => r.id)
            : []
          await db.prepare(
            "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE project_id = ? AND status = ?"
          ).run(newStatus, input.projectId, oldStatus)
          for (const id of affectedIds) onTaskReachedTerminal(id)
        }
      }

      // Update project columns_config
      await db.prepare(
        "UPDATE projects SET columns_config = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(newColumns), input.projectId)

      // Normalize any tasks with statuses not in the new column set
      const defaultStatus = getDefaultStatus(newColumns)
      const newStatusIds = newColumns.map((c) => c.id)
      const placeholders = newStatusIds.map(() => '?').join(',')
      await db.prepare(
        `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE project_id = ? AND status NOT IN (${placeholders})`
      ).run(defaultStatus, input.projectId, ...newStatusIds)

      // Rebuild integration_state_mappings using the mapping from providerStatusesToColumns
      await db.prepare('DELETE FROM integration_state_mappings WHERE project_mapping_id = ?').run(
        mapping.id
      )

      for (const status of input.statuses) {
        const colId = providerIdToColumnId.get(status.id)
        if (!colId) continue
        await db.prepare(`
        INSERT INTO integration_state_mappings (
          id, provider, project_mapping_id, local_status, state_id, state_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
          crypto.randomUUID(),
          input.provider,
          mapping.id,
          colId,
          status.id,
          status.type ?? 'unknown'
        )
      }

      // Mark status setup complete
      await db.prepare(
        "UPDATE integration_project_mappings SET status_setup_complete = 1, updated_at = datetime('now') WHERE id = ?"
      ).run(mapping.id)

      const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId)
      return project
    },

    resyncProviderStatuses: async (input: {
      projectId: string
      provider: IntegrationProvider
    }): Promise<StatusResyncPreview> => {
      const mapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `)
        .get(input.projectId, input.provider)) as IntegrationProjectMapping | undefined
      if (!mapping) throw new Error('No integration mapping found for this project')

      const connection = await getConnection(db, mapping.connection_id)
      const credential = await readCredential(db, connection.credential_ref)

      const adapter = getAdapter(input.provider)
      const providerStatuses = await adapter.fetchStatuses(
        credential,
        mapping.external_team_id,
        mapping.external_project_id ?? undefined
      )

      // Build local_status -> provider_status_id map from integration_state_mappings
      const stateMappingRows = (await db
        .prepare(`
      SELECT local_status, state_id FROM integration_state_mappings
      WHERE project_mapping_id = ?
    `)
        .all(mapping.id)) as Array<{ local_status: string; state_id: string }>
      const currentIdMap = new Map(stateMappingRows.map((r) => [r.local_status, r.state_id]))

      const current = resolveColumns(await getProjectColumns(db, input.projectId))
      const { columns: incoming } = providerStatusesToColumns(input.provider, providerStatuses)
      const diff = computeStatusDiff(current, providerStatuses, currentIdMap)

      return { current, incoming, diff, providerStatuses }
    },

    // --- Generic provider-dispatched handlers ---

    listProviderGroups: async (connectionId: string) => {
      const connection = await getConnection(db, connectionId)
      const adapter = getAdapter(connection.provider)
      const credential = await readCredential(db, connection.credential_ref)
      return adapter.listGroups(credential)
    },

    listProviderScopes: async (connectionId: string, groupId: string) => {
      const connection = await getConnection(db, connectionId)
      const adapter = getAdapter(connection.provider)
      const credential = await readCredential(db, connection.credential_ref)
      return adapter.listScopes(credential, groupId)
    },

    listProviderIssues: async (input: ListProviderIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      const adapter = getAdapter(connection.provider)
      const credential = await readCredential(db, connection.credential_ref)

      const mapping = input.projectId
        ? ((await db
            .prepare(`
          SELECT * FROM integration_project_mappings
          WHERE project_id = ? AND provider = ?
        `)
            .get(input.projectId, connection.provider)) as IntegrationProjectMapping | undefined)
        : undefined

      const groupId = input.groupId ?? mapping?.external_team_id
      if (!groupId) {
        throw new Error('No group specified and project has no mapping')
      }

      const data = await adapter.listIssues(credential, {
        groupId,
        scopeId: input.scopeId ?? mapping?.external_project_id ?? undefined,
        limit: input.limit ?? 50,
        cursor: input.cursor ?? null
      })

      // Annotate with linked task IDs
      if (data.issues.length > 0) {
        const externalIds = data.issues.map((i) => i.id)
        const placeholders = externalIds.map(() => '?').join(',')
        const links = (await db
          .prepare(`
        SELECT external_id, task_id FROM external_links
        WHERE provider = ? AND external_id IN (${placeholders})
      `)
          .all(connection.provider, ...externalIds)) as Array<{
          external_id: string
          task_id: string
        }>
        const linkMap = new Map(links.map((l) => [l.external_id, l.task_id]))
        for (const issue of data.issues) {
          ;(issue as { linkedTaskId?: string | null }).linkedTaskId = linkMap.get(issue.id) ?? null
        }
      }

      return data
    },

    importProviderIssues: async (input: ImportProviderIssuesInput) => {
      const connection = await getConnection(db, input.connectionId)
      const adapter = getAdapter(connection.provider)
      const credential = await readCredential(db, connection.credential_ref)

      const mapping = (await db
        .prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `)
        .get(input.projectId, connection.provider)) as IntegrationProjectMapping | undefined

      if (mapping && !mapping.status_setup_complete) {
        throw new Error('Status setup must be completed before importing issues')
      }

      const groupId = input.groupId ?? mapping?.external_team_id
      if (!groupId) {
        throw new Error('No group specified and project has no mapping')
      }

      const data = await adapter.listIssues(credential, {
        groupId,
        scopeId: input.scopeId ?? mapping?.external_project_id ?? undefined,
        limit: input.limit ?? 50,
        cursor: input.cursor ?? null
      })

      const projectColumns = await getProjectColumns(db, input.projectId)
      const selectedIds = input.selectedIssueIds?.length ? new Set(input.selectedIssueIds) : null

      let imported = 0
      let linked = 0
      let created = 0
      let updated = 0
      let skippedAlreadyLinked = 0

      for (const issue of data.issues) {
        if (selectedIds && !selectedIds.has(issue.id)) continue

        const result = await upsertTaskFromNormalizedIssue(
          db,
          adapter,
          input.projectId,
          issue,
          projectColumns
        )
        if (result.outcome === 'skipped_already_linked') {
          skippedAlreadyLinked += 1
          continue
        }

        const link = await upsertLinkForNormalizedIssue(
          db,
          connection.provider,
          input.connectionId,
          issue,
          adapter,
          result.taskId
        )
        const task = await getTaskById(db, result.taskId)
        await persistNormalizedBaseline(db, link.id, task, issue)

        imported += 1
        linked += 1
        if (result.outcome === 'created') created += 1
        if (result.outcome === 'updated') updated += 1
      }

      return {
        imported,
        linked,
        created,
        updated,
        skippedAlreadyLinked,
        nextCursor: data.nextCursor
      } satisfies ImportProviderIssuesResult
    },

    // --- Test channel ops (always defined; IPC gates registration on enableTestChannels) ---

    testSeedGithubConnection: async (input: {
      id?: string
      projectId?: string
      token?: string
      repositories?: GithubRepositorySummary[]
    }): Promise<IntegrationConnectionPublic> => {
      const existingConnectionId = input.projectId
        ? await getProjectConnectionId(db, input.projectId, 'github')
        : null
      const existing = existingConnectionId
        ? await getConnection(db, existingConnectionId)
        : undefined
      const connectionId = existing?.id ?? input.id ?? crypto.randomUUID()
      const credentialRef = crypto.randomUUID()
      await storeCredential(db, credentialRef, input.token ?? 'ghp_test_e2e')
      if (existing) {
        await deleteCredential(db, existing.credential_ref)
      }

      await db.prepare(`
        INSERT INTO integration_connections (
          id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
        ) VALUES (?, 'github', ?, 1, datetime('now'), datetime('now'), NULL)
        ON CONFLICT(id) DO UPDATE SET
          credential_ref = excluded.credential_ref,
          enabled = 1,
          updated_at = datetime('now')
      `).run(connectionId, credentialRef)

      if (input.projectId) {
        await setProjectConnection(db, {
          projectId: input.projectId,
          provider: 'github',
          connectionId
        })
      }

      if (input.repositories) {
        githubTestRepositoriesByConnection.set(connectionId, input.repositories)
      }

      const row = await getConnection(db, connectionId)
      return toPublicConnection(row)
    },

    testSetGithubRepositories: (input: {
      connectionId: string
      repositories: GithubRepositorySummary[]
    }) => {
      githubTestRepositoriesByConnection.set(input.connectionId, input.repositories)
      return true
    },

    testSetGithubRepositoryIssues: (input: {
      repositoryFullName: string
      issues: GithubIssueSummary[]
    }) => {
      const key = input.repositoryFullName.toLowerCase()
      githubTestIssuesByRepository.set(key, input.issues.map(cloneGithubIssue))
      return true
    },

    testClearGithubMocks: () => {
      githubTestRepositoriesByConnection.clear()
      githubTestIssuesByRepository.clear()
      return true
    },

    pushGithubTask
  }
}
