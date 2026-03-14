import type { Database } from 'better-sqlite3'
import type {
  ExternalLink,
  GithubIssueSummary,
  IntegrationProjectMapping,
  LinearIssueSummary,
  SyncNowInput,
  SyncNowResult
} from '../shared'
import { getIssuesBatch, getIssue as getLinearIssue, updateIssue, createIssue as createLinearIssue, listIssues as listLinearIssues } from './linear-client'
import { getIssuesBatch as getGithubIssuesBatch, getIssue as getGithubIssue, updateIssue as updateGithubIssue, createIssue as createGithubIssue, listIssues as listGithubIssues } from './github-client'
import { readCredential } from './credentials'
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
  localPriorityToLinear,
  buildDefaultProviderConfig
} from './sync-helpers'
import {
  getColumnById,
  getDefaultStatus,
  getDoneStatus,
  isKnownStatus,
  type WorkflowCategory
} from '@slayzone/workflow'

type Task = {
  id: string
  project_id: string
  title: string
  description: string | null
  status: string
  priority: number
  assignee: string | null
  archived_at: string | null
  updated_at: string
}

type ProjectMapping = IntegrationProjectMapping

interface LinkRow extends ExternalLink {
  credential_ref: string
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

export function getDesiredLinearStateId(
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

function loadTask(db: Database, taskId: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  return row ?? null
}

function loadProjectMappingByTask(db: Database, taskId: string, provider: 'linear' | 'github'): ProjectMapping | undefined {
  return db.prepare(`
    SELECT pm.*
    FROM integration_project_mappings pm
    JOIN tasks t ON t.project_id = pm.project_id
    WHERE t.id = ? AND pm.provider = ?
  `).get(taskId, provider) as ProjectMapping | undefined
}

function markLinkSynced(db: Database, link: LinkRow): void {
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
}

function applyRemoteGithubTaskUpdate(
  db: Database,
  taskId: string,
  issue: GithubIssueSummary,
  localStatus: string
): void {
  db.prepare(`
    UPDATE tasks
    SET title = ?,
        description = ?,
        status = ?,
        assignee = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    issue.title,
    issue.body ? markdownToHtml(issue.body) : null,
    localStatus,
    issue.assignee?.login ?? null,
    issue.updatedAt,
    taskId
  )
}

function upsertGithubFieldState(
  db: Database,
  linkId: string,
  task: Task,
  remoteIssue: GithubIssueSummary
): void {
  const columns = getProjectColumns(db, task.project_id)
  const localStatus = localStatusToGitHubState(task.status, columns)
  upsertFieldState(db, linkId, 'title', task.title, remoteIssue.title, task.updated_at, remoteIssue.updatedAt)
  upsertFieldState(db, linkId, 'description', normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null), normalizeMarkdown(remoteIssue.body), task.updated_at, remoteIssue.updatedAt)
  upsertFieldState(db, linkId, 'status', localStatus, remoteIssue.state, task.updated_at, remoteIssue.updatedAt)
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

  if (links.length === 0) return result

  // Group links by credential and batch-fetch all issues per credential
  const byCredential = new Map<string, { apiKey: string; links: LinkRow[] }>()
  for (const link of links) {
    let group = byCredential.get(link.credential_ref)
    if (!group) {
      group = { apiKey: readCredential(db, link.credential_ref), links: [] }
      byCredential.set(link.credential_ref, group)
    }
    group.links.push(link)
  }

  for (const { apiKey, links: credLinks } of byCredential.values()) {
    const issueIds = credLinks.map((l) => l.external_id)
    let issueMap: Map<string, LinearIssueSummary>

    try {
      issueMap = await getIssuesBatch(apiKey, issueIds)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      for (const link of credLinks) {
        result.scanned += 1
        db.prepare(`
          UPDATE external_links
          SET sync_state = 'error', last_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(message, link.id)
        result.errors.push(`${link.external_key}: ${message}`)
      }
      continue
    }

    for (const link of credLinks) {
      result.scanned += 1

      try {
        let remoteIssue = issueMap.get(link.external_id)

        // Batch fetch may exclude archived issues — retry with single fetch to confirm
        if (!remoteIssue) {
          const task = loadTask(db, link.task_id)
          // Skip retry if task is already archived (avoids repeated API calls)
          if (task?.archived_at) {
            markLinkSynced(db, link)
            continue
          }
          try {
            remoteIssue = (await getLinearIssue(apiKey, link.external_id)) ?? undefined
          } catch {
            // Single fetch also failed — treat as genuinely missing
          }
        }

        if (!remoteIssue) {
          // Issue is truly gone (archived/deleted) — archive local task
          db.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL")
            .run(link.task_id)
          markLinkSynced(db, link)
          result.pulled += 1
          continue
        }

        const task = loadTask(db, link.task_id)
        if (!task) continue

        const localUpdatedMs = toMs(task.updated_at)
        const remoteUpdatedMs = toMs(remoteIssue.updatedAt)

        const mapping = loadProjectMappingByTask(db, task.id, 'linear')
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

        // Archive sync: remote terminal/archived → archive locally, remote reopened → unarchive
        // Only update archived_at, NOT updated_at — avoids false "local ahead" on next tick
        const isRemoteTerminal = remoteIssue.state.type === 'completed' || remoteIssue.state.type === 'canceled' || Boolean(remoteIssue.archivedAt)
        if (isRemoteTerminal && !task.archived_at) {
          db.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ?").run(task.id)
        } else if (!isRemoteTerminal && task.archived_at) {
          db.prepare("UPDATE tasks SET archived_at = NULL WHERE id = ?").run(task.id)
        }

        markLinkSynced(db, link)
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
  }

  return result
}

export async function runGithubSyncNow(db: Database, input: SyncNowInput): Promise<SyncNowResult> {
  const result: SyncNowResult = {
    scanned: 0,
    pushed: 0,
    pulled: 0,
    conflictsResolved: 0,
    errors: [],
    at: new Date().toISOString()
  }

  const where: string[] = ["l.provider = 'github'", "c.enabled = 1"]
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

  if (links.length === 0) return result

  // Group links by credential and batch-fetch
  const byCredential = new Map<string, { token: string; links: LinkRow[] }>()
  for (const link of links) {
    let group = byCredential.get(link.credential_ref)
    if (!group) {
      group = { token: readCredential(db, link.credential_ref), links: [] }
      byCredential.set(link.credential_ref, group)
    }
    group.links.push(link)
  }

  for (const { token, links: credLinks } of byCredential.values()) {
    // Build batch input: parse external_key to get owner/repo/number
    const batchInput: Array<{ id: string; owner: string; repo: string; number: number }> = []
    const keyByExternalId = new Map<string, { owner: string; repo: string; number: number }>()
    for (const link of credLinks) {
      const key = parseGitHubExternalKey(link.external_key)
      if (!key) {
        result.scanned += 1
        result.errors.push(`Invalid external key: ${link.external_key}`)
        continue
      }
      batchInput.push({ id: link.external_id, ...key })
      keyByExternalId.set(link.external_id, key)
    }

    let issueMap: Map<string, GithubIssueSummary>
    try {
      issueMap = await getGithubIssuesBatch(token, batchInput)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      for (const link of credLinks) {
        result.scanned += 1
        db.prepare(`
          UPDATE external_links
          SET sync_state = 'error', last_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(message, link.id)
        result.errors.push(`${link.external_key}: ${message}`)
      }
      continue
    }

    for (const link of credLinks) {
      result.scanned += 1

      try {
        let remoteIssue = issueMap.get(link.external_id)

        // Batch fetch may miss issues — retry with single fetch to confirm
        if (!remoteIssue) {
          const task = loadTask(db, link.task_id)
          // Skip retry if task is already archived
          if (task?.archived_at) {
            markLinkSynced(db, link)
            continue
          }
          const key = keyByExternalId.get(link.external_id)
          if (key) {
            try {
              remoteIssue = (await getGithubIssue(token, key)) ?? undefined
            } catch {
              // Single fetch also failed
            }
          }
        }

        if (!remoteIssue) {
          // Issue is truly gone (deleted) — archive local task
          db.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL")
            .run(link.task_id)
          markLinkSynced(db, link)
          result.pulled += 1
          continue
        }

        const task = loadTask(db, link.task_id)
        if (!task) continue

        const localUpdatedMs = toMs(task.updated_at)
        const remoteUpdatedMs = toMs(remoteIssue.updatedAt)

        const mapping = loadProjectMappingByTask(db, task.id, 'github')
        const syncMode = mapping?.sync_mode ?? 'one_way'
        const columns = getProjectColumns(db, task.project_id)

        if (remoteUpdatedMs > localUpdatedMs) {
          const localStatus = githubStateToLocal(remoteIssue.state, columns)
          applyRemoteGithubTaskUpdate(db, task.id, remoteIssue, localStatus)
          const updatedTask = loadTask(db, task.id)!
          upsertGithubFieldState(db, link.id, updatedTask, remoteIssue)
          result.pulled += 1
          result.conflictsResolved += 1
        } else if (localUpdatedMs > remoteUpdatedMs && syncMode === 'two_way') {
          const key = keyByExternalId.get(link.external_id)
          if (key) {
            const updatedIssue = await updateGithubIssue(token, {
              owner: key.owner,
              repo: key.repo,
              number: key.number,
              title: task.title,
              body: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
              state: localStatusToGitHubState(task.status, columns)
            })
            if (updatedIssue) {
              result.pushed += 1
              upsertGithubFieldState(db, link.id, task, updatedIssue)
            }
          }
        }

        // Archive sync: remote closed → archive locally, remote reopened → unarchive
        // Only update archived_at, NOT updated_at — avoids false "local ahead" on next tick
        if (remoteIssue.state === 'closed' && !task.archived_at) {
          db.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ?").run(task.id)
        } else if (remoteIssue.state === 'open' && task.archived_at) {
          db.prepare("UPDATE tasks SET archived_at = NULL WHERE id = ?").run(task.id)
        }

        markLinkSynced(db, link)
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
  }

  return result
}

let syncRunning = false

export function resetSyncFlags(): void {
  syncRunning = false
  discoveryRunning = false
}

export function startSyncPoller(db: Database, onChanged?: () => void): NodeJS.Timeout {
  return setInterval(() => {
    if (syncRunning) return
    syncRunning = true
    void Promise.all([
      runSyncNow(db, {}),
      runGithubSyncNow(db, {})
    ]).then(([linear, github]) => {
      if ((linear.pulled + github.pulled + linear.pushed + github.pushed) > 0) {
        onChanged?.()
      }
    }).catch((err) => {
      console.error('Periodic sync failed:', err)
    }).finally(() => {
      syncRunning = false
    })
  }, 10 * 1000)
}

/**
 * Push a single task to all linked providers immediately after a local edit.
 * Silently skips if no external links exist.
 */
export async function pushTaskAfterEdit(
  db: Database,
  taskId: string,
  opts?: { pushGithubTask?: (taskId: string) => Promise<void> }
): Promise<void> {
  const links = db.prepare(
    "SELECT provider FROM external_links WHERE task_id = ?"
  ).all(taskId) as Array<{ provider: string }>
  if (links.length === 0) return

  const providers = new Set(links.map((l) => l.provider))

  if (providers.has('linear')) {
    await runSyncNow(db, { taskId }).catch((err) => {
      console.error(`[sync] push-on-edit failed for task ${taskId} (linear):`, err)
    })
  }
  if (providers.has('github') && opts?.pushGithubTask) {
    await opts.pushGithubTask(taskId).catch((err) => {
      console.error(`[sync] push-on-edit failed for task ${taskId} (github):`, err)
    })
  }
}

function createExternalLink(
  db: Database,
  provider: 'linear' | 'github',
  connectionId: string,
  externalId: string,
  externalKey: string,
  externalUrl: string,
  taskId: string
): string {
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO external_links (
      id, provider, connection_id, external_type, external_id, external_key,
      external_url, task_id, sync_state, last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, 'issue', ?, ?, ?, ?, 'active', datetime('now'), NULL, datetime('now'), datetime('now'))
  `).run(id, provider, connectionId, externalId, externalKey, externalUrl, taskId)
  return id
}

function createLocalTaskFromLinearIssue(
  db: Database,
  projectId: string,
  issue: LinearIssueSummary
): string {
  const columns = getProjectColumns(db, projectId)
  const defaults = buildDefaultProviderConfig(db)
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, description, status, priority, assignee,
      terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-code', ?, ?, ?, datetime('now'), ?)
  `).run(
    id, projectId, issue.title,
    issue.description ? markdownToHtml(issue.description) : null,
    linearStateToTaskStatus(issue.state.type, columns),
    linearPriorityToLocal(issue.priority),
    issue.assignee?.name ?? null,
    defaults.json, defaults.claudeFlags, defaults.codexFlags,
    issue.updatedAt
  )
  return id
}

function createLocalTaskFromGithubIssue(
  db: Database,
  projectId: string,
  issue: GithubIssueSummary
): string {
  const columns = getProjectColumns(db, projectId)
  const defaults = buildDefaultProviderConfig(db)
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, description, status, priority, assignee,
      terminal_mode, provider_config, claude_flags, codex_flags, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-code', ?, ?, ?, datetime('now'), ?)
  `).run(
    id, projectId, issue.title,
    issue.body ? markdownToHtml(issue.body) : null,
    githubStateToLocal(issue.state, columns),
    3,
    issue.assignee?.login ?? null,
    defaults.json, defaults.claudeFlags, defaults.codexFlags,
    issue.updatedAt
  )
  return id
}

export async function pushNewTaskToProviders(db: Database, taskId: string, projectId: string): Promise<void> {
  const mappings = db.prepare(`
    SELECT pm.*, c.credential_ref
    FROM integration_project_mappings pm
    JOIN integration_connections c ON c.id = pm.connection_id AND c.enabled = 1
    WHERE pm.project_id = ? AND pm.sync_mode = 'two_way' AND pm.status_setup_complete = 1
  `).all(projectId) as Array<IntegrationProjectMapping & { credential_ref: string }>

  const task = loadTask(db, taskId)
  if (!task) return

  for (const mapping of mappings) {
    // Skip if already linked
    const existing = db.prepare(
      'SELECT id FROM external_links WHERE task_id = ? AND provider = ?'
    ).get(taskId, mapping.provider)
    if (existing) continue

    try {
      const credential = readCredential(db, mapping.credential_ref)

      if (mapping.provider === 'linear') {
        const stateId = getDesiredLinearStateId(db, mapping, projectId, task.status)
        const issue = await createLinearIssue(credential, {
          teamId: mapping.external_team_id,
          title: task.title,
          description: task.description ? htmlToMarkdown(task.description) : undefined,
          priority: localPriorityToLinear(task.priority),
          stateId,
          projectId: mapping.external_project_id
        })
        if (!issue) continue

        const linkId = createExternalLink(db, 'linear', mapping.connection_id, issue.id, issue.identifier, issue.url, taskId)
        upsertFieldState(db, linkId, 'title', task.title, issue.title, task.updated_at, issue.updatedAt)
        upsertFieldState(db, linkId, 'description', task.description, issue.description, task.updated_at, issue.updatedAt)
        upsertFieldState(db, linkId, 'priority', task.priority, issue.priority, task.updated_at, issue.updatedAt)
        upsertFieldState(db, linkId, 'status', task.status, issue.state.type, task.updated_at, issue.updatedAt)
      } else if (mapping.provider === 'github') {
        if (!mapping.external_repo_owner || !mapping.external_repo_name) continue
        const issue = await createGithubIssue(credential, {
          owner: mapping.external_repo_owner,
          repo: mapping.external_repo_name,
          title: task.title,
          body: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null)
        })

        const externalKey = `${mapping.external_repo_owner}/${mapping.external_repo_name}#${issue.number}`
        const linkId = createExternalLink(db, 'github', mapping.connection_id, issue.id, externalKey, issue.url, taskId)
        const updatedTask = loadTask(db, taskId)!
        upsertGithubFieldState(db, linkId, updatedTask, issue)
      }
    } catch (err) {
      console.error(`[sync] push-new-task failed for task ${taskId} (${mapping.provider}):`, err)
    }
  }
}

export async function pushArchiveToProviders(db: Database, taskId: string): Promise<void> {
  const links = db.prepare(`
    SELECT l.*, c.credential_ref
    FROM external_links l
    JOIN integration_connections c ON c.id = l.connection_id AND c.enabled = 1
    WHERE l.task_id = ?
  `).all(taskId) as LinkRow[]

  const task = loadTask(db, taskId)
  if (!task) return

  for (const link of links) {
    try {
      const mapping = loadProjectMappingByTask(db, taskId, link.provider as 'linear' | 'github')
      if (mapping?.sync_mode !== 'two_way') continue

      const credential = readCredential(db, link.credential_ref)

      if (link.provider === 'linear') {
        const columns = getProjectColumns(db, task.project_id)
        const doneStatus = getDoneStatus(columns)
        const stateId = getDesiredLinearStateId(db, mapping, task.project_id, doneStatus)
        await updateIssue(credential, link.external_id, { stateId })
      } else if (link.provider === 'github') {
        const key = parseGitHubExternalKey(link.external_key)
        if (!key) continue
        await updateGithubIssue(credential, {
          owner: key.owner, repo: key.repo, number: key.number,
          title: task.title,
          body: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
          state: 'closed'
        })
      }
    } catch (err) {
      console.error(`[sync] push-archive failed for task ${taskId} (${link.provider}):`, err)
    }
  }
}

export async function pushUnarchiveToProviders(db: Database, taskId: string): Promise<void> {
  const links = db.prepare(`
    SELECT l.*, c.credential_ref
    FROM external_links l
    JOIN integration_connections c ON c.id = l.connection_id AND c.enabled = 1
    WHERE l.task_id = ?
  `).all(taskId) as LinkRow[]

  const task = loadTask(db, taskId)
  if (!task) return

  for (const link of links) {
    try {
      const mapping = loadProjectMappingByTask(db, taskId, link.provider as 'linear' | 'github')
      if (mapping?.sync_mode !== 'two_way') continue

      const credential = readCredential(db, link.credential_ref)

      if (link.provider === 'linear') {
        const columns = getProjectColumns(db, task.project_id)
        const defaultStatus = getDefaultStatus(columns)
        const stateId = getDesiredLinearStateId(db, mapping, task.project_id, defaultStatus)
        await updateIssue(credential, link.external_id, { stateId })
      } else if (link.provider === 'github') {
        const key = parseGitHubExternalKey(link.external_key)
        if (!key) continue
        await updateGithubIssue(credential, {
          owner: key.owner, repo: key.repo, number: key.number,
          title: task.title,
          body: normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
          state: 'open'
        })
      }
    } catch (err) {
      console.error(`[sync] push-unarchive failed for task ${taskId} (${link.provider}):`, err)
    }
  }
}

export async function runDiscovery(db: Database): Promise<number> {
  const mappings = db.prepare(`
    SELECT pm.*, c.credential_ref
    FROM integration_project_mappings pm
    JOIN integration_connections c ON c.id = pm.connection_id AND c.enabled = 1
    WHERE pm.status_setup_complete = 1
  `).all() as Array<IntegrationProjectMapping & { credential_ref: string }>

  console.log(`[discovery] found ${mappings.length} active mappings`)

  let totalDiscovered = 0
  for (const mapping of mappings) {
    try {
      const credential = readCredential(db, mapping.credential_ref)

      if (mapping.provider === 'linear') {
        totalDiscovered += await discoverLinearIssues(db, mapping, credential)
      } else if (mapping.provider === 'github') {
        totalDiscovered += await discoverGithubIssues(db, mapping, credential)
      }
    } catch (err) {
      console.error(`[discovery] failed for mapping ${mapping.id} (${mapping.provider}):`, err)
    }
  }
  return totalDiscovered
}

async function discoverLinearIssues(
  db: Database,
  mapping: IntegrationProjectMapping & { credential_ref: string },
  apiKey: string
): Promise<number> {
  let cursor: string | null = null
  let discovered = 0

  do {
    const { issues, nextCursor } = await listLinearIssues(apiKey, {
      teamId: mapping.external_team_id,
      projectId: mapping.external_project_id ?? undefined,
      first: 50,
      after: cursor,
      updatedAfter: mapping.last_discovery_at
    })

    for (const issue of issues) {
      const linked = db.prepare(
        "SELECT id FROM external_links WHERE provider = 'linear' AND external_id = ?"
      ).get(issue.id)
      if (linked) continue

      try {
        const taskId = createLocalTaskFromLinearIssue(db, mapping.project_id, issue)
        const linkId = createExternalLink(db, 'linear', mapping.connection_id, issue.id, issue.identifier, issue.url, taskId)
        const task = loadTask(db, taskId)!
        upsertFieldState(db, linkId, 'title', task.title, issue.title, task.updated_at, issue.updatedAt)
        upsertFieldState(db, linkId, 'description', task.description, issue.description, task.updated_at, issue.updatedAt)
        upsertFieldState(db, linkId, 'status', task.status, issue.state.type, task.updated_at, issue.updatedAt)
        discovered++
      } catch (err) {
        // UNIQUE constraint violation = already linked (race), skip
        if (err instanceof Error && err.message.includes('UNIQUE')) continue
        throw err
      }
    }

    cursor = nextCursor
  } while (cursor)

  db.prepare(
    "UPDATE integration_project_mappings SET last_discovery_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(mapping.id)

  if (discovered > 0) {
    console.log(`[discovery] Linear: discovered ${discovered} new issues for project ${mapping.project_id}`)
  }
  return discovered
}

async function discoverGithubIssues(
  db: Database,
  mapping: IntegrationProjectMapping & { credential_ref: string },
  token: string
): Promise<number> {
  if (!mapping.external_repo_owner || !mapping.external_repo_name) {
    console.log(`[discovery] GitHub: skipping mapping ${mapping.id} — no repo configured (owner=${mapping.external_repo_owner}, name=${mapping.external_repo_name})`)
    return 0
  }

  let cursor: string | null = null
  let discovered = 0

  do {
    const { issues, nextCursor } = await listGithubIssues(token, {
      owner: mapping.external_repo_owner,
      repo: mapping.external_repo_name,
      limit: 100,
      cursor,
      since: mapping.last_discovery_at
    })

    for (const issue of issues) {
      const linked = db.prepare(
        "SELECT id FROM external_links WHERE provider = 'github' AND external_id = ?"
      ).get(issue.id)
      if (linked) continue

      try {
        const taskId = createLocalTaskFromGithubIssue(db, mapping.project_id, issue)
        const externalKey = `${issue.repository.fullName}#${issue.number}`
        const linkId = createExternalLink(db, 'github', mapping.connection_id, issue.id, externalKey, issue.url, taskId)
        const task = loadTask(db, taskId)!
        upsertGithubFieldState(db, linkId, task, issue)
        discovered++
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) continue
        throw err
      }
    }

    cursor = nextCursor
  } while (cursor)

  db.prepare(
    "UPDATE integration_project_mappings SET last_discovery_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(mapping.id)

  if (discovered > 0) {
    console.log(`[discovery] GitHub: discovered ${discovered} new issues for project ${mapping.project_id}`)
  }
  return discovered
}

let discoveryRunning = false

export function startDiscoveryPoller(db: Database, onChanged?: () => void): NodeJS.Timeout {
  // Run immediately on startup, then every 60s
  void runDiscovery(db).then((discovered) => {
    if (discovered && discovered > 0) onChanged?.()
  }).catch((err) => {
    console.error('Initial discovery failed:', err)
  })
  return setInterval(() => {
    if (discoveryRunning) return
    discoveryRunning = true
    void runDiscovery(db).then((discovered) => {
      if (discovered && discovered > 0) onChanged?.()
    }).catch((err) => {
      console.error('Discovery poll failed:', err)
    }).finally(() => {
      discoveryRunning = false
    })
  }, 60 * 1000)
}
