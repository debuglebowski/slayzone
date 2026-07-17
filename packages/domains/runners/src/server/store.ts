import { createHash, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RunnerCheckoutStatus, RunnerProjectCheckout, RunnerRecord } from '../shared/types'

/**
 * Runner store: CRUD over the v149 runner tables (`runners`,
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

/**
 * Deterministic runnerId for a co-located ("local") runner (Wave3.5-D5). Derived
 * purely from a stable identity string (the runner's name, e.g. `local-runner`),
 * so the SAME local runner always resolves to the SAME id — which lets
 * enrollment UPSERT one row rather than INSERT a fresh random-id row per boot.
 * This is the identity-based dedup that keeps at most ONE local runner: it is
 * idempotent by construction, more robust than any status/connection-based
 * reaping (a disconnected REMOTE runner is a legitimate sleeping laptop and is
 * NEVER touched — remote runners keep their random uuids from `registerRunner`).
 *
 * `local-runner:` is namespaced into the hash so a real remote runner that
 * happens to share the name can never collide onto a local id.
 */
export function deterministicLocalRunnerId(name: string): string {
  const hex = createHash('sha256').update(`local-runner:${name}`, 'utf8').digest('hex')
  // Format as a uuid-v4-shaped string (8-4-4-4-12) so it is indistinguishable in
  // shape from `randomUUID()` ids everywhere downstream (api-key metadata, task
  // bindings, join_tokens.runner_id) — it is just a STABLE one for this name.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-')
}

/**
 * Enroll UPSERT for the LOCAL runner (Wave3.5-D5). Unlike `registerRunner` (a
 * plain INSERT for remote runners with fresh uuids), this writes at a
 * caller-supplied DETERMINISTIC id (`deterministicLocalRunnerId`) so a re-enroll
 * of the same local runner REPLACES its own row instead of accumulating an
 * orphan every boot. `created_at` is preserved on conflict (the row's original
 * birth), while identity/heartbeat/auth fields refresh; `revoked_at` is cleared
 * so a re-enroll un-revokes the local runner (the operator asked for it back).
 */
export async function registerOrReplaceRunner(
  db: SlayzoneDb,
  input: RegisterRunnerInput & { id: string }
): Promise<RunnerRecord> {
  const now = input.now ?? Date.now()
  const capabilities_json = JSON.stringify(input.capabilities ?? {})
  const auth_key_id = input.authKeyId ?? null
  await db.run(
    `INSERT INTO runners
       (id, name, platform, version, capabilities_json, auth_key_id, last_seen_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       platform = excluded.platform,
       version = excluded.version,
       capabilities_json = excluded.capabilities_json,
       auth_key_id = excluded.auth_key_id,
       last_seen_at = excluded.last_seen_at,
       revoked_at = NULL`,
    [input.id, input.name, input.platform, input.version, capabilities_json, auth_key_id, now, now]
  )
  // Re-read so the returned record reflects the persisted row (created_at may be
  // the original birth time, not `now`, on an UPSERT that hit an existing row).
  const row = await getRunner(db, input.id)
  return (
    row ?? {
      id: input.id,
      name: input.name,
      platform: input.platform,
      version: input.version,
      capabilities_json,
      auth_key_id,
      last_seen_at: now,
      created_at: now,
      revoked_at: null
    }
  )
}

/**
 * One-time cleanup for the historical duplicate-local-runner bug (Wave3.5-D5):
 * collapse every OTHER runner row sharing the local runner's `name` onto the
 * canonical `keepRunnerId`. Scoped EXACTLY to the local identity:
 *   - matches ONLY by `name` (the local runner's name) — a REMOTE runner with a
 *     different name is never matched, so a disconnected/sleeping remote laptop
 *     is never touched.
 *   - never consults connection status — at boot nothing is connected, and a
 *     disconnected remote runner is legitimate; this reaps by IDENTITY only.
 *
 * Because `tasks.runner_id` / `projects.default_runner_id` are plain TEXT with no
 * FK (nothing repoints or nulls them on delete), a bare DELETE of the orphan rows
 * would leave any task/project bound to an old local id DANGLING —
 * `resolveTaskRunnerId` would then return a dead id and the routing pty backend
 * would forward the spawn to a nonexistent runner with NO local fallback. So this
 * runs the RE-POINT + DELETE in a SINGLE transaction: every task/project pointing
 * at a soon-to-be-deleted local id is first repointed to `keepRunnerId`, then the
 * orphan rows are removed. The binding follows the collapse.
 *
 * Guarded so the STEADY state (no duplicates) issues NO writes at all — the
 * common per-enroll path stays read-only. Returns the number of runner rows
 * removed (0 once collapsed). Runs inside the local-enroll path only — never
 * against a remote enroll.
 */
export async function retireStaleLocalRunners(
  db: SlayzoneDb,
  opts: { name: string; keepRunnerId: string }
): Promise<number> {
  // Read-only probe first: the common steady-state path has no duplicates, so
  // avoid opening a write transaction (and the repoint/delete churn) every enroll.
  const stale = await db.all<{ id: string }>(`SELECT id FROM runners WHERE name = ? AND id <> ?`, [
    opts.name,
    opts.keepRunnerId
  ])
  if (stale.length === 0) return 0

  const staleIds = stale.map((r) => r.id)
  const placeholders = staleIds.map(() => '?').join(', ')
  // Atomic collapse: repoint task + project bindings off the orphan ids onto the
  // survivor, THEN delete the orphan runner rows — one transaction so a task can
  // never observe a dangling runner_id mid-collapse.
  const results = (await db.batchTxn([
    {
      type: 'run',
      sql: `UPDATE tasks SET runner_id = ? WHERE runner_id IN (${placeholders})`,
      params: [opts.keepRunnerId, ...staleIds]
    },
    {
      type: 'run',
      sql: `UPDATE projects SET default_runner_id = ? WHERE default_runner_id IN (${placeholders})`,
      params: [opts.keepRunnerId, ...staleIds]
    },
    {
      type: 'run',
      sql: `DELETE FROM runners WHERE id IN (${placeholders})`,
      params: staleIds
    }
  ])) as Array<{ changes: number }>
  // The DELETE is the last op; its `changes` is the number of runner rows removed.
  return results[results.length - 1]?.changes ?? staleIds.length
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
