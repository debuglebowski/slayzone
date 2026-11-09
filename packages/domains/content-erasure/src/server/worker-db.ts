import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import { assertPathSafeId } from '@slayzone/platform/safe-path'
import type { ErasureScope } from '../shared'
import { SHARED_WORKTREE_SQL, addComputerTask } from './manifest'
import type { ErasureJob, ErasureManifest } from './manifest'
import { closeSync, existsSync, fsyncSync, openSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONTENT_ERASURE_SCHEMA } from '@slayzone/db-migrations/content-erasure-schema'

export function ensureErasureStorage(db: Database): void {
  db.exec(CONTENT_ERASURE_SCHEMA)
}

const rows = <T>(db: Database, sql: string, ...params: unknown[]) =>
  db.prepare(sql).all(...params) as T[]
const exists = (db: Database, table: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
const inJson = '(SELECT value FROM json_each(?))'
const unique = (values: string[]) => [...new Set(values)]
function durable<T>(db: Database, write: () => T): T {
  const previous = db.pragma('synchronous', { simple: true }) as number
  try {
    db.pragma('synchronous=FULL')
    return db.transaction(write).immediate()
  } finally {
    db.pragma(`synchronous=${previous}`)
  }
}
function syncDirectory(path: string) {
  if (process.platform === 'win32' || !existsSync(path)) return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readManifest(db: Database, scope: ErasureScope): ErasureManifest {
  const manifest: ErasureManifest = {
    scope,
    dependencies: [],
    ownerUserId: null,
    projectIds: [],
    taskIds: [],
    artifactIds: [],
    tabIds: [],
    conversationIds: [],
    blobHashes: [],
    artifactTasks: [],
    tabTasks: [],
    computers: [],
    worktrees: [],
    counts: { projects: 0, tasks: 0, artifacts: 0, versions: 0 }
  }
  const past: ErasureManifest[] = []
  if (scope.kind === 'user') {
    manifest.ownerUserId = scope.userId
    manifest.projectIds = rows<{ id: string }>(
      db,
      'SELECT id FROM projects WHERE owner_user_id=?',
      scope.userId
    ).map((r) => r.id)
    for (const row of rows<{ manifest: string }>(
      db,
      'SELECT manifest FROM content_erasure_jobs WHERE owner_user_id=?',
      scope.userId
    ))
      past.push(JSON.parse(row.manifest) as ErasureManifest)
    const oldProjects = unique(past.flatMap((m) => m.projectIds))
    const reassigned = new Set(
      rows<{ id: string }>(
        db,
        `SELECT id FROM projects WHERE id IN ${inJson} AND owner_user_id IS NOT ?`,
        JSON.stringify(oldProjects),
        scope.userId
      ).map((r) => r.id)
    )
    manifest.projectIds = unique([
      ...manifest.projectIds,
      ...oldProjects.filter((id) => !reassigned.has(id))
    ])
  } else if (scope.kind === 'projects') {
    manifest.projectIds = rows<{ id: string }>(
      db,
      `SELECT id FROM projects WHERE id IN ${inJson}`,
      JSON.stringify(scope.ids)
    ).map((r) => r.id)
  }
  if (scope.kind === 'tasks') {
    // Only the tasks the user selected. Their other subtasks survive, re-parented
    // at commit to their nearest surviving ancestor (reparentSurvivors).
    manifest.taskIds = rows<{ id: string }>(
      db,
      `SELECT id FROM tasks WHERE id IN ${inJson}`,
      JSON.stringify(scope.ids)
    ).map((r) => r.id)
  } else if (scope.kind !== 'artifacts') {
    manifest.taskIds = rows<{ id: string }>(
      db,
      `SELECT id FROM tasks WHERE project_id IN ${inJson}`,
      JSON.stringify(manifest.projectIds)
    ).map((r) => r.id)
  }
  if (scope.kind === 'user') {
    const oldTasks = unique(past.flatMap((m) => m.taskIds))
    const reassigned = new Set(
      rows<{ id: string }>(
        db,
        `SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id IN ${inJson} AND p.owner_user_id IS NOT ?`,
        JSON.stringify(oldTasks),
        scope.userId
      ).map((r) => r.id)
    )
    manifest.taskIds = unique([
      ...manifest.taskIds,
      ...oldTasks.filter((id) => !reassigned.has(id))
    ])
  }
  for (const id of [...manifest.taskIds, ...manifest.projectIds]) assertPathSafeId(id, 'erasureId')
  const tasks = JSON.stringify(manifest.taskIds)
  const artifacts =
    scope.kind === 'artifacts'
      ? rows<{ id: string; task_id: string }>(
          db,
          `SELECT id,task_id FROM task_artifacts WHERE id IN ${inJson}`,
          JSON.stringify(scope.ids)
        )
      : rows<{ id: string; task_id: string }>(
          db,
          `SELECT id,task_id FROM task_artifacts WHERE task_id IN ${inJson}`,
          tasks
        )
  manifest.artifactIds = artifacts.map((r) => r.id)
  // IDs identify every current/renamed original without retaining its title.
  for (const a of artifacts) {
    assertPathSafeId(a.id, 'artifactId')
    assertPathSafeId(a.task_id, 'taskId')
    manifest.artifactTasks.push({ taskId: a.task_id, artifactId: a.id })
  }
  const selectedTasks = new Set(manifest.taskIds)
  for (const old of past) {
    manifest.artifactTasks.push(...old.artifactTasks.filter((a) => selectedTasks.has(a.taskId)))
    manifest.tabTasks.push(...old.tabTasks.filter((t) => selectedTasks.has(t.taskId)))
    manifest.blobHashes.push(...old.blobHashes)
  }
  manifest.artifactIds = unique(manifest.artifactTasks.map((a) => a.artifactId))
  const artifactIds = JSON.stringify(manifest.artifactIds)
  const versions = rows<{ content_hash: string }>(
    db,
    `SELECT content_hash FROM artifact_versions WHERE artifact_id IN ${inJson}`,
    artifactIds
  )
  manifest.blobHashes = unique([...manifest.blobHashes, ...versions.map((r) => r.content_hash)])
  if (exists(db, 'artifact_blob_pins')) {
    const pins = rows<{ content_hash: string }>(
      db,
      `SELECT content_hash FROM artifact_blob_pins WHERE artifact_id IN ${inJson} OR task_id IN ${inJson}`,
      artifactIds,
      tasks
    )
    manifest.blobHashes = unique([...manifest.blobHashes, ...pins.map((r) => r.content_hash)])
  }
  if (manifest.taskIds.length) {
    // The computer holding each worktree: recorded where it was made, else the task's
    // or its project's computer. An unbound task's is the hub's default computer —
    // only the hub knows which are connected; it picks after planning (index.ts).
    const worktrees = rows<{
      id: string
      computer_id: string | null
      project_id: string
      owner_user_id: string | null
      worktree_path: string
    }>(
      db,
      `SELECT t.id,coalesce(t.worktree_computer_id,t.computer_id,p.default_computer_id) AS computer_id,
        t.project_id,p.owner_user_id,t.worktree_path
       FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
       WHERE t.id IN ${inJson} AND t.worktree_path IS NOT NULL`,
      tasks
    )
    for (const w of worktrees) {
      const shared = db
        .prepare(SHARED_WORKTREE_SQL)
        .get(w.worktree_path, tasks, w.computer_id, w.computer_id)
      if (shared) continue
      // Captured now: a project's erasure removes its placements before cleanup.
      const repoPaths = rows<{ computerId: string; path: string }>(
        db,
        'SELECT computer_id AS computerId,root_path AS path FROM project_placements WHERE project_id=? ORDER BY computer_id',
        w.project_id
      )
      manifest.worktrees.push({
        taskId: w.id,
        projectId: w.project_id,
        ownerUserId: w.owner_user_id,
        computerId: w.computer_id,
        repoPath: repoPaths.find((r) => r.computerId === w.computer_id)?.path ?? null,
        repoPaths,
        path: w.worktree_path,
        deleted: false
      })
    }
    manifest.tabTasks.push(
      ...rows<{ tabId: string; taskId: string }>(
        db,
        `SELECT id AS tabId,task_id AS taskId FROM terminal_tabs WHERE task_id IN ${inJson}`,
        tasks
      )
    )
    manifest.tabIds = unique(manifest.tabTasks.map((t) => t.tabId))
    for (const table of ['task_conversations', 'agent_sessions']) {
      manifest.conversationIds.push(
        ...rows<{ conversation_id: string }>(
          db,
          `SELECT conversation_id FROM ${table} WHERE task_id IN ${inJson} AND conversation_id IS NOT NULL`,
          tasks
        ).map((r) => r.conversation_id)
      )
    }
    const owners = rows<{
      id: string
      task_id: string
      tab_id: string
      computer_id: string | null
      source_computer_id: string | null
      destination_computer_id: string | null
    }>(
      db,
      `SELECT id,task_id,tab_id,computer_id,source_computer_id,destination_computer_id FROM chat_ownership WHERE task_id IN ${inJson}`,
      tasks
    )
    manifest.tabTasks.push(...owners.map((o) => ({ tabId: o.tab_id, taskId: o.task_id })))
    manifest.tabIds = unique([...manifest.tabIds, ...owners.map((r) => r.tab_id)])
    manifest.conversationIds.push(...owners.map((r) => r.id))
    const computers = rows<{ task_id: string; computer_id: string }>(
      db,
      `SELECT task_id,computer_id FROM chat_task_computers WHERE task_id IN ${inJson}
       UNION SELECT id,computer_id FROM tasks WHERE id IN ${inJson} AND computer_id IS NOT NULL
       UNION SELECT id,worktree_computer_id FROM tasks WHERE id IN ${inJson} AND worktree_computer_id IS NOT NULL`,
      tasks,
      tasks,
      tasks
    )
    for (const computerId of unique(computers.map((r) => r.computer_id))) {
      manifest.computers.push({
        id: computerId,
        taskIds: unique(computers.filter((r) => r.computer_id === computerId).map((r) => r.task_id))
      })
    }
    // A worktree's computer holds the task's data too (a project computer included).
    for (const w of manifest.worktrees)
      if (w.computerId) addComputerTask(manifest, w.computerId, w.taskId)
  }
  manifest.conversationIds = unique(manifest.conversationIds)
  if (!manifest.ownerUserId && exists(db, 'projects') && exists(db, 'tasks')) {
    const owners = rows<{ owner_user_id: string | null }>(
      db,
      `SELECT DISTINCT owner_user_id FROM projects WHERE id IN ${inJson}
       OR id IN (SELECT project_id FROM tasks WHERE id IN ${inJson})
       OR id IN (SELECT t.project_id FROM tasks t JOIN task_artifacts a ON a.task_id=t.id WHERE a.id IN ${inJson})`,
      JSON.stringify(manifest.projectIds),
      tasks,
      artifactIds
    )
    if (owners.length === 1) manifest.ownerUserId = owners[0].owner_user_id
  }
  manifest.counts = {
    projects: manifest.projectIds.length,
    tasks: manifest.taskIds.length,
    artifacts: manifest.artifactIds.length,
    versions: versions.length
  }
  return manifest
}

function prepare(
  db: Database,
  p: { id: string; scope: ErasureScope; actorUserId: string | null }
): ErasureManifest {
  return durable(db, () => {
    const m = readManifest(db, p.scope)
    const tasks = JSON.stringify(m.taskIds)
    const previous = rows<{ id: string; manifest: string; owner_user_id: string | null }>(
      db,
      "SELECT id,manifest,owner_user_id FROM content_erasure_jobs WHERE state='incomplete'"
    )
    m.dependencies = previous
      .filter((job) => {
        if (p.scope.kind === 'user') return job.owner_user_id === p.scope.userId
        const old = JSON.parse(job.manifest) as ErasureManifest
        return (
          old.taskIds.some(
            (id) => m.taskIds.includes(id) || (p.scope.kind === 'tasks' && p.scope.ids.includes(id))
          ) || old.artifactIds.some((id) => m.artifactIds.includes(id))
        )
      })
      .map((job) => job.id)
    db.prepare(`INSERT INTO content_erasure_jobs(id,scope,owner_user_id,actor_user_id,manifest)
      VALUES(?,?,?,?,?)`).run(
      p.id,
      JSON.stringify(p.scope),
      m.ownerUserId,
      p.actorUserId,
      JSON.stringify(m)
    )
    for (const taskId of m.taskIds) {
      db.prepare('INSERT OR IGNORE INTO content_erasure_tasks VALUES(?,?,?)').run(
        taskId,
        p.id,
        m.ownerUserId
      )
    }
    for (const tabId of m.tabIds)
      db.prepare('INSERT OR IGNORE INTO content_erasure_tabs VALUES(?,?)').run(tabId, p.id)
    for (const artifactId of m.artifactIds)
      db.prepare('INSERT OR IGNORE INTO content_erasure_artifacts VALUES(?,?)').run(
        artifactId,
        p.id
      )
    // Hide tasks immediately and durably pause native work. This is a deletion
    // fence, not recoverable Trash: no restore path may clear these intents.
    if (m.taskIds.length)
      db.prepare(`UPDATE tasks SET deleted_at=datetime('now') WHERE id IN ${inJson}`).run(tasks)
    return m
  })
}

// Delivery/acknowledgement metadata must outlive the deleted rows. Everything
// else with proven task/project/tab ownership is removed, including non-FK stores.
const DELIVERY_TABLES = new Set([
  'chat_task_lifecycle',
  'chat_task_computers',
  'chat_lifecycle_acks',
  'chat_ownership',
  'chat_deletion_targets',
  'chat_provider_bindings',
  'chat_tab_bindings',
  'chat_metadata_progress',
  'chat_bootstrap_reservations',
  'chat_unavailable_owners',
  'chat_folder_deletions',
  'chat_folder_deletion_acks',
  'content_erasure_jobs',
  'content_erasure_tasks',
  'content_erasure_computer_acks',
  'content_erasure_tabs',
  'projects',
  'tasks',
  'artifact_blob_pins'
])

/**
 * Every task that survives while its parent is erased moves to its nearest ancestor
 * that is not erased, else to top level. Deleting a task erases only the selected
 * tasks, so its unselected subtasks stay (a selected subtask goes with its parent).
 * A project or account erasure reaches here only for out-of-scope children (older or
 * imported databases can hold a cross-project/cross-owner link). The new parent must
 * be in the child's project, as the reparent validator requires; else top level.
 */
function reparentSurvivors(db: Database, erasedIds: string[]): void {
  const erased = JSON.stringify(erasedIds)
  const erasedSet = new Set(erasedIds)
  const parentOf = new Map(
    rows<{ id: string; parent_id: string | null }>(
      db,
      `SELECT id,parent_id FROM tasks WHERE id IN ${inJson}`,
      erased
    ).map((r) => [r.id, r.parent_id])
  )
  const survivors = rows<{ id: string; parent_id: string; project_id: string }>(
    db,
    `SELECT id,parent_id,project_id FROM tasks WHERE parent_id IN ${inJson} AND id NOT IN ${inJson}`,
    erased,
    erased
  )
  const projectOf = db.prepare('SELECT project_id FROM tasks WHERE id=?')
  const move = db.prepare("UPDATE tasks SET parent_id=?,updated_at=datetime('now') WHERE id=?")
  for (const child of survivors) {
    let ancestor: string | null = child.parent_id
    const seen = new Set<string>()
    // A legacy parent cycle ends the walk at top level.
    while (ancestor !== null && erasedSet.has(ancestor) && !seen.has(ancestor)) {
      seen.add(ancestor)
      ancestor = parentOf.get(ancestor) ?? null
    }
    if (ancestor !== null && erasedSet.has(ancestor)) ancestor = null
    if (ancestor !== null) {
      const row = projectOf.get(ancestor) as { project_id: string } | undefined
      if (row?.project_id !== child.project_id) ancestor = null
    }
    move.run(ancestor, child.id)
  }
}

function commit(db: Database, p: { id: string }): ErasureManifest {
  return durable(db, () => {
    const job = db.prepare('SELECT * FROM content_erasure_jobs WHERE id=?').get(p.id) as
      | ErasureJob
      | undefined
    if (!job) throw new Error('ERASURE_NOT_FOUND')
    const m = JSON.parse(job.manifest) as ErasureManifest
    if (job.db_erased) return m
    const tasks = JSON.stringify(m.taskIds),
      projects = JSON.stringify(m.projectIds),
      tabs = JSON.stringify(m.tabIds)
    // Preserve newer versions written by a request already in flight at planning.
    const latest = readManifest(db, m.scope)
    m.blobHashes = unique([...m.blobHashes, ...latest.blobHashes])
    m.artifactTasks = [...m.artifactTasks, ...latest.artifactTasks]
    m.counts.versions = Math.max(m.counts.versions, latest.counts.versions)
    db.pragma('secure_delete=ON')
    // Capture rowids before cascades can SET NULL on ownership columns. This is
    // inside one writer transaction; no unrelated row can reuse a captured rowid.
    const deletions: Array<{ table: string; rowids: number[] }> = []
    const schema = rows<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    for (const { name } of schema) {
      if (DELIVERY_TABLES.has(name)) continue
      const quoted = '"' + name.replaceAll('"', '""') + '"'
      const cols = new Set(
        rows<{ name: string }>(db, `PRAGMA table_info(${quoted})`).map((c) => c.name)
      )
      const conditions: string[] = [],
        params: unknown[] = []
      for (const [column, value] of [
        ['task_id', tasks],
        ['project_id', projects],
        ['tab_id', tabs]
      ] as const) {
        if (cols.has(column)) {
          conditions.push(`"${column}" IN ${inJson}`)
          params.push(value)
        }
      }
      if (conditions.length)
        deletions.push({
          table: quoted,
          rowids: rows<{ rowid: number }>(
            db,
            `SELECT rowid FROM ${quoted} WHERE ${conditions.join(' OR ')}`,
            ...params
          ).map((r) => r.rowid)
        })
    }
    if (exists(db, 'chat_workspace_changes') && exists(db, 'chat_workspace_diffs')) {
      const captures = rows<{ id: string }>(
        db,
        `SELECT id FROM chat_workspace_changes WHERE tab_id IN ${inJson}`,
        tabs
      ).map((r) => r.id)
      db.prepare(`DELETE FROM chat_workspace_diffs WHERE capture_id IN ${inJson}`).run(
        JSON.stringify(captures)
      )
    }
    // The task trigger creates durable tombstones and deletion targets before
    // content references disappear. Epochs remain available for offline devices.
    db.prepare('UPDATE content_erasure_jobs SET db_erased=1 WHERE id=?').run(p.id)
    // Before the delete: parent_id cascades, so a surviving subtask must move first.
    if (m.taskIds.length) reparentSurvivors(db, m.taskIds)
    if (m.taskIds.length)
      db.prepare(
        `UPDATE artifact_folders SET parent_id=NULL WHERE task_id NOT IN ${inJson} AND parent_id IN(SELECT id FROM artifact_folders WHERE task_id IN ${inJson})`
      ).run(tasks, tasks)
    if (m.taskIds.length) db.prepare(`DELETE FROM tasks WHERE id IN ${inJson}`).run(tasks)
    if (m.projectIds.length) db.prepare(`DELETE FROM projects WHERE id IN ${inJson}`).run(projects)
    for (const deletion of deletions) {
      db.prepare(`DELETE FROM ${deletion.table} WHERE rowid IN ${inJson}`).run(
        JSON.stringify(deletion.rowids)
      )
    }
    // Artifact-only deletion retains the surrounding task and its history.
    db.prepare(`DELETE FROM task_artifacts WHERE id IN ${inJson}`).run(
      JSON.stringify(m.artifactIds)
    )
    // Durable consumers (including backups and independently owned copies) own
    // their pins. Deleting a source artifact must never release another consumer.
    // This table has no task FK. Never erase a session still bound elsewhere.
    for (const conversation of m.conversationIds) {
      const shared = db
        .prepare(`SELECT 1 FROM task_conversations WHERE conversation_id=?
        UNION SELECT 1 FROM agent_sessions WHERE conversation_id=? LIMIT 1`)
        .get(conversation, conversation)
      if (!shared) db.prepare('DELETE FROM session_turns WHERE conversation_id=?').run(conversation)
    }
    if (m.scope.kind === 'user')
      db.prepare('DELETE FROM user_settings WHERE user_id=?').run(m.scope.userId)
    const removed = new Set([...m.taskIds, ...m.projectIds])
    function scrub(value: unknown): unknown {
      if (typeof value === 'string' && removed.has(value)) return undefined
      if (Array.isArray(value)) return value.map(scrub).filter((v) => v !== undefined)
      if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>
        if (
          (typeof object.taskId === 'string' && removed.has(object.taskId)) ||
          (typeof object.projectId === 'string' && removed.has(object.projectId))
        )
          return undefined
        return Object.fromEntries(
          Object.entries(object)
            .map(([key, v]) => [key, scrub(v)])
            .filter(([, v]) => v !== undefined)
        )
      }
      return value
    }
    for (const table of ['settings', 'user_settings']) {
      if (!exists(db, table)) continue
      for (const row of rows<{ rowid: number; value: string }>(
        db,
        `SELECT rowid,value FROM ${table} WHERE key='viewState'`
      )) {
        // A corrupt preference cannot be attributed to a deleted reference safely.
        // Keep it rather than deleting an unrelated user's state.
        try {
          const clean = JSON.stringify(scrub(JSON.parse(row.value)) ?? {})
          if (clean !== row.value)
            db.prepare(`UPDATE ${table} SET value=? WHERE rowid=?`).run(clean, row.rowid)
        } catch {
          /* An unrelated corrupt preference must not be deleted. */
        }
      }
    }
    for (const projectId of m.projectIds) {
      for (const table of ['settings', 'user_settings']) {
        db.prepare(`DELETE FROM ${table} WHERE key=?`).run(`commit_graph:project:${projectId}`)
        for (const prefix of ['ai_providers:', 'ai_instruction_variant:'])
          db.prepare(`DELETE FROM ${table} WHERE key=? OR substr(key,1,?)=?`).run(
            prefix + projectId,
            (prefix + projectId + ':').length,
            prefix + projectId + ':'
          )
      }
    }
    db.prepare('UPDATE content_erasure_jobs SET manifest=?,db_erased=1 WHERE id=?').run(
      JSON.stringify(m),
      p.id
    )
    return m
  })
}

export const contentErasureTxns = {
  'content-erasure:prepare': prepare,
  'content-erasure:commit': commit,
  'content-erasure:collect-blobs': (db: Database, p: { id: string; dataRoot: string }) => {
    // The hub's sole DB writer commits a real FULL-synchronous generation before
    // unlinking bytes. Earlier ordinary reference changes must survive a crash
    // too; flushing only after filesystem deletion would be too late.
    durable(db, () => {
      db.prepare('UPDATE content_erasure_jobs SET gc_generation=gc_generation+1 WHERE id=?').run(
        p.id
      )
    })
    return db
      .transaction(() => {
        const job = db.prepare('SELECT manifest FROM content_erasure_jobs WHERE id=?').get(p.id) as
          | { manifest: string }
          | undefined
        if (!job) throw new Error('ERASURE_NOT_FOUND')
        const m = JSON.parse(job.manifest) as ErasureManifest
        for (const table of ['artifact_blob_leases', 'blob_leases']) {
          if (
            exists(db, table) &&
            db.prepare(`SELECT 1 FROM ${table} WHERE expires_at>? LIMIT 1`).get(Date.now())
          )
            return { deferred: true, shared: 0, backup: 0 }
        }
        let shared = 0,
          backup = 0
        for (const hash of m.blobHashes) {
          if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_BLOB_HASH')
          const live = db
            .prepare('SELECT 1 FROM artifact_versions WHERE content_hash=? LIMIT 1')
            .get(hash)
          const pins = exists(db, 'artifact_blob_pins')
            ? rows<{ scope: string }>(
                db,
                'SELECT DISTINCT scope FROM artifact_blob_pins WHERE content_hash=?',
                hash
              )
            : []
          if (live || pins.some((pin) => pin.scope !== 'hub-backup')) {
            shared++
            continue
          }
          if (pins.length) {
            backup++
            continue
          }
          for (const file of [
            join(p.dataRoot, 'blobs', hash.slice(0, 2), hash.slice(2)),
            join(p.dataRoot, 'blobs', '.gc', hash)
          ]) {
            if (existsSync(file)) {
              rmSync(file, { force: true })
              syncDirectory(dirname(file))
            }
          }
          db.prepare('DELETE FROM artifact_blobs WHERE hash=?').run(hash)
        }
        return { deferred: false, shared, backup }
      })
      .immediate()
  },
  'content-erasure:compact': (db: Database, _p: Record<string, never>): void => {
    const previous = db.pragma('synchronous', { simple: true }) as number
    try {
      db.pragma('synchronous=FULL')
      db.pragma('secure_delete=ON')
      db.exec('VACUUM')
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
      if (checkpoint.some((row) => row.busy !== 0)) throw new Error('CHECKPOINT_BUSY')
    } finally {
      db.pragma(`synchronous=${previous}`)
    }
  }
}

type ContentErasureTxnSignatures = TxnSigOf<typeof contentErasureTxns>
declare module '@slayzone/platform' {
  interface TxnRegistry extends ContentErasureTxnSignatures {}
}
