import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RunnerCheckoutStatus, RunnerProjectCheckout, RunnerRecord } from '../shared/types'

/**
 * Fleet store: CRUD over the v149 fleet tables (`runners`,
 * `runner_project_checkouts`) plus the task/project runner-binding columns.
 * Dark in wave 1 — no tRPC surface yet; the integration wave wires callers.
 */

export interface RegisterRunnerInput {
  /** Caller-supplied id (e.g. minted at enrollment). Defaults to a fresh uuid. */
  id?: string
  name: string
  platform: string
  version: string
  /** Capability map, stored JSON-encoded in `capabilities_json`. */
  capabilities?: Record<string, unknown>
  /** Key id the runner authenticates with after enrollment. */
  authKeyId?: string | null
  /** Clock override for tests. */
  now?: number
}

export async function registerRunner(
  db: SlayzoneDb,
  input: RegisterRunnerInput
): Promise<RunnerRecord> {
  const now = input.now ?? Date.now()
  const record: RunnerRecord = {
    id: input.id ?? randomUUID(),
    name: input.name,
    platform: input.platform,
    version: input.version,
    capabilities_json: JSON.stringify(input.capabilities ?? {}),
    auth_key_id: input.authKeyId ?? null,
    last_seen_at: now,
    created_at: now,
    revoked_at: null
  }
  await db.run(
    `INSERT INTO runners
       (id, name, platform, version, capabilities_json, auth_key_id, last_seen_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      record.id,
      record.name,
      record.platform,
      record.version,
      record.capabilities_json,
      record.auth_key_id,
      record.last_seen_at,
      record.created_at
    ]
  )
  return record
}

export async function getRunner(db: SlayzoneDb, id: string): Promise<RunnerRecord | null> {
  return (
    (await db.get<RunnerRecord>(`SELECT * FROM runners WHERE id = ?`, [id])) ?? null
  )
}

/** Active runners by default; `includeRevoked` returns the full ledger. */
export async function listRunners(
  db: SlayzoneDb,
  opts: { includeRevoked?: boolean } = {}
): Promise<RunnerRecord[]> {
  return db.all<RunnerRecord>(
    opts.includeRevoked
      ? `SELECT * FROM runners ORDER BY created_at ASC, id ASC`
      : `SELECT * FROM runners WHERE revoked_at IS NULL ORDER BY created_at ASC, id ASC`
  )
}

/** Heartbeat marker. Monotonic — never moves `last_seen_at` backwards. */
export async function touchRunnerLastSeen(
  db: SlayzoneDb,
  id: string,
  at: number = Date.now()
): Promise<void> {
  await db.run(
    `UPDATE runners SET last_seen_at = ?
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    [at, id, at]
  )
}

/** Idempotent — the first revocation time wins. */
export async function revokeRunner(
  db: SlayzoneDb,
  id: string,
  at: number = Date.now()
): Promise<void> {
  await db.run(`UPDATE runners SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [at, id])
}

// --- runner_project_checkouts ------------------------------------------------

export interface UpsertRunnerCheckoutInput {
  runnerId: string
  projectId: string
  rootPath: string
  status: RunnerCheckoutStatus
  /** Clock override for tests. */
  now?: number
}

export async function upsertRunnerCheckout(
  db: SlayzoneDb,
  input: UpsertRunnerCheckoutInput
): Promise<void> {
  await db.run(
    `INSERT INTO runner_project_checkouts (runner_id, project_id, root_path, status, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(runner_id, project_id) DO UPDATE SET
       root_path = excluded.root_path,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    [input.runnerId, input.projectId, input.rootPath, input.status, input.now ?? Date.now()]
  )
}

export async function getRunnerCheckout(
  db: SlayzoneDb,
  runnerId: string,
  projectId: string
): Promise<RunnerProjectCheckout | null> {
  return (
    (await db.get<RunnerProjectCheckout>(
      `SELECT * FROM runner_project_checkouts WHERE runner_id = ? AND project_id = ?`,
      [runnerId, projectId]
    )) ?? null
  )
}

export async function listCheckoutsForRunner(
  db: SlayzoneDb,
  runnerId: string
): Promise<RunnerProjectCheckout[]> {
  return db.all<RunnerProjectCheckout>(
    `SELECT * FROM runner_project_checkouts WHERE runner_id = ? ORDER BY project_id ASC`,
    [runnerId]
  )
}

export async function listCheckoutsForProject(
  db: SlayzoneDb,
  projectId: string
): Promise<RunnerProjectCheckout[]> {
  return db.all<RunnerProjectCheckout>(
    `SELECT * FROM runner_project_checkouts WHERE project_id = ? ORDER BY runner_id ASC`,
    [projectId]
  )
}

// --- task/project runner binding ----------------------------------------------

/** `null` = inherit the project default (`projects.default_runner_id`). */
export async function setTaskRunner(
  db: SlayzoneDb,
  taskId: string,
  runnerId: string | null
): Promise<void> {
  await db.run(`UPDATE tasks SET runner_id = ? WHERE id = ?`, [runnerId, taskId])
}

/** `null` = local/first runner. */
export async function setProjectDefaultRunner(
  db: SlayzoneDb,
  projectId: string,
  runnerId: string | null
): Promise<void> {
  await db.run(`UPDATE projects SET default_runner_id = ? WHERE id = ?`, [runnerId, projectId])
}

/**
 * Effective runner for a task: the task's explicit `runner_id`, else its
 * project's `default_runner_id`, else `null` (= local/first runner).
 */
export async function resolveTaskRunnerId(db: SlayzoneDb, taskId: string): Promise<string | null> {
  const row = await db.get<{ runner_id: string | null }>(
    `SELECT COALESCE(t.runner_id, p.default_runner_id) AS runner_id
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.id = ?`,
    [taskId]
  )
  return row?.runner_id ?? null
}
