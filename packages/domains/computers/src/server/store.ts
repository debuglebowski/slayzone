import { createHash, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ComputerRecord } from '../shared/types'
import { listVisibleComputerIds, type ComputerViewer } from './visibility'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '../shared'

/**
 * Computer store: CRUD over the v149 computer tables (`computers`,
 * `project_placements`) plus the task/project computer-binding columns.
 * Dark in wave 1 — no tRPC surface yet; the integration wave wires callers.
 */

export interface RegisterComputerInput {
  /** Caller-supplied id (e.g. minted at enrollment). Defaults to a fresh uuid. */
  id?: string
  name: string
  platform: string
  version: string
  /** Capability map, stored JSON-encoded in `capabilities_json`. */
  capabilities?: Record<string, unknown>
  /** Key id the computer authenticates with after enrollment. */
  authKeyId?: string | null
  /** Clock override for tests. */
  now?: number
}

export async function registerComputer(
  db: SlayzoneDb,
  input: RegisterComputerInput
): Promise<ComputerRecord> {
  const now = input.now ?? Date.now()
  const record: ComputerRecord = {
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
    `INSERT INTO computers
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
 * Deterministic computerId for a co-located ("local") computer (Wave3.5-D5). Derived
 * purely from a stable identity string (the computer's name, e.g. `local-computer`),
 * so the SAME local computer always resolves to the SAME id — which lets
 * enrollment UPSERT one row rather than INSERT a fresh random-id row per boot.
 * This is the identity-based dedup that keeps at most ONE local computer: it is
 * idempotent by construction, more robust than any status/connection-based
 * reaping (a disconnected REMOTE computer is a legitimate sleeping laptop and is
 * NEVER touched — remote computers keep their random uuids from `registerComputer`).
 *
 * `local-computer:` is namespaced into the hash so a real remote computer that
 * happens to share the name can never collide onto a local id.
 */
export function deterministicLocalComputerId(name: string): string {
  const hex = createHash('sha256').update(`local-computer:${name}`, 'utf8').digest('hex')
  // Format as a uuid-v4-shaped string (8-4-4-4-12) so it is indistinguishable in
  // shape from `randomUUID()` ids everywhere downstream (api-key metadata, task
  // bindings, join_tokens.computer_id) — it is just a STABLE one for this name.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-')
}

/**
 * Enroll UPSERT for the LOCAL computer (Wave3.5-D5). Unlike `registerComputer` (a
 * plain INSERT for remote computers with fresh uuids), this writes at a
 * caller-supplied DETERMINISTIC id (`deterministicLocalComputerId`) so a re-enroll
 * of the same local computer REPLACES its own row instead of accumulating an
 * orphan every boot. `created_at` is preserved on conflict (the row's original
 * birth), while identity/heartbeat/auth fields refresh; `revoked_at` is cleared
 * so a re-enroll un-revokes the local computer (the operator asked for it back).
 */
export async function registerOrReplaceComputer(
  db: SlayzoneDb,
  input: RegisterComputerInput & { id: string }
): Promise<ComputerRecord> {
  const now = input.now ?? Date.now()
  const capabilities_json = JSON.stringify(input.capabilities ?? {})
  const auth_key_id = input.authKeyId ?? null
  await db.run(
    `INSERT INTO computers
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
  const row = await getComputer(db, input.id)
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
 * One-time cleanup for the historical duplicate-local-computer bug (Wave3.5-D5):
 * collapse every OTHER computer row sharing the local computer's `name` onto the
 * canonical `keepComputerId`. Scoped EXACTLY to the local identity:
 *   - matches ONLY by `name` (the local computer's name) — a REMOTE computer with a
 *     different name is never matched, so a disconnected/sleeping remote laptop
 *     is never touched.
 *   - never consults connection status — at boot nothing is connected, and a
 *     disconnected remote computer is legitimate; this reaps by IDENTITY only.
 *
 * Because `tasks.computer_id` / `projects.default_computer_id` are plain TEXT with no
 * FK (nothing repoints or nulls them on delete), a bare DELETE of the orphan rows
 * would leave any task/project bound to an old local id DANGLING —
 * `resolveTaskComputerId` would then return a dead id and the routing pty backend
 * would forward the spawn to a nonexistent computer with NO local fallback. So this
 * runs the RE-POINT + DELETE in a SINGLE transaction: every task/project pointing
 * at a soon-to-be-deleted local id is first repointed to `keepComputerId`, then the
 * orphan rows are removed. The binding follows the collapse.
 *
 * Guarded so the STEADY state (no duplicates) issues NO writes at all — the
 * common per-enroll path stays read-only. Returns the number of computer rows
 * removed (0 once collapsed). Runs inside the local-enroll path only — never
 * against a remote enroll.
 */
export async function retireStaleLocalComputers(
  db: SlayzoneDb,
  opts: { name: string; keepComputerId: string }
): Promise<number> {
  // Read-only probe first: the common steady-state path has no duplicates, so
  // avoid opening a write transaction (and the repoint/delete churn) every enroll.
  const stale = await db.all<{ id: string }>(
    `SELECT id FROM computers WHERE name = ? AND id <> ?`,
    [opts.name, opts.keepComputerId]
  )
  if (stale.length === 0) return 0

  const staleIds = stale.map((r) => r.id)
  const placeholders = staleIds.map(() => '?').join(', ')
  // Atomic collapse: repoint task + project bindings off the orphan ids onto the
  // survivor, THEN delete the orphan computer rows — one transaction so a task can
  // never observe a dangling computer_id mid-collapse.
  const results = (await db.batchTxn([
    {
      type: 'run',
      sql: `UPDATE tasks SET computer_id = ? WHERE computer_id IN (${placeholders})`,
      params: [opts.keepComputerId, ...staleIds]
    },
    {
      type: 'run',
      sql: `UPDATE projects SET default_computer_id = ? WHERE default_computer_id IN (${placeholders})`,
      params: [opts.keepComputerId, ...staleIds]
    },
    {
      type: 'run',
      sql: `DELETE FROM computers WHERE id IN (${placeholders})`,
      params: staleIds
    }
  ])) as Array<{ changes: number }>
  // The DELETE is the last op; its `changes` is the number of computer rows removed.
  return results[results.length - 1]?.changes ?? staleIds.length
}

/**
 * Clear a revocation. Does NOT bring the computer back on its own.
 *
 * Revoking makes the computer's next `hello` fail with `needs-re-enrollment`; the
 * dialer treats that as fatal, exits 78, and the supervisor latches and stops
 * restarting. So by the time anyone un-revokes there is no process left to
 * re-dial — the credential survives (revoke only sets the column), but nothing is
 * holding it. Un-revoking is therefore half of a RE-INVITE: clear the flag, then
 * hand over a fresh join token.
 */
export async function unrevokeComputer(db: SlayzoneDb, id: string): Promise<void> {
  await db.run(`UPDATE computers SET revoked_at = NULL WHERE id = ?`, [id])
}

/**
 * Delete a computer and everything that pointed at it.
 *
 * Follows `retireStaleLocalComputers`' shape — one transaction, never a bare
 * DELETE — because these columns are plain TEXT with no foreign keys, so nothing
 * repoints or nulls them for us and a dangling `computer_id` resolves to a dead
 * machine at exec time.
 *
 * Two deliberate differences from retire: bindings are NULLed rather than
 * repointed (there is no survivor to repoint to), and placements and grants go
 * too — they describe a machine that no longer exists.
 */
export async function deleteComputer(db: SlayzoneDb, id: string): Promise<void> {
  await db.batchTxn([
    { type: 'run', sql: `UPDATE tasks SET computer_id = NULL WHERE computer_id = ?`, params: [id] },
    {
      type: 'run',
      sql: `UPDATE projects SET default_computer_id = NULL WHERE default_computer_id = ?`,
      params: [id]
    },
    { type: 'run', sql: `DELETE FROM project_placements WHERE computer_id = ?`, params: [id] },
    { type: 'run', sql: `DELETE FROM computer_grants WHERE computer_id = ?`, params: [id] },
    { type: 'run', sql: `DELETE FROM computers WHERE id = ?`, params: [id] }
  ])
}

export async function getComputer(db: SlayzoneDb, id: string): Promise<ComputerRecord | null> {
  return (await db.get<ComputerRecord>(`SELECT * FROM computers WHERE id = ?`, [id])) ?? null
}

/** Active computers by default; `includeRevoked` returns the full ledger. */
export async function listComputers(
  db: SlayzoneDb,
  opts: { includeRevoked?: boolean } = {}
): Promise<ComputerRecord[]> {
  return db.all<ComputerRecord>(
    opts.includeRevoked
      ? `SELECT * FROM computers ORDER BY created_at ASC, id ASC`
      : `SELECT * FROM computers WHERE revoked_at IS NULL ORDER BY created_at ASC, id ASC`
  )
}

/** Heartbeat marker. Monotonic — never moves `last_seen_at` backwards. */
export async function touchComputerLastSeen(
  db: SlayzoneDb,
  id: string,
  at: number = Date.now()
): Promise<void> {
  await db.run(
    `UPDATE computers SET last_seen_at = ?
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    [at, id, at]
  )
}

/** Idempotent — the first revocation time wins. */
export async function revokeComputer(
  db: SlayzoneDb,
  id: string,
  at: number = Date.now()
): Promise<void> {
  await db.run(`UPDATE computers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [at, id])
}

// --- task/project computer binding ----------------------------------------------

/** `null` = inherit the project default (`projects.default_computer_id`). */
export async function setTaskComputer(
  db: SlayzoneDb,
  taskId: string,
  computerId: string | null
): Promise<void> {
  await db.run(`UPDATE tasks SET computer_id = ? WHERE id = ?`, [computerId, taskId])
}

/** `null` = no explicit default; exec falls back to the connected default computer,
 *  else an in-process spawn. */
export async function setProjectDefaultComputer(
  db: SlayzoneDb,
  projectId: string,
  computerId: string | null
): Promise<void> {
  await db.run(`UPDATE projects SET default_computer_id = ? WHERE id = ?`, [computerId, projectId])
}

/**
 * The task's EXPLICIT computer binding: its own `computer_id`, else its project's
 * `default_computer_id`. `null` = nothing bound, which does NOT mean "run locally"
 * — see {@link resolveTaskComputerIdOrDefault}, which falls back to the connected
 * default computer. (Computers run the agents; there is no in-process spawn path.)
 *
 * Both columns are plain nullable TEXT with no default, so `null` is the state of
 * every install that has never opened project settings — which is why an
 * unbound task must resolve to a real computer rather than to "the hub".
 */
export async function resolveTaskComputerId(
  db: SlayzoneDb,
  taskId: string
): Promise<string | null> {
  // The task's own pin wins over the project default. `chat-data-ops.ts`
  // `resolveComputerId` MUST stay identical — divergence would route a chat agent
  // and a terminal agent for the SAME task to different computers.
  const row = await db.get<{ computer_id: string | null }>(
    `SELECT COALESCE(t.computer_id, p.default_computer_id) AS computer_id
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.id = ?`,
    [taskId]
  )
  return row?.computer_id ?? null
}

/** Record which SlayZone user a computer belongs to (set at enroll). */
export async function setComputerOwner(
  db: SlayzoneDb,
  computerId: string,
  ownerUserId: string | null
): Promise<void> {
  await db.run(`UPDATE computers SET owner_user_id = ? WHERE id = ?`, [ownerUserId, computerId])
}

/**
 * Effective computer for a task, including the implicit default.
 *
 * Resolution order:
 *   1. the task's explicit `computer_id`
 *   2. its project's `default_computer_id`
 *   3. the sole connected computer, if exactly one is connected
 *   4. the connected computer named {@link DEFAULT_LOCAL_COMPUTER_NAME} (the
 *      co-located one the app auto-enrolls)
 *   5. `null` — genuinely nowhere to run
 *
 * Steps 3-4 exist because the two binding columns default to NULL: without them,
 * removing the in-process fallback would strand every existing install with zero
 * runnable agents despite a healthy auto-enrolled computer sitting right there.
 * `null` from this function is a hard error at the exec seams, not a signal to
 * run on the hub.
 */
export async function resolveTaskComputerIdOrDefault(
  db: SlayzoneDb,
  taskId: string,
  listConnectedComputers: () => Array<{ computerId: string; name?: string }>,
  /** Whose view to auto-select within. Omitted = no filtering, which is correct
   *  for a supervised hub (one human, no identities) and wrong anywhere else:
   *  auto-selecting "the only connected computer" could otherwise land a task on
   *  a machine belonging to someone else entirely. */
  viewer?: ComputerViewer
): Promise<string | null> {
  const bound = await resolveTaskComputerId(db, taskId)
  if (bound !== null) return bound
  let connected = listConnectedComputers()
  if (viewer?.userId) {
    const visible = await listVisibleComputerIds(db, viewer)
    connected = connected.filter((c) => visible.has(c.computerId))
  }
  if (connected.length === 0) return null
  if (connected.length === 1) return connected[0].computerId
  const local = connected.find((r) => r.name === DEFAULT_LOCAL_COMPUTER_NAME)
  return local ? local.computerId : null
}
