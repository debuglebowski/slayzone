import type { Database } from 'better-sqlite3'
import type { ColumnConfig, WorkflowCategory } from '@slayzone/projects/shared'
import { getDefaultStatus, resolveColumns } from '@slayzone/projects/shared'

/**
 * Named-transaction adapters for the projects domain. These are the conditional
 * read-modify-write operations that can't be shipped as a static `batchTxn` op
 * list because they read a row / MAX(...) and then write based on that value
 * inside the same atomic transaction. Registered into the worker's txn registry
 * via `@slayzone/projects/db`. Each function owns its own `db.transaction(...)`,
 * so the worker invokes it directly without re-wrapping.
 *
 * Pure: imports only better-sqlite3 + the worker-safe `@slayzone/projects/shared`
 * barrel (no electron / fs side-effects), so it is safe to pull into the worker
 * bundle (unlike the electron + fs-laden `/main` handlers module).
 *
 * Returns are kept structured-cloneable (raw rows / scalars): the IPC layer
 * parses rows via `parseProject` after the call.
 */

type Row = Record<string, unknown> | undefined

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { name: string } | undefined
  return Boolean(row)
}

// ── Project-group ordering primitives ────────────────────────────────────────
// The top-level sidebar list is the merge of UNGROUPED projects (group_id IS
// NULL) and all groups, sharing one `sort_order` integer space. A grouped
// project's `sort_order` is its position within its group instead. These pure
// helpers keep both scopes packed to a contiguous 0..n-1 after every mutation.

type TopEntry = { kind: 'project' | 'group'; id: string }

/** Current top-level entries (ungrouped projects + groups), ordered. */
function topLevelEntries(db: Database): TopEntry[] {
  const projects = db
    .prepare('SELECT id, sort_order FROM projects WHERE group_id IS NULL')
    .all() as Array<{ id: string; sort_order: number }>
  const groups = db
    .prepare('SELECT id, sort_order FROM project_groups')
    .all() as Array<{ id: string; sort_order: number }>
  const entries: Array<TopEntry & { sort_order: number }> = [
    ...projects.map((p) => ({ kind: 'project' as const, id: p.id, sort_order: p.sort_order })),
    ...groups.map((g) => ({ kind: 'group' as const, id: g.id, sort_order: g.sort_order }))
  ]
  entries.sort(
    (a, b) =>
      a.sort_order - b.sort_order || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
  )
  return entries.map(({ kind, id }) => ({ kind, id }))
}

/** Write 0..n-1 sort_order to the given ordered top-level entries. */
function writeTopLevelOrder(db: Database, entries: TopEntry[]): void {
  const updateProject = db.prepare(
    "UPDATE projects SET sort_order = ?, updated_at = datetime('now') WHERE id = ?"
  )
  const updateGroup = db.prepare(
    "UPDATE project_groups SET sort_order = ?, updated_at = datetime('now') WHERE id = ?"
  )
  entries.forEach((e, i) => {
    if (e.kind === 'project') updateProject.run(i, e.id)
    else updateGroup.run(i, e.id)
  })
}

/** Re-pack every top-level slot to a contiguous 0..n-1 by current order. */
function repackTopLevel(db: Database): void {
  writeTopLevelOrder(db, topLevelEntries(db))
}

/** Re-pack a group's members to a contiguous 0..n-1 by current order. */
function repackGroup(db: Database, groupId: string): void {
  const members = db
    .prepare('SELECT id FROM projects WHERE group_id = ? ORDER BY sort_order')
    .all(groupId) as Array<{ id: string }>
  const stmt = db.prepare(
    "UPDATE projects SET sort_order = ?, updated_at = datetime('now') WHERE id = ?"
  )
  members.forEach((m, i) => stmt.run(i, m.id))
}

/** Authoritative post-mutation snapshot the renderer replaces its state with. */
function groupsSnapshot(db: Database): { projects: Row[]; groups: Row[] } {
  return {
    projects: db.prepare('SELECT * FROM projects').all() as Row[],
    groups: db.prepare('SELECT * FROM project_groups ORDER BY sort_order').all() as Row[]
  }
}

export interface CreateGroupTxnParams {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}
export interface DeleteGroupTxnParams {
  id: string
}
export interface MoveProjectTxnParams {
  projectId: string
  /** Destination group, or null to move to the top level. */
  groupId: string | null
  /** Insert position within the destination scope. */
  targetIndex: number
}
export interface ReorderTopLevelTxnParams {
  /** Full ordered list of top-level slots (ungrouped projects + groups). */
  entries: TopEntry[]
}
export interface ReorderWithinTxnParams {
  groupId: string
  /** Full ordered list of the group's member project ids. */
  projectIds: string[]
}
export interface CreateWithTxnParams {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** Members in their intended within-group order (Discord: drop target first). */
  projectIds: string[]
}

type GroupsSnapshot = { projects: Row[]; groups: Row[] }

function remapUnknownTaskStatuses(
  db: Database,
  projectId: string,
  columnsConfig: ColumnConfig[] | null
): void {
  const resolvedColumns = resolveColumns(columnsConfig)
  const knownStatuses = new Set(resolvedColumns.map((column) => column.id))
  const fallbackStatus = getDefaultStatus(columnsConfig)
  const tasks = db
    .prepare('SELECT id, status FROM tasks WHERE project_id = ?')
    .all(projectId) as Array<{
    id: string
    status: string
  }>
  const updateTaskStatus = db.prepare(
    "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?"
  )

  for (const task of tasks) {
    if (!knownStatuses.has(task.status)) {
      updateTaskStatus.run(fallbackStatus, task.id)
    }
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
  return candidates[category].find((stateType) => availableStateTypes.has(stateType)) ?? null
}

function reconcileLinearStateMappingsForProject(
  db: Database,
  projectId: string,
  columnsConfig: ColumnConfig[] | null
): void {
  if (
    !tableExists(db, 'integration_project_mappings') ||
    !tableExists(db, 'integration_state_mappings')
  ) {
    return
  }

  const mappings = db
    .prepare(`
      SELECT id
      FROM integration_project_mappings
      WHERE provider = 'linear' AND project_id = ?
    `)
    .all(projectId) as Array<{ id: string }>

  if (mappings.length === 0) return

  const resolvedColumns = resolveColumns(columnsConfig)
  const listStateMappings = db.prepare(`
    SELECT state_id, state_type
    FROM integration_state_mappings
    WHERE provider = 'linear' AND project_mapping_id = ?
    ORDER BY rowid ASC
  `)
  const deleteStateMappings = db.prepare(
    "DELETE FROM integration_state_mappings WHERE provider = 'linear' AND project_mapping_id = ?"
  )
  const insertStateMapping = db.prepare(`
    INSERT INTO integration_state_mappings (
      id, provider, project_mapping_id, local_status, state_id, state_type, created_at, updated_at
    ) VALUES (?, 'linear', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `)

  for (const mapping of mappings) {
    const existing = listStateMappings.all(mapping.id) as Array<{
      state_id: string
      state_type: string
    }>
    if (existing.length === 0) continue

    const stateIdByType = new Map<string, string>()
    for (const row of existing) {
      if (!stateIdByType.has(row.state_type)) {
        stateIdByType.set(row.state_type, row.state_id)
      }
    }
    const availableStateTypes = new Set(stateIdByType.keys())
    if (availableStateTypes.size === 0) continue

    const nextRows: Array<{ localStatus: string; stateId: string; stateType: string }> = []
    for (const column of resolvedColumns) {
      const stateType = getLinearStateTypeForCategory(column.category, availableStateTypes)
      if (!stateType) continue
      const stateId = stateIdByType.get(stateType)
      if (!stateId) continue
      nextRows.push({ localStatus: column.id, stateId, stateType })
    }

    if (nextRows.length === 0) continue

    deleteStateMappings.run(mapping.id)
    for (const row of nextRows) {
      insertStateMapping.run(
        crypto.randomUUID(),
        mapping.id,
        row.localStatus,
        row.stateId,
        row.stateType
      )
    }
  }
}

export interface CreateProjectTxnParams {
  id: string
  name: string
  color: string
  path: string | null
  columnsConfigJson: string | null
  createdAt: string
  updatedAt: string
}

export interface UpdateProjectTxnParams {
  id: string
  /** Pre-built `UPDATE projects SET ... WHERE id = ?` (caller computed the field list). */
  sql: string
  /** Params for `sql`, ending with the project id. */
  params: unknown[]
  /**
   * Present only when `columns_config` was part of the update — drives the
   * follow-up status remap + Linear reconciliation + stale-automation cleanup.
   * `undefined` means columns were untouched; `null` means cleared to defaults.
   */
  normalizedColumns?: ColumnConfig[] | null
}

export const projectsTxns = {
  // Reads MAX(sort_order)+1, then inserts at that order — conditional, so it
  // can't be a static op list. Returns the created row for `parseProject`.
  'projects:create': (db: Database, p: CreateProjectTxnParams): Row =>
    db.transaction(() => {
      // New projects are ungrouped → top-level position. The top-level slot
      // space is shared between ungrouped projects and groups, so the next
      // order is MAX over both (NOT MAX over all projects, which would include
      // in-group positions and collide). `project_groups` may not exist on a
      // DB migrated to a version below 144 — guard with a table check.
      const hasGroups = tableExists(db, 'project_groups')
      const { sort_order: nextOrder } = db
        .prepare(
          hasGroups
            ? `SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM (
                 SELECT sort_order FROM projects WHERE group_id IS NULL
                 UNION ALL SELECT sort_order FROM project_groups)`
            : 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM projects'
        )
        .get() as { sort_order: number }
      const stmt = db.prepare(`
        INSERT INTO projects (id, name, color, path, columns_config, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(p.id, p.name, p.color, p.path, p.columnsConfigJson, nextOrder, p.createdAt, p.updatedAt)
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) as Row
    })(),

  // UPDATE projects, then (when columns changed) remap unknown task statuses,
  // reconcile Linear state mappings, and clear stale automation config — all
  // read-modify-write, all atomic. Returns the updated row for `parseProject`.
  'projects:update': (db: Database, p: UpdateProjectTxnParams): Row =>
    db.transaction(() => {
      db.prepare(p.sql).run(...p.params)
      if (p.normalizedColumns !== undefined) {
        remapUnknownTaskStatuses(db, p.id, p.normalizedColumns)
        reconcileLinearStateMappingsForProject(db, p.id, p.normalizedColumns)
        // Clear stale automation config references
        const cols = p.normalizedColumns
        if (cols) {
          const projRow = db
            .prepare('SELECT task_automation_config FROM projects WHERE id = ?')
            .get(p.id) as Record<string, unknown> | undefined
          if (projRow?.task_automation_config) {
            try {
              const cfg = JSON.parse(projRow.task_automation_config as string) as {
                on_terminal_active: string | null
                on_terminal_idle: string | null
              }
              const validIds = new Set(cols.map((c) => c.id))
              let changed = false
              if (cfg.on_terminal_active && !validIds.has(cfg.on_terminal_active)) {
                cfg.on_terminal_active = null
                changed = true
              }
              if (cfg.on_terminal_idle && !validIds.has(cfg.on_terminal_idle)) {
                cfg.on_terminal_idle = null
                changed = true
              }
              if (changed)
                db.prepare('UPDATE projects SET task_automation_config = ? WHERE id = ?').run(
                  JSON.stringify(cfg),
                  p.id
                )
            } catch {
              /* ignore parse errors */
            }
          }
        }
      }
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) as Row
    })(),

  // Insert a new group at the end of the top-level list (MAX top-level + 1).
  'project-groups:create': (db: Database, p: CreateGroupTxnParams): GroupsSnapshot =>
    db.transaction(() => {
      const { m } = db
        .prepare(
          `SELECT COALESCE(MAX(sort_order), -1) AS m FROM (
             SELECT sort_order FROM projects WHERE group_id IS NULL
             UNION ALL SELECT sort_order FROM project_groups)`
        )
        .get() as { m: number }
      // New groups start COLLAPSED (collapsed = 1) by default.
      db.prepare(
        `INSERT INTO project_groups (id, name, sort_order, collapsed, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      ).run(p.id, p.name, m + 1, p.createdAt, p.updatedAt)
      return groupsSnapshot(db)
    })(),

  // Delete a group; its members drop back to the top level, taking the group's
  // former slot (location-preserving) in their prior within-group order.
  'project-groups:delete': (db: Database, p: DeleteGroupTxnParams): GroupsSnapshot =>
    db.transaction(() => {
      const entries = topLevelEntries(db)
      const gi = entries.findIndex((e) => e.kind === 'group' && e.id === p.id)
      const members = db
        .prepare('SELECT id FROM projects WHERE group_id = ? ORDER BY sort_order')
        .all(p.id) as Array<{ id: string }>
      const memberEntries: TopEntry[] = members.map((m) => ({ kind: 'project', id: m.id }))
      if (gi >= 0) entries.splice(gi, 1, ...memberEntries)
      db.prepare('UPDATE projects SET group_id = NULL WHERE group_id = ?').run(p.id)
      db.prepare('DELETE FROM project_groups WHERE id = ?').run(p.id)
      writeTopLevelOrder(db, entries)
      return groupsSnapshot(db)
    })(),

  // Move a project into a group (or out to the top level) at a target index.
  // Re-packs both the destination scope and the scope the project left.
  'project-groups:moveProject': (db: Database, p: MoveProjectTxnParams): GroupsSnapshot =>
    db.transaction(() => {
      const proj = db.prepare('SELECT group_id FROM projects WHERE id = ?').get(p.projectId) as
        | { group_id: string | null }
        | undefined
      if (!proj) return groupsSnapshot(db)
      const oldGroup = proj.group_id ?? null
      const newGroup = p.groupId ?? null
      db.prepare("UPDATE projects SET group_id = ?, updated_at = datetime('now') WHERE id = ?").run(
        newGroup,
        p.projectId
      )
      if (newGroup === null) {
        // Destination = top level. `topLevelEntries` already includes the now-
        // ungrouped project; pull it out and re-insert at the target index.
        const entries = topLevelEntries(db).filter(
          (e) => !(e.kind === 'project' && e.id === p.projectId)
        )
        const idx = Math.max(0, Math.min(p.targetIndex, entries.length))
        entries.splice(idx, 0, { kind: 'project', id: p.projectId })
        writeTopLevelOrder(db, entries)
      } else {
        const members = (
          db
            .prepare('SELECT id FROM projects WHERE group_id = ? AND id <> ? ORDER BY sort_order')
            .all(newGroup, p.projectId) as Array<{ id: string }>
        ).map((m) => m.id)
        const idx = Math.max(0, Math.min(p.targetIndex, members.length))
        members.splice(idx, 0, p.projectId)
        const stmt = db.prepare(
          "UPDATE projects SET sort_order = ?, updated_at = datetime('now') WHERE id = ?"
        )
        members.forEach((id, i) => stmt.run(i, id))
      }
      // Re-pack the scope the project left (only when it actually changed scope).
      if (oldGroup !== newGroup) {
        if (oldGroup === null) repackTopLevel(db)
        else repackGroup(db, oldGroup)
      }
      return groupsSnapshot(db)
    })(),

  // Re-order the full top-level list (ungrouped projects + groups interleaved).
  'project-groups:reorderTopLevel': (db: Database, p: ReorderTopLevelTxnParams): GroupsSnapshot =>
    db.transaction(() => {
      writeTopLevelOrder(db, p.entries)
      return groupsSnapshot(db)
    })(),

  // Re-order projects within a single group.
  'project-groups:reorderWithin': (db: Database, p: ReorderWithinTxnParams): GroupsSnapshot =>
    db.transaction(() => {
      const stmt = db.prepare(
        "UPDATE projects SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND group_id = ?"
      )
      p.projectIds.forEach((id, i) => stmt.run(i, id, p.groupId))
      return groupsSnapshot(db)
    })(),

  // Create a folder from dropped projects (Discord's drag-onto gesture). The new
  // group takes the top-level slot where the first member used to sit; members
  // become its children in the given order; any group a member left re-packs.
  'project-groups:createWith': (db: Database, p: CreateWithTxnParams): GroupsSnapshot =>
    db.transaction(() => {
      const memberSet = new Set(p.projectIds)
      const before = topLevelEntries(db)
      const oldGroups = new Set(
        (
          db
            .prepare(
              `SELECT DISTINCT group_id FROM projects
               WHERE id IN (${p.projectIds.map(() => '?').join(',')}) AND group_id IS NOT NULL`
            )
            .all(...p.projectIds) as Array<{ group_id: string }>
        ).map((r) => r.group_id)
      )
      // New folder starts COLLAPSED (collapsed = 1) by default.
      db.prepare(
        `INSERT INTO project_groups (id, name, sort_order, collapsed, created_at, updated_at)
         VALUES (?, ?, 0, 1, ?, ?)`
      ).run(p.id, p.name, p.createdAt, p.updatedAt)
      const assign = db.prepare(
        "UPDATE projects SET group_id = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?"
      )
      p.projectIds.forEach((pid, i) => assign.run(p.id, i, pid))
      // Rebuild top level from the pre-insert snapshot: drop member projects and
      // place the new group where the first member used to sit.
      const newTop: TopEntry[] = []
      let inserted = false
      for (const e of before) {
        if (e.kind === 'project' && memberSet.has(e.id)) {
          if (!inserted) {
            newTop.push({ kind: 'group', id: p.id })
            inserted = true
          }
          continue
        }
        newTop.push(e)
      }
      if (!inserted) newTop.push({ kind: 'group', id: p.id })
      writeTopLevelOrder(db, newTop)
      for (const og of oldGroups) repackGroup(db, og)
      return groupsSnapshot(db)
    })()
}
