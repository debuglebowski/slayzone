import { createHash, randomUUID } from 'node:crypto'
import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import type { ComputerRecord } from '../shared/types'
import { listVisibleComputerIds, type ComputerViewer } from './visibility'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '../shared'
import {
  COMPUTER_REPLACE_REFUSED,
  ComputerStateError,
  computerReplacesItselfError
} from './computer-state-errors'

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
    revoked_at: null,
    disabled_at: null
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
  const results = (await db.batchTxn(successionOps(staleIds, opts.keepComputerId))) as Array<{
    changes: number
  }>
  // The DELETE is the last op; its `changes` is the number of computer rows removed.
  return results[results.length - 1]?.changes ?? staleIds.length
}

/**
 * The same machine, enrolled again under `successorId`: everything that named the
 * `formerIds` rows moves to it, and the rows go. One transaction (`batchTxn`), the
 * DELETE of the computer rows last. Shared by the local-computer collapse
 * ({@link retireStaleLocalComputers}) and a user's {@link replaceComputer}.
 *
 * Bindings, worktrees and placements are repointed rather than nulled (there is a
 * survivor); grants go — they said who could use the former row, the successor keeps
 * its own. `tasks.computer_id` / `projects.default_computer_id` are plain TEXT with no
 * FK, so a bare DELETE would leave them dangling.
 */
function successionOps(formerIds: readonly string[], successorId: string): BatchOp[] {
  const placeholders = formerIds.map(() => '?').join(', ')
  const run = (sql: string, params: unknown[]): BatchOp => ({ type: 'run', sql, params })
  return [
    run(`UPDATE tasks SET computer_id = ? WHERE computer_id IN (${placeholders})`, [
      successorId,
      ...formerIds
    ]),
    // The same machine: the worktrees it made are the successor's.
    run(
      `UPDATE tasks SET worktree_computer_id = ? WHERE worktree_computer_id IN (${placeholders})`,
      [successorId, ...formerIds]
    ),
    run(
      `UPDATE projects SET default_computer_id = ? WHERE default_computer_id IN (${placeholders})`,
      [successorId, ...formerIds]
    ),
    // Folders follow too. `OR IGNORE` keeps the successor's own row where both hold
    // the project (it is the current one); the former's leftovers then go.
    run(
      `UPDATE OR IGNORE project_placements SET computer_id = ? WHERE computer_id IN (${placeholders})`,
      [successorId, ...formerIds]
    ),
    run(`DELETE FROM project_placements WHERE computer_id IN (${placeholders})`, [...formerIds]),
    run(`DELETE FROM computer_grants WHERE computer_id IN (${placeholders})`, [...formerIds]),
    // Chat bookkeeping names computers too; the chat domain repoints it onto the
    // successor from this record (applyComputerRetirements), whenever it next runs.
    // 're-enrolled' is what both callers mean: the same machine under a new id.
    run(
      `INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at)
        SELECT id,?,'re-enrolled',? FROM computers WHERE id IN (${placeholders})
        ON CONFLICT(computer_id) DO UPDATE SET successor_id=excluded.successor_id,reason=excluded.reason`,
      [successorId, Date.now(), ...formerIds]
    ),
    run(`DELETE FROM computers WHERE id IN (${placeholders})`, [...formerIds])
  ]
}

/**
 * Replace a computer with its successor: the user confirmed `successorId` is the same
 * machine as `computerId`, enrolled again under a new id (its credential was lost, so
 * the hub could not tell). Its work moves there ({@link successionOps}) and the former
 * row is deleted; the chat domain then repoints its chats (applyComputerRetirements),
 * and the successor's next recovery adopts the ones it holds.
 *
 * Refuses a replacement by itself, a missing computer and a revoked successor. Whether
 * the former may go now (it must not be connected; the desktop's own computer never
 * goes) is the caller's: only it knows the live connections.
 */
export async function replaceComputer(
  db: SlayzoneDb,
  opts: { computerId: string; successorId: string }
): Promise<void> {
  if (opts.computerId === opts.successorId) throw computerReplacesItselfError()
  const [former, successor] = await Promise.all([
    getComputer(db, opts.computerId),
    getComputer(db, opts.successorId)
  ])
  if (!former || !successor) throw new Error('no such computer, or you do not have access to it')
  if (successor.revoked_at !== null)
    throw new ComputerStateError(
      COMPUTER_REPLACE_REFUSED,
      `"${successor.name}" is revoked, so it cannot take over another computer's work.`
    )
  await db.batchTxn(successionOps([opts.computerId], opts.successorId))
  computerRemoved(opts.computerId)
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
/**
 * Told when a computer is deleted or revoked — by ANY caller (the tRPC router, REST,
 * a departing user's cleanup): it never reconnects, so whatever waited for it (a
 * process run it kept) can let go. One listener (the hub's), replaced on each set,
 * as `setComputerBindingChangedListener`; null clears it.
 */
export function setComputerRemovedListener(listener: ((computerId: string) => void) | null): void {
  removedListener = listener
}
let removedListener: ((computerId: string) => void) | null = null
function computerRemoved(id: string): void {
  try {
    removedListener?.(id)
  } catch {
    // The listener's failure is its own; the delete or revoke already happened.
  }
}

export async function deleteComputer(db: SlayzoneDb, id: string): Promise<void> {
  // `tasks.worktree_computer_id` is deliberately KEPT: it records where a worktree
  // is, and a computer with no row tells the Trash purge it is gone for good — NULL
  // would send the removal to whichever computer is the default instead.
  await db.batchTxn([
    { type: 'run', sql: `UPDATE tasks SET computer_id = NULL WHERE computer_id = ?`, params: [id] },
    {
      type: 'run',
      sql: `UPDATE projects SET default_computer_id = NULL WHERE default_computer_id = ?`,
      params: [id]
    },
    { type: 'run', sql: `DELETE FROM project_placements WHERE computer_id = ?`, params: [id] },
    { type: 'run', sql: `DELETE FROM computer_grants WHERE computer_id = ?`, params: [id] },
    // No survivor: the chat domain retires the work still addressed to it, with
    // this reason (applyComputerRetirements). Revoke records nothing: that work waits.
    {
      type: 'run',
      sql: `INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at)
        SELECT id,NULL,'deleted',? FROM computers WHERE id = ?
        ON CONFLICT(computer_id) DO UPDATE SET successor_id=NULL,reason='deleted'`,
      params: [Date.now(), id]
    },
    { type: 'run', sql: `DELETE FROM computers WHERE id = ?`, params: [id] }
  ])
  computerRemoved(id)
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

/** Refresh the running release on authenticated reconnect without re-enrollment. */
export async function setComputerVersion(
  db: SlayzoneDb,
  id: string,
  version: string
): Promise<void> {
  await db.run('UPDATE computers SET version = ? WHERE id = ?', [version, id])
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
  computerRemoved(id)
}

/**
 * Disable (`true`) or enable (`false`) a computer. A disabled computer stays enrolled
 * and connected but gets no new work (`computers.setDisabled`). Disabling an already
 * disabled computer keeps its first time, like {@link revokeComputer}.
 */
export async function setComputerDisabled(
  db: SlayzoneDb,
  id: string,
  disabled: boolean,
  at: number = Date.now()
): Promise<void> {
  if (disabled) {
    await db.run(`UPDATE computers SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`, [
      at,
      id
    ])
  } else {
    await db.run(`UPDATE computers SET disabled_at = NULL WHERE id = ?`, [id])
  }
}

/** Rename a computer. Its enroll name until now; a re-enroll of a remote computer
 *  makes a new row, so this name stays with this row. */
export async function renameComputer(db: SlayzoneDb, id: string, name: string): Promise<void> {
  await db.run(`UPDATE computers SET name = ? WHERE id = ?`, [name, id])
}

/** Ids of every disabled computer — what placement leaves out of its default picks. */
export async function listDisabledComputerIds(db: SlayzoneDb): Promise<Set<string>> {
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM computers WHERE disabled_at IS NOT NULL`
  )
  return new Set(rows.map((r) => r.id))
}

/** Whether a computer is disabled. False for one that does not exist. */
export async function isComputerDisabled(db: SlayzoneDb, id: string): Promise<boolean> {
  const row = await db.get<{ disabled_at: number | null }>(
    `SELECT disabled_at FROM computers WHERE id = ?`,
    [id]
  )
  return row?.disabled_at != null
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
 * THE answer to "which computer is this task's" (S5): the one resolver. The computers
 * store, chat-data-ops (session ledger, terminal start gate), the hub's data handoff,
 * the local-roots sync and the hub consistency checks all use it — divergence would
 * route a chat agent and a terminal agent of the SAME task to different computers,
 * or make the start gate ask a computer that does not hold the task's sessions.
 * `pnpm lint:task-computer` refuses a second copy.
 *
 *  1. while the task has a folder (worktree or base dir), the computer holding it
 *     (`worktree_computer_id`): the folder exists only there (robustness plan §9,
 *     Phase 7e). Not one removed for good (retired with no successor): its folders
 *     went with it;
 *  2. the task's own pin;
 *  3. its project's default.
 *
 * `null` = nothing bound, which does NOT mean "run locally" — see
 * {@link resolveTaskComputerIdOrDefault}, which falls back to the connected default
 * computer. Both binding columns are plain nullable TEXT with no default.
 *
 * An SQL EXPRESSION over the aliases `t` (tasks) and `p` (the task's project, joined
 * on `t.project_id`), for queries that resolve many tasks at once. NULL when `t` is
 * NULL (e.g. a LEFT JOIN that matched no task).
 */
export const TASK_COMPUTER_EXPR = `COALESCE(
    CASE WHEN (t.has_worktree = 1 OR t.has_base_dir = 1)
      AND NOT EXISTS (SELECT 1 FROM computer_retirements task_computer_r
                       WHERE task_computer_r.computer_id = t.worktree_computer_id
                         AND task_computer_r.successor_id IS NULL)
    THEN t.worktree_computer_id END,
    t.computer_id, p.default_computer_id)`

/** {@link TASK_COMPUTER_EXPR} for one task. One positional parameter: the task id. */
export const TASK_COMPUTER_SQL = `SELECT ${TASK_COMPUTER_EXPR} AS computer_id
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
  WHERE t.id = ?`

export async function resolveTaskComputerId(
  db: SlayzoneDb,
  taskId: string
): Promise<string | null> {
  const row = await db.get<{ computer_id: string | null }>(TASK_COMPUTER_SQL, [taskId])
  return row?.computer_id ?? null
}

/** A task's folder is on another computer than the one it would be pinned to. */
export class TaskFoldersElsewhereError extends Error {
  constructor(
    readonly taskId: string,
    readonly holderId: string,
    readonly holderName: string
  ) {
    super(
      `This task's folder is on ${holderName}, and its work runs there. Remove its worktree or base folder to move it to another computer.`
    )
    this.name = 'TaskFoldersElsewhereError'
  }
}

/**
 * Refuse pinning a task to `computerId` while its folder (worktree or base dir) is on
 * another computer that still exists: the folder exists only there, and its work runs
 * there whatever the pin says ({@link TASK_COMPUTER_SQL}). Unpinning (`null`) is fine.
 */
export async function assertTaskMovable(
  db: SlayzoneDb,
  taskId: string,
  computerId: string | null
): Promise<void> {
  if (computerId === null) return
  const row = await db.get<{ holder: string | null; name: string | null }>(
    `SELECT t.worktree_computer_id AS holder, c.name AS name FROM tasks t
       LEFT JOIN computers c ON c.id = t.worktree_computer_id
      WHERE t.id = ? AND (t.has_worktree = 1 OR t.has_base_dir = 1)
        AND NOT EXISTS (SELECT 1 FROM computer_retirements r
                         WHERE r.computer_id = t.worktree_computer_id AND r.successor_id IS NULL)`,
    [taskId]
  )
  if (!row?.holder || row.holder === computerId) return
  throw new TaskFoldersElsewhereError(taskId, row.holder, row.name ?? `computer ${row.holder}`)
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
 *   1-2. {@link resolveTaskComputerId} (its folder's holder, its pin, its project's default)
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

/** Durable high-water mark. Missing generation is accepted only before adoption. */
export async function acceptComputerGeneration(
  db: SlayzoneDb,
  id: string,
  generation?: number
): Promise<boolean> {
  if (generation === undefined) {
    const row = await db.get<{ connector_generation: number }>(
      'SELECT connector_generation FROM computer_runtime_state WHERE computer_id = ?',
      [id]
    )
    return !row || row.connector_generation === 0
  }
  if (!Number.isSafeInteger(generation) || generation < 1) return false
  const result = await db.run(
    `INSERT INTO computer_runtime_state(computer_id, connector_generation) VALUES (?, ?)
    ON CONFLICT(computer_id) DO UPDATE SET connector_generation = excluded.connector_generation
    WHERE computer_runtime_state.connector_generation <= excluded.connector_generation`,
    [id, generation]
  )
  return result.changes > 0
}
export async function saveComputerUpgradeStatus(
  db: SlayzoneDb,
  id: string,
  status: unknown
): Promise<void> {
  await db.run(
    `INSERT INTO computer_runtime_state(computer_id, upgrade_status_json, reported_at) VALUES (?, ?, ?)
    ON CONFLICT(computer_id) DO UPDATE SET upgrade_status_json = excluded.upgrade_status_json, reported_at = excluded.reported_at`,
    [id, JSON.stringify(status), Date.now()]
  )
}
export async function getComputerUpgradeStatuses(db: SlayzoneDb): Promise<Map<string, unknown>> {
  const rows = await db.all<{
    computer_id: string
    upgrade_status_json: string
    reported_at: number
  }>(
    'SELECT computer_id, upgrade_status_json, reported_at FROM computer_runtime_state WHERE upgrade_status_json IS NOT NULL'
  )
  return new Map(
    rows.map((row) => [
      row.computer_id,
      { ...JSON.parse(row.upgrade_status_json), reportedAt: row.reported_at }
    ])
  )
}
