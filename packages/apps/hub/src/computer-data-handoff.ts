/**
 * Computer-only data handoff (robustness plan §9, P0).
 *
 * Data only the computer running a task's work uses is stored only on that computer.
 * What the hub still holds of it (rows a migration moved into
 * `computer_data_handoff`) is delivered ONCE to the computer owning the task, and a
 * row is forgotten only after that computer confirmed it (`data.import`). Nothing on
 * the hub reads these rows otherwise: the computer is the copy from then on.
 *
 * - **Where.** A task's data belongs to its active chat's computer, else the computer
 *   the task (or its project) is pinned to; a re-enrolled computer hands over to its
 *   successor, a removed one to nobody (the rows wait for a new placement). With
 *   neither, the hub's default placement for the task (`fallbackTarget`). With none
 *   at all, the rows wait. A kind may name its own computer (`kindTargets`): a
 *   task's paths go to the computer holding its worktree.
 * - **When.** On every (re)connect of a computer, for the tasks whose data it owns
 *   ({@link deliverTo}); and right before work of a task starts on a computer
 *   ({@link flushTask}), so an agent never resumes without data the hub still held.
 * - **Isolation (P3).** Per task: one task the computer cannot take is recorded and
 *   the others are delivered; only an unreachable computer ends the pass. Per item: an
 *   invalid value (or a kind the computer does not know) is quarantined on its own
 *   until its row changes; its task's other rows are delivered.
 * - **Idempotent.** A batch delivered twice (its acknowledgement lost) changes nothing
 *   on the computer, which keeps a newer local row over an older hub copy.
 * - **Erasure.** Rows are fenced like every task table and swept with their task.
 *   Rows of a task that no longer exists are dropped, never delivered.
 *
 * @module hub/computer-data-handoff
 */
import { createHash } from 'node:crypto'
import {
  DATA_IMPORT_MAX_ITEMS,
  type DataImportResult,
  dataImportResultSchema
} from '@slayzone/chat-runtime/shared'
import { TASK_COMPUTER_SQL } from '@slayzone/computers/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { type FaultLedger, forEachIsolated } from '@slayzone/platform/isolation'

/** Fault pass of one item the computer rejected (structural: retried only once changed). */
export const HANDOFF_ITEM_PASS = 'hub-data-handoff'
/** Fault pass of one task whose delivery failed (transient: retried with backoff). */
export const HANDOFF_TASK_PASS = 'hub-data-handoff-task'

/** Longest chain of re-enrollments followed to a live successor. */
const MAX_SUCCESSORS = 16

interface HandoffRow {
  kind: string
  item_key: string
  payload: string
}

export interface ComputerDataHandoffDeps {
  db: SlayzoneDb
  /** A `chat.request` to the computer (through the lifecycle barrier in production). */
  request(computerId: string, request: unknown): Promise<unknown>
  /**
   * Record that a computer holds data of a task, so the task's deletion and erasure
   * reach it (`chat_task_computers`). Default: insert the row.
   */
  track?(taskId: string, computerId: string): Promise<void>
  /** A kind's rows of a task reached `computerId` (applied or already newer there). */
  delivered?(kind: string, taskId: string, computerId: string): Promise<void>
  /** Where an unplaced task's work would run now (the hub's default placement), or null. */
  fallbackTarget?(taskId: string): Promise<string | null>
  /** Per computer: the hub's fault ledger (Needs attention). */
  ledger?(computerId: string): FaultLedger
  /** The computer cannot be reached: the pass ends (every later task would fail too). */
  isUnreachable(error: unknown): boolean
  /**
   * Kinds whose rows belong to another computer than the task's data (default
   * {@link target}): e.g. `task-path` goes to the computer holding the worktree. Given
   * the task's default target, answers the kind's computer, or null (it waits).
   */
  kindTargets?: Readonly<
    Record<
      string,
      (taskId: string, fallback: () => Promise<string | null>) => Promise<string | null>
    >
  >
}

export interface HandoffReport {
  /** Tasks whose every deliverable row reached the computer. */
  delivered: number
  /** Tasks that failed (recorded; retried with backoff). */
  failed: number
}

const fingerprint = (payload: string) => createHash('sha256').update(payload).digest('hex')

export function createComputerDataHandoff(deps: ComputerDataHandoffDeps) {
  const { db } = deps
  const track =
    deps.track ??
    (async (taskId: string, computerId: string) => {
      await db.run('INSERT OR IGNORE INTO chat_task_computers(task_id,computer_id) VALUES(?,?)', [
        taskId,
        computerId
      ])
    })
  /** One delivery per task at a time: a flush and a reconnect pass never interleave. */
  const chains = new Map<string, Promise<unknown>>()
  function serialize<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(taskId) ?? Promise.resolve()).then(work)
    // The chain itself never rejects: the caller gets `next`'s failure.
    const settled: Promise<unknown> = next.then(
      () => undefined,
      () => undefined
    )
    chains.set(taskId, settled)
    void settled.then(() => {
      if (chains.get(taskId) === settled) chains.delete(taskId)
    })
    return next
  }

  /** The computer a re-enrolled computer became; null when it was removed for good. */
  async function live(computerId: string | null): Promise<string | null> {
    let id = computerId
    for (let hops = 0; id !== null && hops < MAX_SUCCESSORS; hops++) {
      const retired = await db.get<{ successor_id: string | null }>(
        'SELECT successor_id FROM computer_retirements WHERE computer_id=?',
        [id]
      )
      if (!retired) return id
      id = retired.successor_id
    }
    return null
  }

  /** The computer a task's data belongs to now, or null (it waits). */
  async function target(taskId: string): Promise<string | null> {
    const chat = await db.get<{ computer_id: string }>(
      `SELECT computer_id FROM chat_ownership
        WHERE task_id=? AND state='active' AND computer_id IS NOT NULL
        ORDER BY epoch DESC LIMIT 1`,
      [taskId]
    )
    const pinned =
      chat?.computer_id ??
      (await db.get<{ computer_id: string | null }>(TASK_COMPUTER_SQL, [taskId]))?.computer_id ??
      null
    if (pinned !== null) return live(pinned)
    return (await deps.fallbackTarget?.(taskId)) ?? null
  }

  /** The computer one kind of a task's rows goes to now, or null (they wait). */
  async function targetOf(kind: string, taskId: string): Promise<string | null> {
    const special = deps.kindTargets && Object.hasOwn(deps.kindTargets, kind)
    if (!special) return target(taskId)
    return live(await deps.kindTargets![kind](taskId, () => target(taskId)))
  }

  async function rowsOf(taskId: string): Promise<HandoffRow[]> {
    return db.all<HandoffRow>(
      `SELECT kind,item_key,payload FROM computer_data_handoff
        WHERE task_id=? ORDER BY kind, created_at, item_key`,
      [taskId]
    )
  }

  /**
   * Deliver every deliverable row of one task to `computerId`. Throws when a batch
   * could not be delivered (the computer is unreachable, or failed the batch).
   * Rejected items are quarantined, not thrown.
   */
  async function deliverTask(taskId: string, computerId: string): Promise<void> {
    const ledger = deps.ledger?.(computerId)
    const now = Date.now()
    const byKind = new Map<string, HandoffRow[]>()
    const kindIsMine = new Map<string, boolean>()
    for (const row of await rowsOf(taskId)) {
      let mine = kindIsMine.get(row.kind)
      if (mine === undefined) {
        mine = (await targetOf(row.kind, taskId)) === computerId
        kindIsMine.set(row.kind, mine)
      }
      if (!mine) continue
      if (
        ledger &&
        !(await ledger.allows(HANDOFF_ITEM_PASS, itemKey(row), fingerprint(row.payload), now))
      )
        continue
      const list = byKind.get(row.kind) ?? []
      list.push(row)
      byKind.set(row.kind, list)
    }
    if (byKind.size === 0) return
    await track(taskId, computerId)
    for (const [kind, rows] of byKind) {
      for (let i = 0; i < rows.length; i += DATA_IMPORT_MAX_ITEMS) {
        const batch = rows.slice(i, i + DATA_IMPORT_MAX_ITEMS)
        const result: DataImportResult = dataImportResultSchema.parse(
          await deps.request(computerId, {
            kind: 'data.import',
            value: {
              kind,
              items: batch.map((row) => ({
                key: row.item_key,
                taskId,
                value: JSON.parse(row.payload) as unknown
              }))
            }
          })
        )
        const sentPayload = new Map(batch.map((row) => [row.item_key, row.payload]))
        // Forget exactly what was sent: a row rewritten meanwhile is delivered again.
        for (const key of [...result.applied, ...result.skipped]) {
          const payload = sentPayload.get(key)
          if (payload === undefined) continue
          await db.run(
            'DELETE FROM computer_data_handoff WHERE kind=? AND item_key=? AND payload=?',
            [kind, key, payload]
          )
          await ledger?.clear(HANDOFF_ITEM_PASS, `${kind}:${key}`)
        }
        if (result.applied.length + result.skipped.length > 0)
          await deps.delivered?.(kind, taskId, computerId)
        for (const rejected of result.rejected) {
          const payload = sentPayload.get(rejected.key)
          if (payload === undefined) continue
          await ledger?.record(
            {
              pass: HANDOFF_ITEM_PASS,
              itemKey: `${kind}:${rejected.key}`,
              taskId,
              kind: 'structural',
              fingerprint: fingerprint(payload),
              error: new Error(rejected.message)
            },
            Date.now()
          )
        }
      }
    }
  }

  /** Rows of tasks that no longer exist: nothing to deliver them to. */
  async function dropOrphans(): Promise<void> {
    await db.run(
      'DELETE FROM computer_data_handoff WHERE NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=computer_data_handoff.task_id)'
    )
  }

  return {
    target,
    targetOf,

    /**
     * A computer (re)connected: deliver the rows of every task whose data it owns.
     * One task failing is recorded and the others proceed; an unreachable computer
     * ends the pass (rethrown).
     */
    async deliverTo(computerId: string): Promise<HandoffReport> {
      await dropOrphans()
      const tasks = await db.all<{ task_id: string; kind: string }>(
        'SELECT DISTINCT task_id, kind FROM computer_data_handoff ORDER BY task_id, kind'
      )
      const mine: string[] = []
      for (const { task_id, kind } of tasks)
        if (mine.at(-1) !== task_id && (await targetOf(kind, task_id)) === computerId)
          mine.push(task_id)
      const report = await forEachIsolated(
        mine,
        {
          pass: HANDOFF_TASK_PASS,
          key: (taskId) => taskId,
          taskId: (taskId) => taskId,
          ...(deps.ledger ? { ledger: deps.ledger(computerId) } : {}),
          isFatal: deps.isUnreachable
        },
        (taskId) => serialize(taskId, () => deliverTask(taskId, computerId))
      )
      return { delivered: report.ok, failed: report.failed.length }
    },

    /**
     * Work of `taskId` is about to start on `computerId`: deliver what the hub still
     * holds of the task there first. Throws when it could not (the caller's start
     * fails and is retried) — an agent must never resume without that data.
     * Quarantined items do not block.
     */
    async flushTask(taskId: string, computerId: string): Promise<void> {
      const any = await db.get<{ one: number }>(
        'SELECT 1 AS one FROM computer_data_handoff WHERE task_id=? LIMIT 1',
        [taskId]
      )
      if (!any) return
      await serialize(taskId, () => deliverTask(taskId, computerId))
    }
  }
}

function itemKey(row: HandoffRow): string {
  return `${row.kind}:${row.item_key}`
}

export type ComputerDataHandoff = ReturnType<typeof createComputerDataHandoff>
