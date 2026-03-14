import type { Database } from 'better-sqlite3'
import type { IpcMain } from 'electron'
import {
  getIssue,
  getIssuesBatch,
  listIssues,
  listProjects,
  listTeams,
  listWorkflowStates,
  getViewer as getLinearViewer,
  updateIssue as updateLinearIssue
} from './linear-client'
import {
  getViewer as getGitHubViewer,
  getIssuesBatch as getGithubIssuesBatch,
  listIssues as listGitHubRepositoryIssues,
  listRepositories as listGitHubRepositories,
  listProjects as listGitHubProjects,
  listProjectIssues as listGitHubProjectIssues,
  listProjectStatusOptions as listGitHubProjectStatusOptions,
  getIssue as getGitHubIssue,
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
  BatchTaskSyncStatusItem
} from '../shared'
import { runSyncNow, runGithubSyncNow, pushNewTaskToProviders, getDesiredLinearStateId } from './sync'
import { providerStatusesToColumns, computeStatusDiff } from './status-sync'
import { htmlToMarkdown, markdownToHtml } from './markdown'
import {
  toMs,
  getProjectColumns,
  normalizeMarkdown,
  localStatusToGitHubState,
  githubStateToLocal,
  parseGitHubExternalKey,
  upsertFieldState,
  linearStateToTaskStatus,
  linearPriorityToLocal,
  localPriorityToLinear
} from './sync-helpers'
import {
  getDefaultStatus,
  resolveColumns,
  type ColumnConfig,
  type WorkflowCategory
} from '@slayzone/workflow'

function columnExists(db: Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((c) => c.name === column)
}

export function ensureIntegrationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
      ON integration_connections(provider, updated_at);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_project_mappings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      external_team_id TEXT NOT NULL,
      external_team_key TEXT NOT NULL,
      external_project_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_project_mappings_connection
      ON integration_project_mappings(connection_id);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_project_connections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_project_connections_connection
      ON integration_project_connections(connection_id);
  `)

  if (!columnExists(db, 'integration_project_mappings', 'sync_mode')) {
    db.exec(`ALTER TABLE integration_project_mappings ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'one_way';`)
  }

  if (!columnExists(db, 'integration_project_mappings', 'status_setup_complete')) {
    db.exec(`ALTER TABLE integration_project_mappings ADD COLUMN status_setup_complete INTEGER NOT NULL DEFAULT 0;`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS external_links (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      external_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_key TEXT NOT NULL,
      external_url TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sync_state TEXT NOT NULL DEFAULT 'active',
      last_sync_at TEXT DEFAULT NULL,
      last_error TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, connection_id, external_id),
      UNIQUE(provider, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_links_connection_state
      ON external_links(connection_id, sync_state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_external_links_task
      ON external_links(task_id);

    CREATE TABLE IF NOT EXISTS external_field_state (
      id TEXT PRIMARY KEY,
      external_link_id TEXT NOT NULL REFERENCES external_links(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      last_local_value_json TEXT NOT NULL DEFAULT 'null',
      last_external_value_json TEXT NOT NULL DEFAULT 'null',
      last_local_updated_at TEXT NOT NULL,
      last_external_updated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(external_link_id, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_external_field_state_link
      ON external_field_state(external_link_id);

    CREATE TABLE IF NOT EXISTS integration_state_mappings (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      project_mapping_id TEXT NOT NULL REFERENCES integration_project_mappings(id) ON DELETE CASCADE,
      local_status TEXT NOT NULL,
      state_id TEXT NOT NULL,
      state_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, project_mapping_id, local_status)
    );
  `)
}

function toPublicConnection(conn: IntegrationConnection): IntegrationConnectionPublic {
  return {
    id: conn.id,
    provider: conn.provider,
    enabled: Boolean(conn.enabled),
    created_at: conn.created_at,
    updated_at: conn.updated_at,
    last_synced_at: conn.last_synced_at
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

function annotateGithubIssueLinks(db: Database, issues: GithubIssueSummary[]): void {
  const externalIds = issues.map((issue) => issue.id)
  if (externalIds.length === 0) return

  const placeholders = externalIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT
      l.external_id,
      l.task_id,
      t.project_id,
      p.name AS project_name
    FROM external_links l
    LEFT JOIN tasks t ON t.id = l.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE l.provider = 'github' AND l.external_id IN (${placeholders})
  `).all(...externalIds) as Array<{
    external_id: string
    task_id: string | null
    project_id: string | null
    project_name: string | null
  }>

  const linkByExternalId = new Map(
    rows.map((row) => [row.external_id, row])
  )
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

function readFieldState(
  db: Database,
  externalLinkId: string
): Map<SyncField, { local: unknown; external: unknown }> {
  const rows = db.prepare(`
    SELECT field_name, last_local_value_json, last_external_value_json
    FROM external_field_state
    WHERE external_link_id = ?
  `).all(externalLinkId) as ExternalFieldStateRow[]

  const map = new Map<SyncField, { local: unknown; external: unknown }>()
  for (const row of rows) {
    if (row.field_name === 'title' || row.field_name === 'description' || row.field_name === 'status') {
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

function buildGitHubTaskSyncStatus(
  db: Database,
  link: ExternalLink,
  task: TaskRow,
  remoteIssue: GithubIssueSummary
): TaskSyncStatus {
  const columns = getProjectColumns(db, task.project_id)
  const localValues: Record<SyncField, unknown> = {
    title: task.title,
    description: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
    status: localStatusToGitHubState(task.status, columns)
  }
  const remoteValues: Record<SyncField, unknown> = {
    title: remoteIssue.title,
    description: normalizeMarkdown(remoteIssue.body),
    status: remoteIssue.state
  }

  const baselineByField = readFieldState(db, link.id)
  const fields: TaskSyncFieldDiff[] = (['title', 'description', 'status'] as const).map((field) => ({
    field,
    state: computeFieldState(
      baselineByField.get(field),
      localValues[field],
      remoteValues[field],
      task.updated_at,
      remoteIssue.updatedAt
    )
  }))

  return {
    provider: 'github',
    taskId: task.id,
    state: computeOverallState(fields),
    fields,
    comparedAt: new Date().toISOString()
  }
}

function normalizeLinearBaselineStatus(
  value: unknown,
  columns: ColumnConfig[] | null
): unknown {
  if (typeof value !== 'string') return value
  if (
    value === 'backlog' ||
    value === 'started' ||
    value === 'completed' ||
    value === 'canceled' ||
    value === 'unstarted' ||
    value === 'triage'
  ) {
    return linearStateToTaskStatus(value, columns)
  }
  return value
}

function buildLinearTaskSyncStatus(
  db: Database,
  link: ExternalLink,
  task: TaskRow,
  remoteIssue: LinearIssueSummary
): TaskSyncStatus {
  const columns = getProjectColumns(db, task.project_id)
  const localValues: Record<SyncField, unknown> = {
    title: task.title,
    description: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
    status: task.status
  }
  const remoteValues: Record<SyncField, unknown> = {
    title: remoteIssue.title,
    description: normalizeMarkdown(remoteIssue.description),
    status: linearStateToTaskStatus(remoteIssue.state.type, columns)
  }

  const baselineByField = readFieldState(db, link.id)
  const rawStatusBaseline = baselineByField.get('status')
  const normalizedStatusBaseline = rawStatusBaseline
    ? {
      local: rawStatusBaseline.local,
      external: normalizeLinearBaselineStatus(rawStatusBaseline.external, columns)
    }
    : undefined

  const fields: TaskSyncFieldDiff[] = (['title', 'description', 'status'] as const).map((field) => ({
    field,
    state: computeFieldState(
      field === 'status' ? normalizedStatusBaseline : baselineByField.get(field),
      localValues[field],
      remoteValues[field],
      task.updated_at,
      remoteIssue.updatedAt
    )
  }))

  return {
    provider: 'linear',
    taskId: task.id,
    state: computeOverallState(fields),
    fields,
    comparedAt: new Date().toISOString()
  }
}

function persistGitHubBaseline(
  db: Database,
  linkId: string,
  task: TaskRow,
  remoteIssue: GithubIssueSummary
): void {
  const columns = getProjectColumns(db, task.project_id)
  const localTitle = task.title
  const localDescription = normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null)
  const localStatus = localStatusToGitHubState(task.status, columns)

  upsertFieldState(db, linkId, 'title', localTitle, remoteIssue.title, task.updated_at, remoteIssue.updatedAt)
  upsertFieldState(
    db,
    linkId,
    'description',
    localDescription,
    normalizeMarkdown(remoteIssue.body),
    task.updated_at,
    remoteIssue.updatedAt
  )
  upsertFieldState(db, linkId, 'status', localStatus, remoteIssue.state, task.updated_at, remoteIssue.updatedAt)
}

function getTaskById(db: Database, taskId: string): TaskRow {
  const row = db.prepare(`
    SELECT id, project_id, title, description, status, priority, updated_at
    FROM tasks
    WHERE id = ?
  `).get(taskId) as TaskRow | undefined
  if (!row) throw new Error('Task not found')
  return row
}


function upsertLinkForIssue(
  db: Database,
  issue: LinearIssueSummary,
  connectionId: string,
  taskId: string
): ExternalLink {
  const existing = db.prepare(
    `SELECT * FROM external_links WHERE provider = 'linear' AND connection_id = ? AND external_id = ?`
  ).get(connectionId, issue.id) as ExternalLink | undefined

  if (existing) {
    db.prepare(`
      UPDATE external_links
      SET task_id = ?, external_key = ?, external_url = ?, sync_state = 'active',
          last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId, issue.identifier, issue.url, existing.id)
    return db.prepare('SELECT * FROM external_links WHERE id = ?').get(existing.id) as ExternalLink
  }

  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO external_links (
      id, provider, connection_id, external_type, external_id, external_key,
      external_url, task_id, sync_state, last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, 'linear', ?, 'issue', ?, ?, ?, ?, 'active', datetime('now'), NULL, datetime('now'), datetime('now'))
  `).run(id, connectionId, issue.id, issue.identifier, issue.url, taskId)

  return db.prepare('SELECT * FROM external_links WHERE id = ?').get(id) as ExternalLink
}

function upsertTaskFromIssue(db: Database, localProjectId: string, issue: LinearIssueSummary): string {
  const projectColumns = getProjectColumns(db, localProjectId)
  const byLink = db.prepare(`
    SELECT task_id FROM external_links
    WHERE provider = 'linear' AND external_id = ?
  `).get(issue.id) as { task_id: string } | undefined

  const descHtml = issue.description ? markdownToHtml(issue.description) : null

  if (byLink) {
    db.prepare(`
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
    return byLink.task_id
  }

  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, description, status, priority, assignee,
      terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-code',
      '{"claude-code":{"flags":"--allow-dangerously-skip-permissions"},"codex":{"flags":"--full-auto --search"},"cursor-agent":{"flags":"--force"},"gemini":{"flags":"--yolo"},"opencode":{"flags":""}}',
      '--allow-dangerously-skip-permissions', '--full-auto --search', datetime('now'), ?)
  `).run(
    id,
    localProjectId,
    issue.title,
    descHtml,
    linearStateToTaskStatus(issue.state.type, projectColumns),
    linearPriorityToLocal(issue.priority),
    issue.assignee?.name ?? null,
    issue.updatedAt
  )

  return id
}

function upsertLinkForGitHubIssue(
  db: Database,
  issue: GithubIssueSummary,
  connectionId: string,
  taskId: string
): ExternalLink {
  const existing = db.prepare(
    `SELECT * FROM external_links WHERE provider = 'github' AND connection_id = ? AND external_id = ?`
  ).get(connectionId, issue.id) as ExternalLink | undefined

  const externalKey = `${issue.repository.fullName}#${issue.number}`
  if (existing) {
    db.prepare(`
      UPDATE external_links
      SET task_id = ?, external_key = ?, external_url = ?, sync_state = 'active',
          last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(taskId, externalKey, issue.url, existing.id)
    return db.prepare('SELECT * FROM external_links WHERE id = ?').get(existing.id) as ExternalLink
  }

  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO external_links (
      id, provider, connection_id, external_type, external_id, external_key,
      external_url, task_id, sync_state, last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, 'github', ?, 'issue', ?, ?, ?, ?, 'active', datetime('now'), NULL, datetime('now'), datetime('now'))
  `).run(id, connectionId, issue.id, externalKey, issue.url, taskId)

  return db.prepare('SELECT * FROM external_links WHERE id = ?').get(id) as ExternalLink
}

function upsertTaskFromGitHubIssue(
  db: Database,
  localProjectId: string,
  issue: GithubIssueSummary
): GithubImportUpsertResult {
  const projectColumns = getProjectColumns(db, localProjectId)
  const byLink = db.prepare(`
    SELECT l.task_id, t.project_id
    FROM external_links l
    LEFT JOIN tasks t ON t.id = l.task_id
    WHERE l.provider = 'github' AND l.external_id = ?
  `).get(issue.id) as { task_id: string; project_id: string | null } | undefined

  const descHtml = issue.body ? markdownToHtml(issue.body) : null
  if (byLink) {
    if (byLink.project_id && byLink.project_id !== localProjectId) {
      return {
        outcome: 'skipped_already_linked',
        taskId: byLink.task_id,
        linkedProjectId: byLink.project_id
      }
    }

    db.prepare(`
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

  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, description, status, priority, assignee,
      terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-code',
      '{"claude-code":{"flags":"--allow-dangerously-skip-permissions"},"codex":{"flags":"--full-auto --search"},"cursor-agent":{"flags":"--force"},"gemini":{"flags":"--yolo"},"opencode":{"flags":""}}',
      '--allow-dangerously-skip-permissions', '--full-auto --search', datetime('now'), ?)
  `).run(
    id,
    localProjectId,
    issue.title,
    descHtml,
    githubStateToLocal(issue.state, projectColumns),
    3,
    issue.assignee?.login ?? null,
    issue.updatedAt
  )

  return {
    outcome: 'created',
    taskId: id
  }
}

function getConnection(db: Database, id: string): IntegrationConnection {
  const row = db.prepare('SELECT * FROM integration_connections WHERE id = ?').get(id) as IntegrationConnection | undefined
  if (!row) throw new Error('Integration connection not found')
  return row
}

function getProjectConnectionId(db: Database, projectId: string, provider: IntegrationProvider): string | null {
  const direct = db.prepare(`
    SELECT connection_id
    FROM integration_project_connections
    WHERE project_id = ? AND provider = ?
  `).get(projectId, provider) as { connection_id: string } | undefined
  if (direct?.connection_id) {
    return direct.connection_id
  }

  // Backward compatibility for projects mapped before project-scoped connections existed.
  const mapping = db.prepare(`
    SELECT connection_id
    FROM integration_project_mappings
    WHERE project_id = ? AND provider = ?
  `).get(projectId, provider) as { connection_id: string } | undefined
  return mapping?.connection_id ?? null
}

function setProjectConnection(db: Database, input: SetProjectConnectionInput): void {
  const existing = db.prepare(`
    SELECT id
    FROM integration_project_connections
    WHERE project_id = ? AND provider = ?
  `).get(input.projectId, input.provider) as { id: string } | undefined

  db.prepare(`
    INSERT INTO integration_project_connections (
      id, project_id, provider, connection_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(project_id, provider) DO UPDATE SET
      connection_id = excluded.connection_id,
      updated_at = datetime('now')
  `).run(
    existing?.id ?? crypto.randomUUID(),
    input.projectId,
    input.provider,
    input.connectionId
  )
}

function tryDeleteConnectionIfUnused(db: Database, connectionId: string): void {
  const usage = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM integration_project_connections WHERE connection_id = ?) +
      (SELECT COUNT(*) FROM integration_project_mappings WHERE connection_id = ?) +
      (SELECT COUNT(*) FROM external_links WHERE connection_id = ?) AS total
  `).get(connectionId, connectionId, connectionId) as { total: number } | undefined

  if (!usage || usage.total > 0) {
    return
  }

  const connection = db.prepare('SELECT * FROM integration_connections WHERE id = ?').get(connectionId) as IntegrationConnection | undefined
  if (!connection) {
    return
  }

  deleteCredential(db, connection.credential_ref)
  db.prepare('DELETE FROM integration_connections WHERE id = ?').run(connectionId)
}

function getConnectionUsage(db: Database, connection: IntegrationConnection): IntegrationConnectionUsage {
  type ConnectionUsageRow = {
    project_id: string
    project_name: string
    has_mapping: number
    linked_task_count: number
  }

  const rows = db.prepare(`
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
  `).all(connection.id, connection.id) as ConnectionUsageRow[]

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

function clearProjectProviderData(db: Database, projectId: string, provider: IntegrationProvider): void {
  db.prepare(`
    DELETE FROM integration_state_mappings
    WHERE project_mapping_id IN (
      SELECT id FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    )
  `).run(projectId, provider)

  db.prepare(`
    DELETE FROM integration_project_mappings
    WHERE project_id = ? AND provider = ?
  `).run(projectId, provider)

  db.prepare(`
    DELETE FROM external_field_state
    WHERE external_link_id IN (
      SELECT el.id FROM external_links el
      JOIN tasks t ON t.id = el.task_id
      WHERE el.provider = ? AND t.project_id = ?
    )
  `).run(provider, projectId)

  db.prepare(`
    DELETE FROM external_links
    WHERE provider = ? AND task_id IN (
      SELECT id FROM tasks WHERE project_id = ?
    )
  `).run(provider, projectId)
}

function assertConnectionProvider(connection: IntegrationConnection, provider: IntegrationProvider): void {
  if (connection.provider !== provider) {
    throw new Error(`Connection provider mismatch: expected ${provider}, got ${connection.provider}`)
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

function refreshStateMappings(
  db: Database,
  projectMappingId: string,
  projectId: string,
  states: Array<{ id: string; type: string }>
): void {
  const stateIdByType = new Map<string, string>()
  for (const state of states) {
    if (!stateIdByType.has(state.type)) {
      stateIdByType.set(state.type, state.id)
    }
  }

  const columns = resolveColumns(getProjectColumns(db, projectId))
  const availableStateTypes = new Set(stateIdByType.keys())
  db.prepare("DELETE FROM integration_state_mappings WHERE provider = 'linear' AND project_mapping_id = ?")
    .run(projectMappingId)

  for (const column of columns) {
    const stateType = getLinearStateTypeForCategory(column.category, availableStateTypes)
    if (!stateType) continue
    const stateId = stateIdByType.get(stateType)
    if (!stateId) continue

    db.prepare(`
      INSERT INTO integration_state_mappings (
        id, provider, project_mapping_id, local_status, state_id, state_type, created_at, updated_at
      ) VALUES (?, 'linear', ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(provider, project_mapping_id, local_status) DO UPDATE SET
        state_id = excluded.state_id,
        state_type = excluded.state_type,
        updated_at = datetime('now')
    `).run(crypto.randomUUID(), projectMappingId, column.id, stateId, stateType)
  }
}

export interface IntegrationHandles {
  pushGithubTask: (taskId: string) => Promise<void>
}

export function registerIntegrationHandlers(
  ipcMain: IpcMain,
  db: Database,
  options?: { enableTestChannels?: boolean }
): IntegrationHandles {
  ensureIntegrationSchema(db)
  const enableTestChannels = options?.enableTestChannels ?? false
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

  const getGithubIssueWithMocks = async (
    token: string,
    input: { owner: string; repo: string; number: number }
  ): Promise<GithubIssueSummary | null> => {
    const mockedIssue = getMockedGithubIssue(input.owner, input.repo, input.number)
    if (mockedIssue) return mockedIssue
    if (githubTestIssuesByRepository.has(githubRepositoryKey(input.owner, input.repo))) {
      return null
    }
    return getGitHubIssue(token, input)
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

  ipcMain.handle('integrations:connect-github', async (_event, input: ConnectGithubInput) => {
    const token = input.token.trim()
    if (!token) throw new Error('Token required')

    // Validate credential against provider, but do not persist profile/workspace metadata.
    await getGitHubViewer(token)

    const credentialRef = crypto.randomUUID()
    storeCredential(db, credentialRef, token)
    const currentProjectConnectionId = input.projectId
      ? getProjectConnectionId(db, input.projectId, 'github')
      : null

    if (currentProjectConnectionId) {
      const existing = getConnection(db, currentProjectConnectionId)
      deleteCredential(db, existing.credential_ref)
      db.prepare(`
        UPDATE integration_connections
        SET credential_ref = ?, enabled = 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(credentialRef, existing.id)

      if (input.projectId) {
        setProjectConnection(db, {
          projectId: input.projectId,
          provider: 'github',
          connectionId: existing.id
        })
      }
      return toPublicConnection(getConnection(db, existing.id))
    }

    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO integration_connections (
        id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
      ) VALUES (?, 'github', ?, 1, datetime('now'), datetime('now'), NULL)
    `).run(id, credentialRef)

    if (input.projectId) {
      setProjectConnection(db, {
        projectId: input.projectId,
        provider: 'github',
        connectionId: id
      })
    }

    return toPublicConnection(getConnection(db, id))
  })

  ipcMain.handle('integrations:connect-linear', async (_event, input: ConnectLinearInput) => {
    const apiKey = input.apiKey.trim()
    if (!apiKey) throw new Error('API key required')

    // Validate credential against provider, but do not persist profile/workspace metadata.
    await getLinearViewer(apiKey)

    const credentialRef = crypto.randomUUID()
    storeCredential(db, credentialRef, apiKey)
    const currentProjectConnectionId = input.projectId
      ? getProjectConnectionId(db, input.projectId, 'linear')
      : null

    if (currentProjectConnectionId) {
      const existing = getConnection(db, currentProjectConnectionId)
      deleteCredential(db, existing.credential_ref)
      db.prepare(`
        UPDATE integration_connections
        SET credential_ref = ?, enabled = 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(credentialRef, existing.id)

      if (input.projectId) {
        setProjectConnection(db, {
          projectId: input.projectId,
          provider: 'linear',
          connectionId: existing.id
        })
      }
      return toPublicConnection(getConnection(db, existing.id))
    }

    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO integration_connections (
        id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
      ) VALUES (?, 'linear', ?, 1, datetime('now'), datetime('now'), NULL)
    `).run(id, credentialRef)

    if (input.projectId) {
      setProjectConnection(db, {
        projectId: input.projectId,
        provider: 'linear',
        connectionId: id
      })
    }

    return toPublicConnection(getConnection(db, id))
  })

  ipcMain.handle('integrations:update-connection', async (_event, input: UpdateIntegrationConnectionInput) => {
    const connection = getConnection(db, input.connectionId)
    const credential = input.credential.trim()
    if (!credential) throw new Error('Credential is required')

    if (connection.provider === 'github') {
      await getGitHubViewer(credential)
      const credentialRef = crypto.randomUUID()
      storeCredential(db, credentialRef, credential)
      deleteCredential(db, connection.credential_ref)
      db.prepare(`
        UPDATE integration_connections
        SET credential_ref = ?, enabled = 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(credentialRef, connection.id)
      return toPublicConnection(getConnection(db, connection.id))
    }

    await getLinearViewer(credential)
    const credentialRef = crypto.randomUUID()
    storeCredential(db, credentialRef, credential)
    deleteCredential(db, connection.credential_ref)
    db.prepare(`
      UPDATE integration_connections
      SET credential_ref = ?, enabled = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(credentialRef, connection.id)
    return toPublicConnection(getConnection(db, connection.id))
  })

  ipcMain.handle('integrations:list-connections', (_event, provider?: IntegrationProvider) => {
    const rows = provider
      ? db.prepare('SELECT * FROM integration_connections WHERE provider = ? ORDER BY updated_at DESC').all(provider)
      : db.prepare('SELECT * FROM integration_connections ORDER BY updated_at DESC').all()
    return (rows as IntegrationConnection[]).map(toPublicConnection)
  })

  ipcMain.handle('integrations:get-connection-usage', (_event, connectionId: string) => {
    const connection = getConnection(db, connectionId)
    return getConnectionUsage(db, connection)
  })

  if (enableTestChannels) {
    ipcMain.handle('integrations:test:seed-github-connection', (_event, input: {
      id?: string
      projectId?: string
      token?: string
      repositories?: GithubRepositorySummary[]
    }) => {
      const existingConnectionId = input.projectId
        ? getProjectConnectionId(db, input.projectId, 'github')
        : null
      const existing = existingConnectionId
        ? getConnection(db, existingConnectionId)
        : undefined
      const connectionId = existing?.id ?? input.id ?? crypto.randomUUID()
      const credentialRef = crypto.randomUUID()
      storeCredential(db, credentialRef, input.token ?? 'ghp_test_e2e')
      if (existing) {
        deleteCredential(db, existing.credential_ref)
      }

      db.prepare(`
        INSERT INTO integration_connections (
          id, provider, credential_ref, enabled, created_at, updated_at, last_synced_at
        ) VALUES (?, 'github', ?, 1, datetime('now'), datetime('now'), NULL)
        ON CONFLICT(id) DO UPDATE SET
          credential_ref = excluded.credential_ref,
          enabled = 1,
          updated_at = datetime('now')
      `).run(connectionId, credentialRef)

      if (input.projectId) {
        setProjectConnection(db, {
          projectId: input.projectId,
          provider: 'github',
          connectionId
        })
      }

      if (input.repositories) {
        githubTestRepositoriesByConnection.set(connectionId, input.repositories)
      }

      const row = getConnection(db, connectionId)
      return toPublicConnection(row)
    })

    ipcMain.handle('integrations:test:set-github-repositories', (_event, input: {
      connectionId: string
      repositories: GithubRepositorySummary[]
    }) => {
      githubTestRepositoriesByConnection.set(input.connectionId, input.repositories)
      return true
    })

    ipcMain.handle('integrations:test:set-github-repository-issues', (_event, input: {
      repositoryFullName: string
      issues: GithubIssueSummary[]
    }) => {
      const key = input.repositoryFullName.toLowerCase()
      githubTestIssuesByRepository.set(key, input.issues.map(cloneGithubIssue))
      return true
    })

    ipcMain.handle('integrations:test:clear-github-mocks', () => {
      githubTestRepositoriesByConnection.clear()
      githubTestIssuesByRepository.clear()
      return true
    })
  }

  ipcMain.handle('integrations:disconnect', (_event, connectionId: string) => {
    const connection = getConnection(db, connectionId)
    deleteCredential(db, connection.credential_ref)

    db.transaction(() => {
      db.prepare('DELETE FROM integration_state_mappings WHERE project_mapping_id IN (SELECT id FROM integration_project_mappings WHERE connection_id = ?)').run(connectionId)
      db.prepare('DELETE FROM integration_project_mappings WHERE connection_id = ?').run(connectionId)
      db.prepare('DELETE FROM external_field_state WHERE external_link_id IN (SELECT id FROM external_links WHERE connection_id = ?)').run(connectionId)
      db.prepare('DELETE FROM external_links WHERE connection_id = ?').run(connectionId)
      db.prepare('DELETE FROM integration_connections WHERE id = ?').run(connectionId)
    })()

    return true
  })

  ipcMain.handle('integrations:clear-project-provider', (_event, input: ClearProjectProviderInput) => {
    db.transaction(() => {
      clearProjectProviderData(db, input.projectId, input.provider)
      db.prepare(`
        DELETE FROM integration_project_connections
        WHERE project_id = ? AND provider = ?
      `).run(input.projectId, input.provider)
    })()
    return true
  })

  ipcMain.handle('integrations:get-project-connection', (_event, projectId: string, provider: IntegrationProvider) => {
    return getProjectConnectionId(db, projectId, provider)
  })

  ipcMain.handle('integrations:set-project-connection', (_event, input: SetProjectConnectionInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, input.provider)
    db.transaction(() => {
      setProjectConnection(db, input)
    })()
    return true
  })

  ipcMain.handle('integrations:clear-project-connection', (_event, input: ClearProjectConnectionInput) => {
    const connectionId = getProjectConnectionId(db, input.projectId, input.provider)
    db.transaction(() => {
      clearProjectProviderData(db, input.projectId, input.provider)
      db.prepare(`
        DELETE FROM integration_project_connections
        WHERE project_id = ? AND provider = ?
      `).run(input.projectId, input.provider)
      if (connectionId) {
        tryDeleteConnectionIfUnused(db, connectionId)
      }
    })()
    return true
  })

  ipcMain.handle('integrations:list-github-repositories', async (_event, connectionId: string) => {
    const mocked = githubTestRepositoriesByConnection.get(connectionId)
    if (mocked) return mocked
    const connection = getConnection(db, connectionId)
    assertConnectionProvider(connection, 'github')
    const token = readCredential(db, connection.credential_ref)
    return listGitHubRepositories(token)
  })

  ipcMain.handle('integrations:list-github-projects', async (_event, connectionId: string) => {
    const connection = getConnection(db, connectionId)
    assertConnectionProvider(connection, 'github')
    const token = readCredential(db, connection.credential_ref)
    return listGitHubProjects(token)
  })

  ipcMain.handle('integrations:list-linear-teams', async (_event, connectionId: string) => {
    const connection = getConnection(db, connectionId)
    assertConnectionProvider(connection, 'linear')
    const apiKey = readCredential(db, connection.credential_ref)
    return listTeams(apiKey)
  })

  ipcMain.handle('integrations:list-linear-projects', async (_event, connectionId: string, teamId: string) => {
    const connection = getConnection(db, connectionId)
    assertConnectionProvider(connection, 'linear')
    const apiKey = readCredential(db, connection.credential_ref)
    return listProjects(apiKey, teamId)
  })

  ipcMain.handle('integrations:set-project-mapping', async (_event, input: SetProjectMappingInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, input.provider)
    const otherProvider: IntegrationProvider = input.provider === 'github' ? 'linear' : 'github'

    const existing = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE provider = ? AND project_id = ?
    `).get(input.provider, input.projectId) as IntegrationProjectMapping | undefined

    const mappingId = existing?.id ?? crypto.randomUUID()
    db.transaction(() => {
      clearProjectProviderData(db, input.projectId, otherProvider)
      setProjectConnection(db, {
        projectId: input.projectId,
        provider: input.provider,
        connectionId: input.connectionId
      })
      db.prepare(`
        INSERT INTO integration_project_mappings (
          id, project_id, provider, connection_id, external_team_id, external_team_key, external_project_id, sync_mode, external_repo_owner, external_repo_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(project_id, provider) DO UPDATE SET
          connection_id = excluded.connection_id,
          external_team_id = excluded.external_team_id,
          external_team_key = excluded.external_team_key,
          external_project_id = excluded.external_project_id,
          sync_mode = excluded.sync_mode,
          external_repo_owner = excluded.external_repo_owner,
          external_repo_name = excluded.external_repo_name,
          updated_at = datetime('now')
      `).run(
        mappingId,
        input.projectId,
        input.provider,
        input.connectionId,
        input.externalTeamId,
        input.externalTeamKey,
        input.externalProjectId ?? null,
        input.syncMode ?? 'one_way',
        input.externalRepoOwner ?? null,
        input.externalRepoName ?? null
      )
    })()

    if (input.provider === 'linear') {
      const apiKey = readCredential(db, connection.credential_ref)
      const states = await listWorkflowStates(apiKey, input.externalTeamId)
      refreshStateMappings(db, mappingId, input.projectId, states)
    }

    return db.prepare('SELECT * FROM integration_project_mappings WHERE id = ?').get(mappingId) as IntegrationProjectMapping
  })

  ipcMain.handle('integrations:get-project-mapping', (_event, projectId: string, provider: IntegrationProvider) => {
    const row = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `).get(projectId, provider) as IntegrationProjectMapping | undefined
    return row ?? null
  })

  ipcMain.handle('integrations:list-github-issues', async (_event, input: ListGithubIssuesInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, 'github')
    const token = readCredential(db, connection.credential_ref)
    const mapping = input.projectId
      ? db.prepare(`
          SELECT * FROM integration_project_mappings
          WHERE project_id = ? AND provider = 'github'
        `).get(input.projectId) as IntegrationProjectMapping | undefined
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

    annotateGithubIssueLinks(db, data.issues)

    return data
  })

  ipcMain.handle('integrations:list-github-repository-issues', async (_event, input: ListGithubRepositoryIssuesInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, 'github')
    const repository = parseGitHubRepositoryFullName(input.repositoryFullName)
    if (!repository) {
      throw new Error('Repository must be in owner/repo format')
    }

    const mockedIssues = listMockedGithubIssuesForRepository(repository.owner, repository.repo)
    const data = mockedIssues
      ? paginateGithubIssues(mockedIssues, input.limit ?? 50, input.cursor ?? null)
      : await (() => {
          const token = readCredential(db, connection.credential_ref)
          return listGitHubRepositoryIssues(token, {
            owner: repository.owner,
            repo: repository.repo,
            limit: input.limit ?? 50,
            cursor: input.cursor ?? null
          })
        })()

    annotateGithubIssueLinks(db, data.issues)

    return data
  })

  ipcMain.handle('integrations:list-linear-issues', async (_event, input: ListLinearIssuesInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, 'linear')
    const apiKey = readCredential(db, connection.credential_ref)
    const mapping = input.projectId
      ? db.prepare(`
          SELECT * FROM integration_project_mappings
          WHERE project_id = ? AND provider = 'linear'
        `).get(input.projectId) as IntegrationProjectMapping | undefined
      : undefined

    const data = await listIssues(apiKey, {
      teamId: input.teamId ?? mapping?.external_team_id,
      projectId: input.linearProjectId ?? mapping?.external_project_id ?? undefined,
      first: input.limit ?? 50,
      after: input.cursor ?? null
    })

    const externalIds = data.issues.map((i) => i.id)
    if (externalIds.length > 0) {
      const placeholders = externalIds.map(() => '?').join(',')
      const links = db.prepare(`
        SELECT external_id, task_id FROM external_links
        WHERE provider = 'linear' AND external_id IN (${placeholders})
      `).all(...externalIds) as Array<{ external_id: string; task_id: string }>
      const linkMap = new Map(links.map((l) => [l.external_id, l.task_id]))
      for (const issue of data.issues) {
        issue.linkedTaskId = linkMap.get(issue.id) ?? null
      }
    }

    return data
  })

  ipcMain.handle('integrations:import-github-issues', async (_event, input: ImportGithubIssuesInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, 'github')
    const mapping = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = 'github'
    `).get(input.projectId) as IntegrationProjectMapping | undefined

    if (mapping && !mapping.status_setup_complete) {
      throw new Error('Status setup must be completed before importing issues')
    }

    const token = readCredential(db, connection.credential_ref)
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
    const selectedIds = input.selectedIssueIds?.length
      ? new Set(input.selectedIssueIds)
      : null

    for (const issue of data.issues) {
      if (selectedIds && !selectedIds.has(issue.id)) continue
      const upsert = upsertTaskFromGitHubIssue(db, input.projectId, issue)
      if (upsert.outcome === 'skipped_already_linked') {
        skippedAlreadyLinked += 1
        continue
      }
      const link = upsertLinkForGitHubIssue(db, issue, input.connectionId, upsert.taskId)
      const task = getTaskById(db, upsert.taskId)
      persistGitHubBaseline(db, link.id, task, issue)
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
  })

  ipcMain.handle('integrations:import-github-repository-issues', async (_event, input: ImportGithubRepositoryIssuesInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, 'github')

    const ghMapping = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = 'github'
    `).get(input.projectId) as IntegrationProjectMapping | undefined
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
      : await (() => {
          const token = readCredential(db, connection.credential_ref)
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
    const selectedIds = input.selectedIssueIds?.length
      ? new Set(input.selectedIssueIds)
      : null

    for (const issue of data.issues) {
      if (selectedIds && !selectedIds.has(issue.id)) continue
      const upsert = upsertTaskFromGitHubIssue(db, input.projectId, issue)
      if (upsert.outcome === 'skipped_already_linked') {
        skippedAlreadyLinked += 1
        continue
      }
      const link = upsertLinkForGitHubIssue(db, issue, input.connectionId, upsert.taskId)
      const task = getTaskById(db, upsert.taskId)
      persistGitHubBaseline(db, link.id, task, issue)
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
  })

  ipcMain.handle('integrations:import-linear-issues', async (_event, input: ImportLinearIssuesInput) => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, 'linear')
    const mapping = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = 'linear'
    `).get(input.projectId) as IntegrationProjectMapping | undefined

    if (mapping && !mapping.status_setup_complete) {
      throw new Error('Status setup must be completed before importing issues')
    }

    const teamId = input.teamId ?? mapping?.external_team_id
    if (!teamId) {
      throw new Error('No team specified and project is not mapped to Linear')
    }

    const apiKey = readCredential(db, connection.credential_ref)
    const data = await listIssues(apiKey, {
      teamId,
      projectId: input.linearProjectId ?? mapping?.external_project_id ?? undefined,
      first: input.limit ?? 25,
      after: input.cursor ?? null
    })

    let imported = 0
    let linked = 0

    const selectedIds = input.selectedIssueIds?.length
      ? new Set(input.selectedIssueIds)
      : null

    for (const issue of data.issues) {
      if (selectedIds && !selectedIds.has(issue.id)) continue
      const taskId = upsertTaskFromIssue(db, input.projectId, issue)
      upsertLinkForIssue(db, issue, input.connectionId, taskId)
      imported += 1
      linked += 1
    }

    const result: ImportLinearIssuesResult = {
      imported,
      linked,
      nextCursor: data.nextCursor
    }

    return result
  })

  ipcMain.handle('integrations:get-task-sync-status', async (_event, taskId: string, provider: IntegrationProvider) => {
    if (provider === 'linear') {
      const link = db.prepare(`
        SELECT * FROM external_links
        WHERE task_id = ? AND provider = 'linear'
      `).get(taskId) as ExternalLink | undefined

      if (!link) {
        return {
          provider: 'linear',
          taskId,
          state: 'unknown',
          fields: [],
          comparedAt: new Date().toISOString()
        }
      }

      const connection = getConnection(db, link.connection_id)
      assertConnectionProvider(connection, 'linear')
      const apiKey = readCredential(db, connection.credential_ref)
      const remoteIssue = await getIssue(apiKey, link.external_id)
      if (!remoteIssue) {
        throw new Error('Linked Linear issue no longer exists')
      }

      const task = getTaskById(db, taskId)
      return buildLinearTaskSyncStatus(db, link, task, remoteIssue)
    }

    if (provider !== 'github') {
      return {
        provider,
        taskId,
        state: 'unknown',
        fields: [],
        comparedAt: new Date().toISOString()
      } as TaskSyncStatus
    }

    const link = db.prepare(`
      SELECT * FROM external_links
      WHERE task_id = ? AND provider = 'github'
    `).get(taskId) as ExternalLink | undefined

    if (!link) {
      return {
        provider: 'github',
        taskId,
        state: 'unknown',
        fields: [],
        comparedAt: new Date().toISOString()
      }
    }

    const key = parseGitHubExternalKey(link.external_key)
    if (!key) {
      throw new Error('Linked GitHub issue key is invalid')
    }

    const connection = getConnection(db, link.connection_id)
    assertConnectionProvider(connection, 'github')
    const token = readCredential(db, connection.credential_ref)
    const remoteIssue = await getGithubIssueWithMocks(token, key)
    if (!remoteIssue) {
      throw new Error('Linked GitHub issue no longer exists or is not an issue')
    }

    const task = getTaskById(db, taskId)
    return buildGitHubTaskSyncStatus(db, link, task, remoteIssue)
  })

  ipcMain.handle('integrations:get-batch-task-sync-status', async (_event, taskIds: string[], provider: IntegrationProvider): Promise<BatchTaskSyncStatusItem[]> => {
    if (taskIds.length === 0) return []
    const placeholders = taskIds.map(() => '?').join(',')
    const links = db.prepare(`
      SELECT * FROM external_links WHERE task_id IN (${placeholders}) AND provider = ?
    `).all(...taskIds, provider) as ExternalLink[]
    const linkByTaskId = new Map(links.map(l => [l.task_id, l]))

    const connectionIds = [...new Set(links.map(l => l.connection_id))]
    const results: BatchTaskSyncStatusItem[] = []
    const now = new Date().toISOString()

    if (provider === 'linear') {
      for (const connId of connectionIds) {
        const connection = getConnection(db, connId)
        assertConnectionProvider(connection, 'linear')
        const apiKey = readCredential(db, connection.credential_ref)
        const connLinks = links.filter(l => l.connection_id === connId)
        const issueMap = await getIssuesBatch(apiKey, connLinks.map(l => l.external_id))

        for (const link of connLinks) {
          const remoteIssue = issueMap.get(link.external_id)
          if (!remoteIssue) {
            results.push({ taskId: link.task_id, link, status: { provider, taskId: link.task_id, state: 'unknown', fields: [], comparedAt: now } })
            continue
          }
          const task = getTaskById(db, link.task_id)
          results.push({ taskId: link.task_id, link, status: buildLinearTaskSyncStatus(db, link, task, remoteIssue) })
        }
      }
    } else if (provider === 'github') {
      for (const connId of connectionIds) {
        const connection = getConnection(db, connId)
        assertConnectionProvider(connection, 'github')
        const token = readCredential(db, connection.credential_ref)
        const connLinks = links.filter(l => l.connection_id === connId)
        const batchInput = connLinks.map(l => {
          const key = parseGitHubExternalKey(l.external_key)
          return key ? { id: l.external_id, ...key } : null
        }).filter((x): x is NonNullable<typeof x> => x !== null)

        const issueMap = await getGithubIssuesBatch(token, batchInput)

        for (const link of connLinks) {
          const remoteIssue = issueMap.get(link.external_id)
          if (!remoteIssue) {
            results.push({ taskId: link.task_id, link, status: { provider, taskId: link.task_id, state: 'unknown', fields: [], comparedAt: now } })
            continue
          }
          const task = getTaskById(db, link.task_id)
          results.push({ taskId: link.task_id, link, status: buildGitHubTaskSyncStatus(db, link, task, remoteIssue) })
        }
      }
    }

    // Unlinked tasks
    for (const taskId of taskIds) {
      if (!linkByTaskId.has(taskId)) {
        results.push({ taskId, link: null, status: { provider, taskId, state: 'unknown', fields: [], comparedAt: now } })
      }
    }

    return results
  })

  ipcMain.handle('integrations:push-task', async (_event, input: PushTaskInput) => {
    const link = db.prepare(`
      SELECT * FROM external_links
      WHERE task_id = ? AND provider = ?
    `).get(input.taskId, input.provider) as ExternalLink | undefined
    if (!link) {
      throw new Error(`Task is not linked to ${input.provider}`)
    }

    const pushTaskRow = getTaskById(db, input.taskId)
    const pushMapping = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `).get(pushTaskRow.project_id, input.provider) as IntegrationProjectMapping | undefined
    if (pushMapping && !pushMapping.status_setup_complete) {
      throw new Error('Status setup must be completed before pushing')
    }

    const connection = getConnection(db, link.connection_id)
    assertConnectionProvider(connection, input.provider)
    const credential = readCredential(db, connection.credential_ref)
    const task = getTaskById(db, input.taskId)
    const providerName = input.provider === 'linear' ? 'Linear' : 'GitHub'

    if (input.provider === 'linear') {
      const remoteIssue = await getIssue(credential, link.external_id)
      if (!remoteIssue) {
        throw new Error('Linked Linear issue no longer exists')
      }

      const statusBefore = buildLinearTaskSyncStatus(db, link, task, remoteIssue)
      if (statusBefore.state === 'in_sync') {
        return { pushed: false, status: statusBefore, message: `Task is already in sync with ${providerName}` } as PushTaskResult
      }
      if (!input.force && (statusBefore.state === 'remote_ahead' || statusBefore.state === 'conflict')) {
        return { pushed: false, status: statusBefore, message: 'Remote changes detected. Refresh diff and resolve before pushing.' } as PushTaskResult
      }

      const stateId = getDesiredLinearStateId(db, pushMapping, task.project_id, task.status)
      const updatedIssue = await updateLinearIssue(credential, link.external_id, {
        title: task.title,
        description: task.description ? htmlToMarkdown(task.description) : null,
        priority: localPriorityToLinear(task.priority),
        stateId
      })
      if (!updatedIssue) {
        throw new Error('Failed to update Linear issue')
      }

      upsertFieldState(db, link.id, 'title', task.title, updatedIssue.title, task.updated_at, updatedIssue.updatedAt)
      upsertFieldState(db, link.id, 'description', normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null), normalizeMarkdown(updatedIssue.description), task.updated_at, updatedIssue.updatedAt)
      upsertFieldState(db, link.id, 'status', task.status, updatedIssue.state.type, task.updated_at, updatedIssue.updatedAt)

      db.prepare(`UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(link.id)
      db.prepare(`UPDATE integration_connections SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(connection.id)

      const statusAfter = buildLinearTaskSyncStatus(db, link, task, updatedIssue)
      return { pushed: true, status: statusAfter, message: `Pushed local changes to ${providerName}` } as PushTaskResult
    }

    // GitHub
    const key = parseGitHubExternalKey(link.external_key)
    if (!key) {
      throw new Error('Linked GitHub issue key is invalid')
    }

    const remoteBefore = await getGithubIssueWithMocks(credential, key)
    if (!remoteBefore) {
      throw new Error('Linked GitHub issue no longer exists or is not an issue')
    }

    const statusBefore = buildGitHubTaskSyncStatus(db, link, task, remoteBefore)
    if (statusBefore.state === 'in_sync') {
      return { pushed: false, status: statusBefore, message: `Task is already in sync with ${providerName}` } as PushTaskResult
    }
    if (!input.force && (statusBefore.state === 'remote_ahead' || statusBefore.state === 'conflict')) {
      return { pushed: false, status: statusBefore, message: 'Remote changes detected. Refresh diff and resolve before pushing.' } as PushTaskResult
    }

    const columns = getProjectColumns(db, task.project_id)
    const updatedIssue = await updateGithubIssueWithMocks(credential, {
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      title: task.title,
      body: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
      state: localStatusToGitHubState(task.status, columns)
    })
    if (!updatedIssue) {
      throw new Error('Linked GitHub issue is a pull request and cannot be pushed as an issue')
    }

    persistGitHubBaseline(db, link.id, task, updatedIssue)
    db.prepare(`UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(link.id)
    db.prepare(`UPDATE integration_connections SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(connection.id)

    const statusAfter = buildGitHubTaskSyncStatus(db, link, task, updatedIssue)
    return { pushed: true, status: statusAfter, message: `Pushed local changes to ${providerName}` } as PushTaskResult
  })

  ipcMain.handle('integrations:pull-task', async (_event, input: PullTaskInput) => {
    const link = db.prepare(`
      SELECT * FROM external_links
      WHERE task_id = ? AND provider = ?
    `).get(input.taskId, input.provider) as ExternalLink | undefined
    if (!link) {
      throw new Error(`Task is not linked to ${input.provider}`)
    }

    const pullTaskRow = getTaskById(db, input.taskId)
    const pullMapping = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `).get(pullTaskRow.project_id, input.provider) as IntegrationProjectMapping | undefined
    if (pullMapping && !pullMapping.status_setup_complete) {
      throw new Error('Status setup must be completed before pulling')
    }

    const connection = getConnection(db, link.connection_id)
    assertConnectionProvider(connection, input.provider)
    const credential = readCredential(db, connection.credential_ref)
    const task = getTaskById(db, input.taskId)
    const providerName = input.provider === 'linear' ? 'Linear' : 'GitHub'

    if (input.provider === 'linear') {
      const remoteIssue = await getIssue(credential, link.external_id)
      if (!remoteIssue) {
        throw new Error('Linked Linear issue no longer exists')
      }

      const statusBefore = buildLinearTaskSyncStatus(db, link, task, remoteIssue)
      if (statusBefore.state === 'in_sync') {
        return { pulled: false, status: statusBefore, message: `Task is already in sync with ${providerName}` } as PullTaskResult
      }
      if (!input.force && (statusBefore.state === 'local_ahead' || statusBefore.state === 'conflict')) {
        return { pulled: false, status: statusBefore, message: 'Local changes detected. Push local changes or force pull to overwrite local fields.' } as PullTaskResult
      }

      const projectColumns = getProjectColumns(db, task.project_id)
      const localStatus = linearStateToTaskStatus(remoteIssue.state.type, projectColumns)
      db.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee = ?, updated_at = ? WHERE id = ?`).run(
        remoteIssue.title,
        remoteIssue.description ? markdownToHtml(remoteIssue.description) : null,
        localStatus,
        linearPriorityToLocal(remoteIssue.priority),
        remoteIssue.assignee?.name ?? null,
        remoteIssue.updatedAt,
        task.id
      )
      const updatedTask = getTaskById(db, task.id)
      upsertFieldState(db, link.id, 'title', updatedTask.title, remoteIssue.title, updatedTask.updated_at, remoteIssue.updatedAt)
      upsertFieldState(db, link.id, 'description', normalizeMarkdown(updatedTask.description ? htmlToMarkdown(updatedTask.description) : null), normalizeMarkdown(remoteIssue.description), updatedTask.updated_at, remoteIssue.updatedAt)
      upsertFieldState(db, link.id, 'status', updatedTask.status, remoteIssue.state.type, updatedTask.updated_at, remoteIssue.updatedAt)

      db.prepare(`UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(link.id)
      db.prepare(`UPDATE integration_connections SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(connection.id)

      const statusAfter = buildLinearTaskSyncStatus(db, link, updatedTask, remoteIssue)
      return { pulled: true, status: statusAfter, message: `Pulled remote changes from ${providerName}` } as PullTaskResult
    }

    // GitHub
    const key = parseGitHubExternalKey(link.external_key)
    if (!key) {
      throw new Error('Linked GitHub issue key is invalid')
    }

    const remoteIssue = await getGithubIssueWithMocks(credential, key)
    if (!remoteIssue) {
      throw new Error('Linked GitHub issue no longer exists or is not an issue')
    }

    const statusBefore = buildGitHubTaskSyncStatus(db, link, task, remoteIssue)
    if (statusBefore.state === 'in_sync') {
      return { pulled: false, status: statusBefore, message: `Task is already in sync with ${providerName}` } as PullTaskResult
    }
    if (!input.force && (statusBefore.state === 'local_ahead' || statusBefore.state === 'conflict')) {
      return { pulled: false, status: statusBefore, message: 'Local changes detected. Push local changes or force pull to overwrite local fields.' } as PullTaskResult
    }

    const projectColumns = getProjectColumns(db, task.project_id)
    db.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, assignee = ?, updated_at = ? WHERE id = ?`).run(
      remoteIssue.title,
      remoteIssue.body ? markdownToHtml(remoteIssue.body) : null,
      githubStateToLocal(remoteIssue.state, projectColumns),
      remoteIssue.assignee?.login ?? null,
      remoteIssue.updatedAt,
      task.id
    )
    const updatedTask = getTaskById(db, task.id)
    persistGitHubBaseline(db, link.id, updatedTask, remoteIssue)

    db.prepare(`UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(link.id)
    db.prepare(`UPDATE integration_connections SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(connection.id)

    const statusAfter = buildGitHubTaskSyncStatus(db, link, updatedTask, remoteIssue)
    return { pulled: true, status: statusAfter, message: `Pulled remote changes from ${providerName}` } as PullTaskResult
  })

  ipcMain.handle('integrations:sync-now', async (_event, input: SyncNowInput) => {
    const [linear, github] = await Promise.all([
      runSyncNow(db, input),
      runGithubSyncNow(db, input)
    ])
    return {
      scanned: linear.scanned + github.scanned,
      pushed: linear.pushed + github.pushed,
      pulled: linear.pulled + github.pulled,
      conflictsResolved: linear.conflictsResolved + github.conflictsResolved,
      errors: [...linear.errors, ...github.errors],
      at: linear.at
    }
  })

  ipcMain.handle('integrations:get-link', (_event, taskId: string, provider: IntegrationProvider) => {
    const row = db.prepare(`
      SELECT * FROM external_links
      WHERE task_id = ? AND provider = ?
    `).get(taskId, provider) as ExternalLink | undefined
    return row ?? null
  })

  ipcMain.handle('integrations:unlink-task', (_event, taskId: string, provider: IntegrationProvider) => {
    db.prepare(`
      DELETE FROM external_field_state
      WHERE external_link_id IN (
        SELECT id FROM external_links WHERE task_id = ? AND provider = ?
      )
    `).run(taskId, provider)

    const res = db.prepare('DELETE FROM external_links WHERE task_id = ? AND provider = ?').run(taskId, provider)
    return res.changes > 0
  })

  ipcMain.handle('integrations:push-unlinked-tasks', async (_event, input: PushUnlinkedTasksInput): Promise<PushUnlinkedTasksResult> => {
    const unlinkedTasks = db.prepare(`
      SELECT t.id, t.project_id FROM tasks t
      WHERE t.project_id = ?
        AND t.is_temporary = 0
        AND NOT EXISTS (
          SELECT 1 FROM external_links el WHERE el.task_id = t.id AND el.provider = ?
        )
    `).all(input.projectId, input.provider) as Array<{ id: string; project_id: string }>

    let pushed = 0
    const errors: string[] = []
    for (const task of unlinkedTasks) {
      try {
        // Re-check right before push to prevent duplicate creation from concurrent calls
        const alreadyLinked = db.prepare('SELECT id FROM external_links WHERE task_id = ? AND provider = ?')
          .get(task.id, input.provider)
        if (alreadyLinked) continue

        await pushNewTaskToProviders(db, task.id, task.project_id)
        const link = db.prepare('SELECT id FROM external_links WHERE task_id = ? AND provider = ?')
          .get(task.id, input.provider)
        if (link) pushed++
      } catch (err) {
        errors.push(`${task.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { pushed, errors }
  })

  // --- Status Sync Handlers ---

  ipcMain.handle('integrations:fetch-provider-statuses', async (_event, input: FetchProviderStatusesInput): Promise<ProviderStatus[]> => {
    const connection = getConnection(db, input.connectionId)
    assertConnectionProvider(connection, input.provider)
    const credential = readCredential(db, connection.credential_ref)

    if (input.provider === 'linear') {
      const states = await listWorkflowStates(credential, input.externalTeamId)
      return states
        .sort((a, b) => a.position - b.position)
        .map((s) => ({ id: s.id, name: s.name, color: s.color, type: s.type, position: s.position }))
    }

    if (input.provider === 'github') {
      if (!input.externalProjectId) throw new Error('externalProjectId required for GitHub')
      const options = await listGitHubProjectStatusOptions(credential, input.externalProjectId)
      return options.map((o, i) => ({ id: o.id, name: o.name, color: o.color, position: i }))
    }

    throw new Error(`Unsupported provider: ${input.provider}`)
  })

  ipcMain.handle('integrations:apply-status-sync', async (_event, input: ApplyStatusSyncInput) => {
    const mapping = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `).get(input.projectId, input.provider) as IntegrationProjectMapping | undefined
    if (!mapping) throw new Error('No integration mapping found for this project')

    const { columns: newColumns, providerIdToColumnId } = providerStatusesToColumns(
      input.provider,
      input.statuses
    )

    // Remap existing tasks
    if (input.taskRemapping && Object.keys(input.taskRemapping).length > 0) {
      for (const [oldStatus, newStatus] of Object.entries(input.taskRemapping)) {
        if (!newColumns.some((c) => c.id === newStatus)) continue
        db.prepare('UPDATE tasks SET status = ?, updated_at = datetime(\'now\') WHERE project_id = ? AND status = ?')
          .run(newStatus, input.projectId, oldStatus)
      }
    }

    // Update project columns_config
    db.prepare('UPDATE projects SET columns_config = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(newColumns), input.projectId)

    // Normalize any tasks with statuses not in the new column set
    const defaultStatus = getDefaultStatus(newColumns)
    const newStatusIds = newColumns.map((c) => c.id)
    const placeholders = newStatusIds.map(() => '?').join(',')
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE project_id = ? AND status NOT IN (${placeholders})`
    ).run(defaultStatus, input.projectId, ...newStatusIds)

    // Rebuild integration_state_mappings using the mapping from providerStatusesToColumns
    db.prepare("DELETE FROM integration_state_mappings WHERE project_mapping_id = ?")
      .run(mapping.id)

    for (const status of input.statuses) {
      const colId = providerIdToColumnId.get(status.id)
      if (!colId) continue
      db.prepare(`
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
    db.prepare('UPDATE integration_project_mappings SET status_setup_complete = 1, updated_at = datetime(\'now\') WHERE id = ?')
      .run(mapping.id)

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId)
    return project
  })

  ipcMain.handle('integrations:resync-provider-statuses', async (_event, input: { projectId: string; provider: IntegrationProvider }): Promise<StatusResyncPreview> => {
    const mapping = db.prepare(`
      SELECT * FROM integration_project_mappings
      WHERE project_id = ? AND provider = ?
    `).get(input.projectId, input.provider) as IntegrationProjectMapping | undefined
    if (!mapping) throw new Error('No integration mapping found for this project')

    const connection = getConnection(db, mapping.connection_id)
    const credential = readCredential(db, connection.credential_ref)

    let providerStatuses: ProviderStatus[]
    if (input.provider === 'linear') {
      const states = await listWorkflowStates(credential, mapping.external_team_id)
      providerStatuses = states
        .sort((a, b) => a.position - b.position)
        .map((s) => ({ id: s.id, name: s.name, color: s.color, type: s.type, position: s.position }))
    } else if (input.provider === 'github') {
      if (!mapping.external_project_id) throw new Error('No GitHub project ID in mapping')
      const options = await listGitHubProjectStatusOptions(credential, mapping.external_project_id)
      providerStatuses = options.map((o, i) => ({ id: o.id, name: o.name, color: o.color, position: i }))
    } else {
      throw new Error(`Unsupported provider: ${input.provider}`)
    }

    // Build local_status -> provider_status_id map from integration_state_mappings
    const stateMappingRows = db.prepare(`
      SELECT local_status, state_id FROM integration_state_mappings
      WHERE project_mapping_id = ?
    `).all(mapping.id) as Array<{ local_status: string; state_id: string }>
    const currentIdMap = new Map(stateMappingRows.map((r) => [r.local_status, r.state_id]))

    const current = resolveColumns(getProjectColumns(db, input.projectId))
    const { columns: incoming } = providerStatusesToColumns(input.provider, providerStatuses)
    const diff = computeStatusDiff(current, providerStatuses, currentIdMap)

    return { current, incoming, diff, providerStatuses }
  })

  async function pushGithubTask(taskId: string): Promise<void> {
    const link = db.prepare(
      "SELECT * FROM external_links WHERE task_id = ? AND provider = 'github'"
    ).get(taskId) as ExternalLink | undefined
    if (!link) return

    const task = getTaskById(db, taskId)
    const mapping = db.prepare(
      "SELECT * FROM integration_project_mappings WHERE project_id = ? AND provider = 'github'"
    ).get(task.project_id) as IntegrationProjectMapping | undefined
    if (!mapping?.status_setup_complete) return

    const key = parseGitHubExternalKey(link.external_key)
    if (!key) return

    const connection = getConnection(db, link.connection_id)
    assertConnectionProvider(connection, 'github')
    const token = readCredential(db, connection.credential_ref)

    const remoteIssue = await getGithubIssueWithMocks(token, key)
    if (!remoteIssue) return

    const status = buildGitHubTaskSyncStatus(db, link, task, remoteIssue)
    if (status.state !== 'local_ahead') return

    const columns = getProjectColumns(db, task.project_id)
    const updatedIssue = await updateGithubIssueWithMocks(token, {
      owner: key.owner,
      repo: key.repo,
      number: key.number,
      title: task.title,
      body: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
      state: localStatusToGitHubState(task.status, columns)
    })
    if (!updatedIssue) return

    persistGitHubBaseline(db, link.id, task, updatedIssue)
    db.prepare(
      "UPDATE external_links SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(link.id)
  }

  return { pushGithubTask }
}
