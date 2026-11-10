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
 * - **Order.** The small kinds that decide work ({@link DECISIVE_HANDOFF_KINDS}: a
 *   task's paths, chat settings, session ledger) go first, for every task, before
 *   any task's prompt and turn history; within each phase, tasks open in a tab go
 *   first. A caller that needs only some kinds names them (a path read flushes only
 *   `task-path`), so it never waits for a task's whole history.
 * - **Isolation (P3).** Per task: one task the computer cannot take is recorded and
 *   the others are delivered; only an unreachable computer ends the pass. Per item: an
 *   invalid value (or a kind the computer does not know, a row the computer cannot
 *   apply, a staged payload the hub cannot parse) is quarantined on its own until
 *   its row changes; its task's other rows are delivered. A delivery that fails as a
 *   whole is recorded (Needs attention) and retried on its backoff: it never blocks
 *   the task's work ({@link flushTask}); only an unreachable computer does.
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

/** The handoff kind of a chat's settings (hub v205; chat-runtime `chatSettingsImport`). */
export const CHAT_SETTINGS_KIND = 'chat-settings'

/**
 * The kinds that decide whether and how a task's work starts (paths judge its
 * folders, settings its agent's permission mode and model, the ledger which session
 * resumes), in delivery order. Every other kind (prompt and turn history) is
 * delivered after these, for every task.
 */
export const DECISIVE_HANDOFF_KINDS: readonly string[] = [
  'task-path',
  CHAT_SETTINGS_KIND,
  'agent-session',
  'task-conversation',
  'session-turn',
  'legacy-conversation-history'
]
/** Delivery order of the history kinds (unknown kinds after them, by name). */
const HISTORY_KIND_ORDER: readonly string[] = ['agent-turn', 'agent-prompt']

const isDecisive = (kind: string) => DECISIVE_HANDOFF_KINDS.includes(kind)

function kindRank(kind: string): number {
  const decisive = DECISIVE_HANDOFF_KINDS.indexOf(kind)
  if (decisive !== -1) return decisive
  const history = HISTORY_KIND_ORDER.indexOf(kind)
  return DECISIVE_HANDOFF_KINDS.length + (history !== -1 ? history : HISTORY_KIND_ORDER.length)
}

/** The two delivery phases of a task; each backs off on its own after a failure. */
type Phase = 'decisive' | 'history'
const PHASES: readonly Phase[] = ['decisive', 'history']
const phaseOf = (kind: string): Phase => (isDecisive(kind) ? 'decisive' : 'history')
/** Fault key of one task's phase (the decisive one keeps the task id alone). */
const phaseKey = (taskId: string, phase: Phase) =>
  phase === 'decisive' ? taskId : `${taskId}:history`

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
   * Tasks open in a client's tab now: their rows go first on a connect. Default:
   * the task tabs of every saved tab layout (`viewState`).
   */
  openTasks?(): Promise<readonly string[]>
  log?(message: string, error: unknown): void
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

/** The task tabs of every saved tab layout (one per user with login, else one). */
export async function openTaskIds(db: SlayzoneDb): Promise<string[]> {
  const rows = await db.all<{ task_id: string }>(
    `SELECT DISTINCT json_extract(t.value,'$.taskId') AS task_id
       FROM (SELECT value FROM settings WHERE key='viewState'
             UNION ALL SELECT value FROM user_settings WHERE key='viewState') s,
            json_each(s.value,'$.tabs') t
      WHERE json_valid(s.value) AND json_type(s.value,'$.tabs')='array'
        AND json_extract(t.value,'$.type')='task'
        AND json_type(t.value,'$.taskId')='text'`
  )
  return rows.map((r) => r.task_id)
}

export function createComputerDataHandoff(deps: ComputerDataHandoffDeps) {
  const { db } = deps
  const log =
    deps.log ?? ((message, error) => console.warn(`[computer-data-handoff] ${message}`, error))
  const openTasks = deps.openTasks ?? (() => openTaskIds(db))
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

  /** A task's staged rows of `kinds` (default: all), in delivery order. */
  async function rowsOf(taskId: string, kinds?: readonly string[]): Promise<HandoffRow[]> {
    const rows = await db.all<HandoffRow>(
      `SELECT kind,item_key,payload FROM computer_data_handoff
        WHERE task_id=? ORDER BY kind, created_at, item_key`,
      [taskId]
    )
    const wanted = kinds ? rows.filter((row) => kinds.includes(row.kind)) : rows
    // Stable: within a kind, the rows keep their staging order.
    return wanted.sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
  }

  /** Quarantine one item the hub itself cannot send (its staged payload is not JSON). */
  async function quarantine(
    computerId: string,
    taskId: string,
    row: HandoffRow,
    error: unknown
  ): Promise<void> {
    log(`staged ${itemKey(row)} of ${taskId} is unreadable; quarantined`, error)
    await deps.ledger?.(computerId).record(
      {
        pass: HANDOFF_ITEM_PASS,
        itemKey: itemKey(row),
        taskId,
        kind: 'structural',
        fingerprint: fingerprint(row.payload),
        error: error instanceof Error ? error : new Error(String(error))
      },
      Date.now()
    )
  }

  /**
   * Deliver the deliverable rows of one task (of `kinds`, default all) to
   * `computerId`. Throws when a batch could not be delivered (the computer is
   * unreachable, or failed the batch). Rejected items are quarantined, not thrown.
   */
  async function deliverTask(
    taskId: string,
    computerId: string,
    kinds?: readonly string[]
  ): Promise<void> {
    const ledger = deps.ledger?.(computerId)
    const now = Date.now()
    const byKind = new Map<string, Array<{ row: HandoffRow; value: unknown }>>()
    const kindIsMine = new Map<string, boolean>()
    for (const row of await rowsOf(taskId, kinds)) {
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
      let value: unknown
      try {
        value = JSON.parse(row.payload) as unknown
      } catch (error) {
        // One torn row is its own fault: the task's other rows still go.
        await quarantine(computerId, taskId, row, error)
        continue
      }
      const list = byKind.get(row.kind) ?? []
      list.push({ row, value })
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
              items: batch.map(({ row, value }) => ({ key: row.item_key, taskId, value }))
            }
          })
        )
        const sentPayload = new Map(batch.map(({ row }) => [row.item_key, row.payload]))
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
     * First the decisive kinds of every task, then every task's history; in each
     * phase, tasks open in a tab first. One task failing is recorded (per phase) and
     * the others proceed; an unreachable computer ends the pass (rethrown).
     */
    async deliverTo(computerId: string): Promise<HandoffReport> {
      await dropOrphans()
      const staged = await db.all<{ task_id: string; kind: string }>(
        'SELECT DISTINCT task_id, kind FROM computer_data_handoff ORDER BY task_id, kind'
      )
      const byPhase: Record<Phase, string[]> = { decisive: [], history: [] }
      for (const { task_id, kind } of staged) {
        const list = byPhase[phaseOf(kind)]
        if (list.at(-1) !== task_id && (await targetOf(kind, task_id)) === computerId)
          list.push(task_id)
      }
      const open = new Map((await openTasks()).map((id, i) => [id, i]))
      const rank = (id: string) => open.get(id) ?? open.size
      const failed = new Set<string>()
      const attempted = new Set<string>()
      const ledger = deps.ledger?.(computerId)
      for (const phase of PHASES) {
        const tasks = [...byPhase[phase]].sort((a, b) => rank(a) - rank(b))
        const kinds = (kind: string) => phaseOf(kind) === phase
        const report = await forEachIsolated(
          tasks,
          {
            pass: HANDOFF_TASK_PASS,
            key: (taskId) => phaseKey(taskId, phase),
            taskId: (taskId) => taskId,
            ...(ledger ? { ledger } : {}),
            isFatal: deps.isUnreachable
          },
          (taskId) => {
            attempted.add(taskId)
            return serialize(taskId, async () =>
              deliverTask(
                taskId,
                computerId,
                (await rowsOf(taskId)).map((r) => r.kind).filter(kinds)
              )
            )
          }
        )
        for (const failure of report.failed) failed.add(failure.item)
      }
      return { delivered: [...attempted].filter((t) => !failed.has(t)).length, failed: failed.size }
    },

    /**
     * Work of `taskId` is about to start on `computerId`: deliver what the hub still
     * holds of the task there first (only `kinds`, when given). Throws only when the
     * computer cannot be reached (the caller's start fails and is retried) — an agent
     * never resumes without that data while it could be delivered. A delivery that
     * failed otherwise is recorded (Needs attention) and retried on its backoff: a
     * deterministic failure never blocks the task's work. Quarantined items do not
     * block either.
     */
    async flushTask(taskId: string, computerId: string, kinds?: readonly string[]): Promise<void> {
      const staged = await db.all<{ kind: string }>(
        'SELECT DISTINCT kind FROM computer_data_handoff WHERE task_id=?',
        [taskId]
      )
      const wanted = staged.map((r) => r.kind).filter((k) => !kinds || kinds.includes(k))
      if (wanted.length === 0) return
      const ledger = deps.ledger?.(computerId)
      for (const phase of PHASES) {
        const phaseKinds = wanted.filter((k) => phaseOf(k) === phase)
        if (phaseKinds.length === 0) continue
        const key = phaseKey(taskId, phase)
        // Backing off after a failure: the start does not wait for it again.
        if (ledger && !(await ledger.allows(HANDOFF_TASK_PASS, key, null, Date.now()))) continue
        try {
          await serialize(taskId, () => deliverTask(taskId, computerId, phaseKinds))
        } catch (error) {
          if (deps.isUnreachable(error)) throw error
          log(`delivery of ${taskId} to ${computerId} failed; its work goes on`, error)
          await ledger?.record(
            {
              pass: HANDOFF_TASK_PASS,
              itemKey: key,
              taskId,
              kind: 'transient',
              error: error instanceof Error ? error : new Error(String(error))
            },
            Date.now()
          )
          continue
        }
        // A whole phase delivered clears its fault; a partial one leaves it to its pass.
        if (!kinds) await ledger?.clear(HANDOFF_TASK_PASS, key)
      }
    }
  }
}

function itemKey(row: HandoffRow): string {
  return `${row.kind}:${row.item_key}`
}

export type ComputerDataHandoff = ReturnType<typeof createComputerDataHandoff>
