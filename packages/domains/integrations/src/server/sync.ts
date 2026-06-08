import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ExternalLink,
  IntegrationProjectMapping,
  IntegrationProvider,
  SyncNowInput,
  SyncNowResult
} from '../shared'
import { readCredential } from './credentials'
import { htmlToMarkdown, markdownToHtml } from './markdown'
import { toMs, getProjectColumns, normalizeMarkdown, upsertFieldState } from './sync-helpers'
import { isAuthError, isNetworkError } from './sync-classifiers'

export { isAuthError, isNetworkError }
import {
  getColumnById,
  getDefaultStatus,
  getDoneStatus,
  getStatusByCategories,
  isKnownStatus,
  isTerminalStatus,
  type ColumnConfig,
  type WorkflowCategory
} from '@slayzone/workflow'
import { onTaskReachedTerminal } from '@slayzone/terminal/electron'
import { createImportedTaskOp } from '@slayzone/task/server'
import { getAdapter, getRegisteredProviders } from './adapters'
import type { NormalizedIssue, ProviderAdapter } from './adapters'

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

// --- Generic status resolution helpers ---

/**
 * Resolve the local status column ID for a remote status.
 * 1. Check integration_state_mappings for explicit mapping by state_type
 * 2. Fall back to adapter's category mapping → getStatusByCategories()
 */
export async function resolveLocalStatus(
  db: SlayzoneDb,
  adapter: ProviderAdapter,
  mapping: ProjectMapping | undefined,
  projectId: string,
  remoteStatusType: string,
  remoteStatusName: string
): Promise<string> {
  const columns = await getProjectColumns(db, projectId)

  if (mapping) {
    const mapped = (await db
      .prepare(`
      SELECT local_status FROM integration_state_mappings
      WHERE provider = ? AND project_mapping_id = ? AND state_type = ?
      ORDER BY rowid ASC
      LIMIT 1
    `)
      .get(mapping.provider, mapping.id, remoteStatusType)) as { local_status: string } | undefined

    if (mapped && isKnownStatus(mapped.local_status, columns)) {
      return mapped.local_status
    }
  }

  // Fall back to adapter-based category mapping
  const category = adapter.remoteStatusToCategory({
    id: remoteStatusType,
    name: remoteStatusName,
    color: '',
    type: remoteStatusType
  })
  return resolveStatusByCategory(category, columns)
}

export function resolveStatusByCategory(
  category: WorkflowCategory,
  columns: ColumnConfig[] | null
): string {
  const CATEGORY_FALLBACKS: Record<WorkflowCategory, WorkflowCategory[]> = {
    triage: ['triage', 'unstarted', 'backlog'],
    backlog: ['backlog', 'unstarted', 'triage'],
    unstarted: ['unstarted', 'triage', 'backlog'],
    started: ['started'],
    completed: ['completed', 'canceled'],
    canceled: ['canceled', 'completed']
  }
  return getStatusByCategories(CATEGORY_FALLBACKS[category], columns) ?? getDefaultStatus(columns)
}

/**
 * Find the remote state_id to use when pushing a local status.
 * Works for any provider that has integration_state_mappings.
 */
export async function getDesiredRemoteStatusId(
  db: SlayzoneDb,
  mapping: IntegrationProjectMapping | undefined,
  projectId: string,
  taskStatus: string
): Promise<string | undefined> {
  if (!mapping) return undefined

  // Direct mapping: local_status → state_id
  const direct = (await db
    .prepare(`
    SELECT state_id FROM integration_state_mappings
    WHERE provider = ? AND project_mapping_id = ? AND local_status = ?
  `)
    .get(mapping.provider, mapping.id, taskStatus)) as { state_id: string } | undefined
  if (direct?.state_id) return direct.state_id

  // Category-based fallback: find state mappings with matching category
  const projectColumns = await getProjectColumns(db, projectId)
  const statusColumn = getColumnById(taskStatus, projectColumns)
  if (!statusColumn) return undefined

  const CATEGORY_FALLBACKS: Record<WorkflowCategory, string[]> = {
    triage: ['triage', 'unstarted', 'backlog'],
    backlog: ['backlog', 'unstarted', 'triage'],
    unstarted: ['unstarted', 'triage', 'backlog'],
    started: ['started'],
    completed: ['completed', 'canceled'],
    canceled: ['canceled', 'completed']
  }

  for (const stateType of CATEGORY_FALLBACKS[statusColumn.category]) {
    const byType = (await db
      .prepare(`
      SELECT state_id FROM integration_state_mappings
      WHERE provider = ? AND project_mapping_id = ? AND state_type = ?
      ORDER BY rowid ASC
      LIMIT 1
    `)
      .get(mapping.provider, mapping.id, stateType)) as { state_id: string } | undefined
    if (byType?.state_id) return byType.state_id
  }

  return undefined
}

/** @deprecated Use getDesiredRemoteStatusId instead */
export const getDesiredLinearStateId = getDesiredRemoteStatusId

// --- Core helpers ---

async function loadTask(db: SlayzoneDb, taskId: string): Promise<Task | null> {
  const row = (await db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)) as Task | undefined
  return row ?? null
}

async function loadProjectMappingByTask(
  db: SlayzoneDb,
  taskId: string,
  provider: IntegrationProvider
): Promise<ProjectMapping | undefined> {
  return (await db
    .prepare(`
    SELECT pm.*
    FROM integration_project_mappings pm
    JOIN tasks t ON t.project_id = pm.project_id
    WHERE t.id = ? AND pm.provider = ?
  `)
    .get(taskId, provider)) as ProjectMapping | undefined
}

async function markLinkSynced(db: SlayzoneDb, link: LinkRow): Promise<void> {
  await db.prepare(`
    UPDATE external_links
    SET sync_state = 'active', last_error = NULL, last_sync_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(link.id)
  await db.prepare(`
    UPDATE integration_connections
    SET last_synced_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(link.connection_id)
}

async function markLinkError(db: SlayzoneDb, linkId: string, message: string): Promise<void> {
  await db.prepare(`
    UPDATE external_links
    SET sync_state = 'error', last_error = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(message, linkId)
}

async function createExternalLink(
  db: SlayzoneDb,
  provider: IntegrationProvider,
  connectionId: string,
  externalId: string,
  externalKey: string,
  externalUrl: string,
  taskId: string
): Promise<string> {
  const id = crypto.randomUUID()
  await db.prepare(`
    INSERT INTO external_links (
      id, provider, connection_id, external_type, external_id, external_key,
      external_url, task_id, sync_state, last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, 'issue', ?, ?, ?, ?, 'active', datetime('now'), NULL, datetime('now'), datetime('now'))
  `).run(id, provider, connectionId, externalId, externalKey, externalUrl, taskId)
  return id
}

// --- Unified remote update / field state ---

async function applyRemoteUpdate(
  db: SlayzoneDb,
  taskId: string,
  issue: NormalizedIssue,
  localStatus: string,
  priority?: number
): Promise<void> {
  if (priority !== undefined) {
    await db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, status = ?, priority = ?, assignee = ?, updated_at = ?
      WHERE id = ?
    `).run(
      issue.title,
      issue.description ? markdownToHtml(issue.description) : null,
      localStatus,
      priority,
      issue.assignee?.name ?? null,
      issue.updatedAt,
      taskId
    )
  } else {
    await db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, status = ?, assignee = ?, updated_at = ?
      WHERE id = ?
    `).run(
      issue.title,
      issue.description ? markdownToHtml(issue.description) : null,
      localStatus,
      issue.assignee?.name ?? null,
      issue.updatedAt,
      taskId
    )
  }
}

async function upsertNormalizedFieldState(
  db: SlayzoneDb,
  linkId: string,
  task: Task,
  issue: NormalizedIssue
): Promise<void> {
  await upsertFieldState(
    db,
    linkId,
    'title',
    task.title,
    issue.title,
    task.updated_at,
    issue.updatedAt
  )
  await upsertFieldState(
    db,
    linkId,
    'description',
    normalizeMarkdown(task.description ? htmlToMarkdown(task.description) : null),
    normalizeMarkdown(issue.description),
    task.updated_at,
    issue.updatedAt
  )
  await upsertFieldState(
    db,
    linkId,
    'status',
    task.status,
    issue.status.type,
    task.updated_at,
    issue.updatedAt
  )
  if (issue.extras.priority !== undefined) {
    await upsertFieldState(
      db,
      linkId,
      'priority',
      task.priority,
      issue.extras.priority,
      task.updated_at,
      issue.updatedAt
    )
  }
}

function resolvePriorityFromExtras(
  extras: Record<string, unknown>,
  existingPriority: number
): number {
  const raw = extras.priority
  if (typeof raw !== 'number') return existingPriority
  // Linear priority mapping: 0=none→3, 1=urgent→5, 2=high→4, 3=medium→3, 4=low→2
  if (raw <= 1) return 5
  if (raw === 2) return 4
  if (raw === 3) return 3
  if (raw === 4) return 2
  if (raw >= 5) return 1
  return 3
}

function localPriorityToExtras(priority: number): number {
  if (priority <= 1) return 4
  if (priority === 2) return 4
  if (priority === 3) return 3
  if (priority === 4) return 2
  if (priority >= 5) return 1
  return 3
}

// --- Unified sync ---

export async function runProviderSync(
  db: SlayzoneDb,
  provider: IntegrationProvider,
  input: SyncNowInput
): Promise<SyncNowResult> {
  const adapter = getAdapter(provider)
  const result: SyncNowResult = {
    scanned: 0,
    pushed: 0,
    pulled: 0,
    conflictsResolved: 0,
    errors: [],
    at: new Date().toISOString()
  }

  const where: string[] = ['l.provider = ?', 'c.enabled = 1']
  const values: unknown[] = [provider]

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

  const links = (await db
    .prepare(`
    SELECT l.*, c.credential_ref
    FROM external_links l
    JOIN integration_connections c ON c.id = l.connection_id
    JOIN tasks t ON t.id = l.task_id
    JOIN integration_project_mappings pm ON pm.project_id = t.project_id AND pm.provider = l.provider
    WHERE ${where.join(' AND ')} AND pm.status_setup_complete = 1
  `)
    .all(...values)) as LinkRow[]

  if (links.length === 0) return result

  // Group by credential for batch operations
  const byCredential = new Map<string, { credential: string; links: LinkRow[] }>()
  for (const link of links) {
    let group = byCredential.get(link.credential_ref)
    if (!group) {
      group = { credential: await readCredential(db, link.credential_ref), links: [] }
      byCredential.set(link.credential_ref, group)
    }
    group.links.push(link)
  }

  for (const { credential, links: credLinks } of byCredential.values()) {
    // Build refs with context from external_key
    const refs = credLinks.map((link) => ({
      id: link.external_id,
      context: adapter.parseExternalKey(link.external_key) ?? undefined
    }))

    let issueMap: Map<string, NormalizedIssue>
    try {
      issueMap = await adapter.getIssuesBatch(credential, refs)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isAuthError(err)) {
        const seen = new Set<string>()
        for (const link of credLinks) {
          if (seen.has(link.connection_id)) continue
          seen.add(link.connection_id)
          await markConnectionAuthError(db, link.connection_id, message)
        }
        for (const link of credLinks) {
          result.scanned += 1
          result.errors.push(`${link.external_key}: ${message}`)
        }
        continue
      }
      for (const link of credLinks) {
        result.scanned += 1
        await markLinkError(db, link.id, message)
        result.errors.push(`${link.external_key}: ${message}`)
      }
      continue
    }

    for (const link of credLinks) {
      result.scanned += 1

      try {
        let remoteIssue = issueMap.get(link.external_id)

        // Batch fetch may miss issues — retry with single fetch
        if (!remoteIssue) {
          const task = await loadTask(db, link.task_id)
          if (task?.archived_at) {
            await markLinkSynced(db, link)
            continue
          }
          try {
            const ctx = adapter.parseExternalKey(link.external_key) ?? undefined
            remoteIssue = (await adapter.getIssue(credential, link.external_id, ctx)) ?? undefined
          } catch {
            // Single fetch failed
          }
        }

        if (!remoteIssue) {
          // Issue gone — archive local task
          await db.prepare(
            "UPDATE tasks SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL"
          ).run(link.task_id)
          await markLinkSynced(db, link)
          result.pulled += 1
          continue
        }

        const task = await loadTask(db, link.task_id)
        if (!task) continue

        const localUpdatedMs = toMs(task.updated_at)
        const remoteUpdatedMs = toMs(remoteIssue.updatedAt)

        const mapping = await loadProjectMappingByTask(db, task.id, provider)
        const syncMode = mapping?.sync_mode ?? 'one_way'

        if (remoteUpdatedMs > localUpdatedMs) {
          // Pull remote changes
          const localStatus = await resolveLocalStatus(
            db,
            adapter,
            mapping,
            task.project_id,
            remoteIssue.status.type,
            remoteIssue.status.name
          )
          const priority = resolvePriorityFromExtras(remoteIssue.extras, task.priority)
          await applyRemoteUpdate(
            db,
            task.id,
            remoteIssue,
            localStatus,
            remoteIssue.extras.priority !== undefined ? priority : undefined
          )
          const updatedTask = (await loadTask(db, task.id))!
          const columns = await getProjectColumns(db, task.project_id)
          if (isTerminalStatus(localStatus, columns)) onTaskReachedTerminal(task.id)
          await upsertNormalizedFieldState(db, link.id, updatedTask, remoteIssue)
          result.pulled += 1
          result.conflictsResolved += 1
        } else if (localUpdatedMs > remoteUpdatedMs && syncMode === 'two_way') {
          // Push local changes
          const statusId = await getDesiredRemoteStatusId(db, mapping, task.project_id, task.status)
          const ctx = adapter.parseExternalKey(link.external_key) ?? undefined

          const extras: Record<string, unknown> = {}
          if (remoteIssue.extras.priority !== undefined) {
            extras.priority = localPriorityToExtras(task.priority)
          }
          // GitHub needs explicit state for updateIssue
          if (provider === 'github') {
            const columns = await getProjectColumns(db, task.project_id)
            const col = getColumnById(task.status, columns)
            extras.state =
              col?.category === 'completed' || col?.category === 'canceled' ? 'closed' : 'open'
          }

          const updatedIssue = await adapter.updateIssue(
            credential,
            link.external_id,
            {
              title: task.title,
              description: normalizeMarkdown(
                task.description ? htmlToMarkdown(task.description) : null
              ),
              statusId,
              extras
            },
            ctx
          )

          if (updatedIssue) {
            result.pushed += 1
            await upsertNormalizedFieldState(db, link.id, task, updatedIssue)
          }
        }

        // Archive sync
        if (remoteIssue.isArchived && !task.archived_at) {
          await db.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ?").run(task.id)
        } else if (!remoteIssue.isArchived && task.archived_at) {
          await db.prepare('UPDATE tasks SET archived_at = NULL WHERE id = ?').run(task.id)
        }

        await markLinkSynced(db, link)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isAuthError(err)) {
          await markConnectionAuthError(db, link.connection_id, message)
          result.errors.push(`${link.external_key}: ${message}`)
          continue
        }
        await markLinkError(db, link.id, message)
        result.errors.push(`${link.external_key}: ${message}`)
      }
    }
  }

  return result
}

/** @deprecated Use runProviderSync(db, 'linear', input) */
export async function runSyncNow(db: SlayzoneDb, input: SyncNowInput): Promise<SyncNowResult> {
  return runProviderSync(db, 'linear', input)
}

/** @deprecated Use runProviderSync(db, 'github', input) */
export async function runGithubSyncNow(db: SlayzoneDb, input: SyncNowInput): Promise<SyncNowResult> {
  return runProviderSync(db, 'github', input)
}

// --- Sync poller ---

let syncRunning = false

export function resetSyncFlags(): void {
  syncRunning = false
  discoveryRunning = false
}

export function startSyncPoller(db: SlayzoneDb, onChanged?: () => void): NodeJS.Timeout {
  return setInterval(() => {
    if (syncRunning) return
    syncRunning = true
    const providers = getRegisteredProviders()
    void Promise.all(providers.map((provider) => runProviderSync(db, provider, {})))
      .then((results) => {
        const totalChanges = results.reduce((sum, r) => sum + r.pulled + r.pushed, 0)
        if (totalChanges > 0) onChanged?.()
      })
      .catch((err) => {
        console.error('Periodic sync failed:', err)
      })
      .finally(() => {
        syncRunning = false
      })
  }, 10 * 1000)
}

/**
 * Push a single task to all linked providers immediately after a local edit.
 * Silently skips if no external links exist.
 */
export async function pushTaskAfterEdit(
  db: SlayzoneDb,
  taskId: string,
  opts?: { pushGithubTask?: (taskId: string) => Promise<void> }
): Promise<void> {
  const links = (await db
    .prepare('SELECT provider FROM external_links WHERE task_id = ?')
    .all(taskId)) as Array<{ provider: string }>
  if (links.length === 0) return

  const providers = new Set(links.map((l) => l.provider))

  for (const provider of providers) {
    if (provider === 'github' && opts?.pushGithubTask) {
      await opts.pushGithubTask(taskId).catch((err) => {
        console.error(`[sync] push-on-edit failed for task ${taskId} (github):`, err)
      })
    } else {
      await runProviderSync(db, provider as IntegrationProvider, { taskId }).catch((err) => {
        console.error(`[sync] push-on-edit failed for task ${taskId} (${provider}):`, err)
      })
    }
  }
}

// --- Unified task creation from normalized issue ---

async function createLocalTaskFromNormalizedIssue(
  db: SlayzoneDb,
  adapter: ProviderAdapter,
  projectId: string,
  issue: NormalizedIssue
): Promise<string> {
  const columns = await getProjectColumns(db, projectId)
  const category = adapter.remoteStatusToCategory({
    id: issue.status.id,
    name: issue.status.name,
    color: '',
    type: issue.status.type
  })
  const status = resolveStatusByCategory(category, columns)
  const priority = resolvePriorityFromExtras(issue.extras, 3)
  const task = await createImportedTaskOp(db, {
    projectId,
    title: issue.title,
    descriptionHtml: issue.description ? markdownToHtml(issue.description) : null,
    status,
    priority,
    assignee: issue.assignee?.name ?? null,
    externalUpdatedAt: issue.updatedAt
  })
  if (!task) throw new Error(`Failed to create imported ${adapter.provider} task`)
  return task.id
}

// --- Unified push functions ---

export async function pushNewTaskToProviders(
  db: SlayzoneDb,
  taskId: string,
  projectId: string
): Promise<void> {
  const mappings = (await db
    .prepare(`
    SELECT pm.*, c.credential_ref
    FROM integration_project_mappings pm
    JOIN integration_connections c ON c.id = pm.connection_id AND c.enabled = 1
    WHERE pm.project_id = ? AND pm.sync_mode = 'two_way' AND pm.status_setup_complete = 1
  `)
    .all(projectId)) as Array<IntegrationProjectMapping & { credential_ref: string }>

  const task = await loadTask(db, taskId)
  if (!task) return

  for (const mapping of mappings) {
    const existing = await db
      .prepare('SELECT id FROM external_links WHERE task_id = ? AND provider = ?')
      .get(taskId, mapping.provider)
    if (existing) continue

    try {
      const adapter = getAdapter(mapping.provider as IntegrationProvider)
      const credential = await readCredential(db, mapping.credential_ref)
      const statusId = await getDesiredRemoteStatusId(db, mapping, projectId, task.status)

      const extras: Record<string, unknown> = {}
      if (mapping.provider === 'linear') {
        extras.priority = localPriorityToExtras(task.priority)
      }

      // Build groupId: Linear=teamId, GitHub=owner/repo
      let groupId = mapping.external_team_id
      if (mapping.provider === 'github') {
        if (!mapping.external_repo_owner || !mapping.external_repo_name) continue
        groupId = `${mapping.external_repo_owner}/${mapping.external_repo_name}`
      }

      const issue = await adapter.createIssue(credential, {
        groupId,
        scopeId: mapping.external_project_id,
        title: task.title,
        description: task.description ? htmlToMarkdown(task.description) : undefined,
        statusId,
        extras
      })

      const externalKey = adapter.buildExternalKey(issue)
      const linkId = await createExternalLink(
        db,
        mapping.provider as IntegrationProvider,
        mapping.connection_id,
        issue.id,
        externalKey,
        issue.url,
        taskId
      )
      await upsertNormalizedFieldState(db, linkId, task, issue)
    } catch (err) {
      if (isAuthError(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        await markConnectionAuthError(db, mapping.connection_id, msg)
        console.warn(
          `[sync] push-new-task auth failed for ${mapping.provider} connection ${mapping.connection_id} — disabled`
        )
        continue
      }
      console.error(`[sync] push-new-task failed for task ${taskId} (${mapping.provider}):`, err)
    }
  }
}

export async function pushArchiveToProviders(db: SlayzoneDb, taskId: string): Promise<void> {
  const links = (await db
    .prepare(`
    SELECT l.*, c.credential_ref
    FROM external_links l
    JOIN integration_connections c ON c.id = l.connection_id AND c.enabled = 1
    WHERE l.task_id = ?
  `)
    .all(taskId)) as LinkRow[]

  const task = await loadTask(db, taskId)
  if (!task) return

  for (const link of links) {
    try {
      const provider = link.provider as IntegrationProvider
      const mapping = await loadProjectMappingByTask(db, taskId, provider)
      if (mapping?.sync_mode !== 'two_way') continue

      const adapter = getAdapter(provider)
      const credential = await readCredential(db, link.credential_ref)
      const ctx = adapter.parseExternalKey(link.external_key) ?? undefined

      const columns = await getProjectColumns(db, task.project_id)
      const doneStatus = getDoneStatus(columns)
      const statusId = await getDesiredRemoteStatusId(db, mapping, task.project_id, doneStatus)

      const extras: Record<string, unknown> = {}
      if (provider === 'github') {
        extras.state = 'closed'
      }

      await adapter.updateIssue(
        credential,
        link.external_id,
        {
          title: task.title,
          description: normalizeMarkdown(
            task.description ? htmlToMarkdown(task.description) : null
          ),
          statusId,
          extras
        },
        ctx
      )
    } catch (err) {
      if (isAuthError(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        await markConnectionAuthError(db, link.connection_id, msg)
        console.warn(
          `[sync] push-archive auth failed for ${link.provider} connection ${link.connection_id} — disabled`
        )
        continue
      }
      console.error(`[sync] push-archive failed for task ${taskId} (${link.provider}):`, err)
    }
  }
}

export async function pushUnarchiveToProviders(db: SlayzoneDb, taskId: string): Promise<void> {
  const links = (await db
    .prepare(`
    SELECT l.*, c.credential_ref
    FROM external_links l
    JOIN integration_connections c ON c.id = l.connection_id AND c.enabled = 1
    WHERE l.task_id = ?
  `)
    .all(taskId)) as LinkRow[]

  const task = await loadTask(db, taskId)
  if (!task) return

  for (const link of links) {
    try {
      const provider = link.provider as IntegrationProvider
      const mapping = await loadProjectMappingByTask(db, taskId, provider)
      if (mapping?.sync_mode !== 'two_way') continue

      const adapter = getAdapter(provider)
      const credential = await readCredential(db, link.credential_ref)
      const ctx = adapter.parseExternalKey(link.external_key) ?? undefined

      const columns = await getProjectColumns(db, task.project_id)
      const defaultStatus = getDefaultStatus(columns)
      const statusId = await getDesiredRemoteStatusId(db, mapping, task.project_id, defaultStatus)

      const extras: Record<string, unknown> = {}
      if (provider === 'github') {
        extras.state = 'open'
      }

      await adapter.updateIssue(
        credential,
        link.external_id,
        {
          title: task.title,
          description: normalizeMarkdown(
            task.description ? htmlToMarkdown(task.description) : null
          ),
          statusId,
          extras
        },
        ctx
      )
    } catch (err) {
      if (isAuthError(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        await markConnectionAuthError(db, link.connection_id, msg)
        console.warn(
          `[sync] push-unarchive auth failed for ${link.provider} connection ${link.connection_id} — disabled`
        )
        continue
      }
      console.error(`[sync] push-unarchive failed for task ${taskId} (${link.provider}):`, err)
    }
  }
}

// --- Unified discovery ---

async function discoverIssues(
  db: SlayzoneDb,
  adapter: ProviderAdapter,
  mapping: IntegrationProjectMapping & { credential_ref: string },
  credential: string
): Promise<number> {
  // GitHub needs repo configured for discovery
  if (
    mapping.provider === 'github' &&
    (!mapping.external_repo_owner || !mapping.external_repo_name)
  ) {
    console.log(`[discovery] GitHub: skipping mapping ${mapping.id} — no repo configured`)
    return 0
  }

  let cursor: string | null = null
  let discovered = 0

  // Build groupId: Linear=teamId, GitHub=owner/repo
  let groupId = mapping.external_team_id
  if (mapping.provider === 'github' && mapping.external_repo_owner && mapping.external_repo_name) {
    groupId = `${mapping.external_repo_owner}/${mapping.external_repo_name}`
  }

  do {
    const { issues, nextCursor } = await adapter.listIssues(credential, {
      groupId,
      scopeId: mapping.external_project_id ?? undefined,
      limit: mapping.provider === 'github' ? 100 : 50,
      cursor,
      updatedAfter: mapping.last_discovery_at,
      assignedToMe: Boolean(mapping.assigned_to_me)
    })

    for (const issue of issues) {
      const linked = await db
        .prepare('SELECT id FROM external_links WHERE provider = ? AND external_id = ?')
        .get(mapping.provider, issue.id)
      if (linked) continue

      try {
        const taskId = await createLocalTaskFromNormalizedIssue(
          db,
          adapter,
          mapping.project_id,
          issue
        )
        const externalKey = adapter.buildExternalKey(issue)
        const linkId = await createExternalLink(
          db,
          mapping.provider as IntegrationProvider,
          mapping.connection_id,
          issue.id,
          externalKey,
          issue.url,
          taskId
        )
        const task = (await loadTask(db, taskId))!
        await upsertNormalizedFieldState(db, linkId, task, issue)
        discovered++
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE')) continue
        throw err
      }
    }

    cursor = nextCursor
  } while (cursor)

  await db.prepare(
    "UPDATE integration_project_mappings SET last_discovery_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(mapping.id)

  if (discovered > 0) {
    console.log(
      `[discovery] ${mapping.provider}: discovered ${discovered} new issues for project ${mapping.project_id}`
    )
  }
  return discovered
}

export async function runDiscovery(db: SlayzoneDb): Promise<number> {
  const mappings = (await db
    .prepare(`
    SELECT pm.*, c.credential_ref
    FROM integration_project_mappings pm
    JOIN integration_connections c ON c.id = pm.connection_id AND c.enabled = 1
    WHERE pm.status_setup_complete = 1
  `)
    .all()) as Array<IntegrationProjectMapping & { credential_ref: string }>

  let totalDiscovered = 0
  let networkDown = false
  for (const mapping of mappings) {
    try {
      const adapter = getAdapter(mapping.provider as IntegrationProvider)
      const credential = await readCredential(db, mapping.credential_ref)
      totalDiscovered += await discoverIssues(db, adapter, mapping, credential)
    } catch (err) {
      if (isAuthError(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        await markConnectionAuthError(db, mapping.connection_id, msg)
        console.warn(
          `[discovery] auth failed for ${mapping.provider} connection ${mapping.connection_id} — disabled, awaiting re-auth`
        )
        continue
      }
      if (isNetworkError(err)) {
        if (!networkDown) {
          networkDown = true
          console.warn(`[discovery] network unavailable, skipping remaining mappings`)
        }
        continue
      }
      console.error(`[discovery] failed for mapping ${mapping.id} (${mapping.provider}):`, err)
    }
  }
  if (networkDown) throw new Error('fetch failed') // propagate to poller for backoff
  return totalDiscovered
}

let discoveryRunning = false
let consecutiveFailures = 0
const BASE_INTERVAL = 60 * 1000
const MAX_INTERVAL = 30 * 60 * 1000 // 30 min cap

async function markConnectionAuthError(
  db: SlayzoneDb,
  connectionId: string,
  message: string
): Promise<void> {
  await db.prepare(
    `UPDATE integration_connections
     SET enabled = 0,
         auth_error = ?,
         auth_error_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(message, connectionId)
}

export function startDiscoveryPoller(db: SlayzoneDb, onChanged?: () => void): NodeJS.Timeout {
  void runDiscovery(db)
    .then((discovered) => {
      consecutiveFailures = 0
      if (discovered && discovered > 0) onChanged?.()
    })
    .catch((err) => {
      consecutiveFailures++
      console.error(
        'Initial discovery failed:',
        isNetworkError(err) ? `[offline] ${(err as Error).message}` : err
      )
    })
  return setInterval(() => {
    if (discoveryRunning) return
    // Exponential backoff: skip ticks when backing off
    const backoffInterval = Math.min(BASE_INTERVAL * Math.pow(2, consecutiveFailures), MAX_INTERVAL)
    if (consecutiveFailures > 0 && backoffInterval > BASE_INTERVAL) {
      // Only run every Nth tick based on backoff multiplier
      const ticksToSkip = Math.floor(backoffInterval / BASE_INTERVAL)
      if (Math.random() > 1 / ticksToSkip) return
    }
    discoveryRunning = true
    void runDiscovery(db)
      .then((discovered) => {
        consecutiveFailures = 0
        if (discovered && discovered > 0) onChanged?.()
      })
      .catch((err) => {
        consecutiveFailures++
        if (isNetworkError(err)) {
          // Log once, then suppress until success
          if (consecutiveFailures <= 2) {
            console.warn(`[discovery] offline, backing off (attempt ${consecutiveFailures})`)
          }
        } else {
          console.error('Discovery poll failed:', err)
        }
      })
      .finally(() => {
        discoveryRunning = false
      })
  }, BASE_INTERVAL)
}
