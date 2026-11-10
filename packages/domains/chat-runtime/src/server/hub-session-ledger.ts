/**
 * The agent-session ledger, as the hub reaches it (robustness plan §9, P0).
 *
 * Which provider conversations a task's agents ran — and which one each tab resumes —
 * is data only the computer running those agents uses: their transcripts are on its
 * disk. So the ledger lives only there (`chat-runtime/server/session-ledger.ts`), and
 * the hub asks that computer (`chat.request` kind `ledger`). The hub keeps:
 *
 *  - **user intent**: `session_resets` and `session_deletions`, written by the hub (the
 *    sessions UI, `slay tasks reset-conversation`, a worktree change, a main-agent
 *    switch) and delivered to every computer of the task — an offline one when it
 *    connects. `session_intent_acks` names what each computer confirmed. A computer
 *    applies them before it answers anything about the task ({@link prepare}).
 *  - nothing else: no session rows, no resume ids, no proofs.
 *
 * Before any ledger read or spawn decision for a task on a computer, {@link prepare}
 * hands the computer what the hub still held of the task (`computer-data-handoff`),
 * then its undelivered intents, then finishes the task's one-time per-tab recovery
 * (v201) there. A computer that is not connected answers nothing: reads are
 * `null` (the UI shows "computer offline"), never a stale hub answer.
 *
 * @module chat-runtime/server/hub-session-ledger
 */
import type { SlayzoneDb } from '@slayzone/platform'
import type { ConversationOrigin } from '@slayzone/task-contracts'
import type { TaskSessionStore } from '@slayzone/terminal/runtime'
import { isBuiltinAgentId } from '@slayzone/terminal-contracts'
import type { LedgerTaskSessionRow, SessionIntents } from '../shared'

export interface ComputerSessionLedgerDeps {
  db: SlayzoneDb
  /** A `chat.request` to the computer (through the lifecycle barrier in production). */
  request(computerId: string, request: unknown): Promise<unknown>
  /** The computer a task's data belongs to now (`ComputerDataHandoff.target`), or null. */
  target(taskId: string): Promise<string | null>
  /** Whether that computer is connected and usable now. */
  usable(computerId: string): boolean
  /** Deliver what the hub still holds of the task there (`ComputerDataHandoff.flushTask`). */
  flushTask(taskId: string, computerId: string): Promise<void>
  /** Record that a computer holds sessions of a task (deletion and erasure reach it). */
  track(taskId: string, computerId: string): Promise<void>
  /** The task's one-time per-tab recovery, run against that computer (session-tab-recovery.ts). */
  recoverTabs?(taskId: string, computerId: string): Promise<void>
  /** A task's sessions changed (the sessions list refreshes). */
  onChanged?(taskId: string): void
}

/** The computer holding a task's sessions is not connected: nothing can be answered. */
export class SessionLedgerOfflineError extends Error {
  readonly code = 'computer-offline'
  constructor() {
    super('The computer holding this task’s sessions is offline.')
    this.name = 'SessionLedgerOfflineError'
  }
}

interface IntentRow {
  kind: 'reset' | 'deletion'
  id: string
  task_id: string
  mode: string
  tab_id: string | null
  except_chat: number | null
  conversation_id: string | null
  created_at: number
}

export function createComputerSessionLedger(deps: ComputerSessionLedgerDeps) {
  const { db } = deps
  /** One preparation per (task, computer) at a time. */
  const preparing = new Map<string, Promise<void>>()
  /** Pools reaped this hub process, per computer (see {@link onComputerConnected}). */
  const poolsReaped = new Set<string>()

  /** Which agent the user-defined modes named in `args` wrap (built-ins are their own). */
  async function modeAgents(args: unknown): Promise<Record<string, string | null> | undefined> {
    const mode =
      args && typeof args === 'object' && 'mode' in args && typeof args.mode === 'string'
        ? args.mode
        : null
    if (!mode || isBuiltinAgentId(mode)) return undefined
    const row = await db.get<{ type: string | null }>('SELECT type FROM agents WHERE id = ?', [
      mode
    ])
    return { [mode]: row?.type ?? null }
  }

  async function call<T>(computerId: string, op: string, args: object = {}): Promise<T> {
    const agents = await modeAgents(args)
    return (await deps.request(computerId, {
      kind: 'ledger',
      value: { op, args, ...(agents ? { modeAgents: agents } : {}) }
    })) as T
  }

  /** The task's session intents this computer has not confirmed yet. */
  async function pendingIntents(taskId: string, computerId: string): Promise<IntentRow[]> {
    return db.all<IntentRow>(
      `SELECT 'reset' AS kind, r.id, r.task_id, r.mode, r.tab_id, r.except_chat,
              NULL AS conversation_id, r.created_at
         FROM session_resets r
        WHERE r.task_id = ? AND NOT EXISTS (
          SELECT 1 FROM session_intent_acks a WHERE a.intent_id = r.id AND a.computer_id = ?)
       UNION ALL
       SELECT 'deletion', d.id, d.task_id, d.mode, NULL, NULL, d.conversation_id, d.created_at
         FROM session_deletions d
        WHERE d.task_id = ? AND NOT EXISTS (
          SELECT 1 FROM session_intent_acks a WHERE a.intent_id = d.id AND a.computer_id = ?)
       ORDER BY created_at`,
      [taskId, computerId, taskId, computerId]
    )
  }

  /** Deliver the task's unconfirmed intents to one computer; confirmed ones are acked. */
  async function deliverIntents(taskId: string, computerId: string): Promise<void> {
    const rows = await pendingIntents(taskId, computerId)
    if (!rows.length) return
    const intents: SessionIntents = { resets: [], deletions: [] }
    for (const r of rows) {
      if (r.kind === 'reset')
        intents.resets.push({
          id: r.id,
          taskId: r.task_id,
          mode: r.mode,
          tabId: r.tab_id,
          exceptChat: r.except_chat === 1,
          createdAt: r.created_at
        })
      else
        intents.deletions.push({
          id: r.id,
          taskId: r.task_id,
          mode: r.mode,
          conversationId: r.conversation_id!,
          createdAt: r.created_at
        })
    }
    await call(computerId, 'applySessionIntents', intents)
    await db.batchTxn(
      rows.map((r) => ({
        type: 'run' as const,
        sql: `INSERT OR IGNORE INTO session_intent_acks(intent_id, task_id, computer_id) VALUES(?,?,?)`,
        params: [r.id, taskId, computerId]
      }))
    )
    deps.onChanged?.(taskId)
  }

  /**
   * Make `computerId` ready to answer for `taskId`: the hub's remaining rows of the
   * task, then its unconfirmed intents, then its one-time tab recovery. Throws when
   * the computer could not take them — a resume must never be decided without them.
   */
  async function prepare(taskId: string, computerId: string): Promise<void> {
    const key = `${taskId}\u0000${computerId}`
    const running = preparing.get(key)
    if (running) return running
    const work = (async () => {
      await deps.flushTask(taskId, computerId)
      await deps.track(taskId, computerId)
      await deliverIntents(taskId, computerId)
      await deps.recoverTabs?.(taskId, computerId)
    })()
    preparing.set(key, work)
    try {
      await work
    } finally {
      if (preparing.get(key) === work) preparing.delete(key)
    }
  }

  /** The connected computer holding a task's sessions, prepared; null when offline. */
  async function forTask(taskId: string): Promise<string | null> {
    const computerId = await deps.target(taskId)
    if (computerId === null || !deps.usable(computerId)) return null
    await prepare(taskId, computerId)
    return computerId
  }

  /** Same, but offline is an error (a write the user asked for must not vanish). */
  async function requireTask(taskId: string): Promise<string> {
    const computerId = await forTask(taskId)
    if (!computerId) throw new SessionLedgerOfflineError()
    return computerId
  }

  /** The terminal runtime's seam (pty-manager, warm pool, chat data ops). */
  const store: TaskSessionStore = {
    async recordConversation(computerId, input) {
      if (!computerId) return
      const { legacyJsonField: _chatKey, ...row } = input
      await call(computerId, 'recordConversation', row)
      deps.onChanged?.(input.taskId)
    },
    async recordPendingSpawn(computerId, args) {
      if (!computerId) throw new Error('No computer holds this session')
      return call<string>(computerId, 'recordPendingSpawn', args)
    },
    async prunePendingSpawns(computerId, scope) {
      if (!computerId) return 0
      return call<number>(computerId, 'prunePendingSpawns', scope ?? {})
    },
    async bindSessionToTask(computerId, args) {
      if (!computerId) return false
      await deps.track(args.taskId, computerId)
      const bound = await call<boolean>(computerId, 'bindSessionToTask', args)
      if (bound) deps.onChanged?.(args.taskId)
      return bound
    },
    async recordSessionSpawn(computerId, input) {
      if (!computerId) return
      if (input.taskId) await deps.track(input.taskId, computerId)
      await call(computerId, 'recordSessionSpawn', input)
    },
    async markSessionDead(computerId, sessionId) {
      if (!computerId) return
      await call(computerId, 'markSessionDead', { sessionId })
    },
    async isHonoredConversation(computerId, taskId, mode, conversationId) {
      if (!computerId) return false
      await prepare(taskId, computerId)
      return call<boolean>(computerId, 'isHonoredConversation', { taskId, mode, conversationId })
    },
    async getCurrentConversationId(computerId, taskId, mode, tabId) {
      if (!computerId) return null
      await prepare(taskId, computerId)
      return call<string | null>(computerId, 'getCurrentConversationId', {
        taskId,
        mode,
        ...(tabId ? { tabId } : {})
      })
    }
  }

  return {
    store,
    call,
    prepare,
    forTask,
    requireTask,
    deliverIntents,

    /**
     * A computer (re)connected. Its undelivered intents go out, task by task (one
     * failing is retried on the next connect). The first connect in this hub
     * process also retires its pooled sessions: the hub's warm-pool registry is
     * empty after a hub start, and the pool reaper kills every untracked warm agent.
     */
    async onComputerConnected(computerId: string): Promise<void> {
      if (!poolsReaped.has(computerId)) {
        await call(computerId, 'retireDeadPool')
        poolsReaped.add(computerId)
      }
      const tasks = await db.all<{ task_id: string }>(
        `SELECT DISTINCT i.task_id FROM (
           SELECT id, task_id FROM session_resets UNION ALL SELECT id, task_id FROM session_deletions
         ) i
         JOIN chat_task_computers c ON c.task_id = i.task_id AND c.computer_id = ?
         WHERE NOT EXISTS (SELECT 1 FROM session_intent_acks a WHERE a.intent_id = i.id AND a.computer_id = ?)`,
        [computerId, computerId]
      )
      for (const { task_id } of tasks)
        await deliverIntents(task_id, computerId).catch(() => {
          /* retried on the next connect, and before any use of the task there */
        })
    },

    /**
     * Deliver a task's new intent now to every connected computer of the task
     * (best effort: an offline one gets it when it connects).
     */
    async publishIntents(taskId: string): Promise<void> {
      const computers = await db.all<{ computer_id: string }>(
        'SELECT computer_id FROM chat_task_computers WHERE task_id = ?',
        [taskId]
      )
      const target = await deps.target(taskId)
      const ids = new Set(computers.map((c) => c.computer_id))
      if (target) ids.add(target)
      for (const id of ids)
        if (deps.usable(id)) await deliverIntents(taskId, id).catch(() => undefined)
      deps.onChanged?.(taskId)
    },

    /** The sessions of (task, mode) as `tabId` sees them; null when the computer is offline. */
    async listTaskSessionRows(
      taskId: string,
      mode: string,
      tabId?: string
    ): Promise<{ computerId: string; rows: LedgerTaskSessionRow[] } | null> {
      const computerId = await forTask(taskId)
      if (!computerId) return null
      return {
        computerId,
        rows: await call<LedgerTaskSessionRow[]>(computerId, 'listTaskSessionRows', {
          taskId,
          mode,
          ...(tabId ? { tabId } : {})
        })
      }
    },

    /** Whether the user may delete the session (offline: an error). */
    async deletableSession(
      taskId: string,
      mode: string,
      conversationId: string
    ): Promise<'ok' | 'not-honored' | 'current'> {
      const computerId = await requireTask(taskId)
      return call(computerId, 'deletableSession', { taskId, mode, conversationId })
    },

    /** Modes with sessions in scope (for reporting a reset); null when offline. */
    async sessionModesInScope(taskId: string, tabId: string | null): Promise<string[] | null> {
      const computerId = await forTask(taskId)
      if (!computerId) return null
      return call<string[]>(computerId, 'sessionModesInScope', { taskId, tabId })
    },

    /** The resume candidates of a tab (the healer). */
    listResumeCandidates: (computerId: string, taskId: string, mode: string, tabId?: string) =>
      call<string[]>(computerId, 'listResumeCandidates', {
        taskId,
        mode,
        ...(tabId ? { tabId } : {})
      }),
    claimedByOtherTasks: async (computerId: string, taskId: string, conversationIds: string[]) =>
      new Set(await call<string[]>(computerId, 'claimedByOtherTasks', { taskId, conversationIds })),
    getConversationFirstSeenAt: (computerId: string, conversationId: string) =>
      call<number | null>(computerId, 'getConversationFirstSeenAt', { conversationId }),
    legacyConversationHistory: (computerId: string, taskId: string, mode: string) =>
      call<string[]>(computerId, 'legacyConversationHistory', { taskId, mode }),
    referencedConversationIds: async (computerId: string) =>
      new Set(await call<string[]>(computerId, 'referencedConversationIds')),

    /** An agent's SessionStart, recorded on the computer running it. */
    async recordHookConversation(
      computerId: string,
      args: {
        taskId: string
        mode: string
        sessionId: string
        source?: string
        spawnToken?: string
        ctxTabId?: string
      }
    ): Promise<{ origin: ConversationOrigin; tabId: string } | null> {
      await prepare(args.taskId, computerId)
      const result = await call<{ origin: ConversationOrigin; tabId: string } | null>(
        computerId,
        'recordHookConversation',
        args
      )
      if (result) deps.onChanged?.(args.taskId)
      return result
    },
    confirmSessionConversation: (
      computerId: string,
      args: { sessionId: string; observedConversationId: string }
    ) => call<ConversationOrigin | null>(computerId, 'confirmSessionConversation', args),
    markSessionFirstTurn: (computerId: string, conversationId: string) =>
      call<boolean>(computerId, 'markSessionFirstTurn', { conversationId }),
    /** The chat on that computer holding a provider session, or null (v208). */
    chatSessionOwner: (computerId: string, sessionId: string, mode: string) =>
      call<{ conversationId: string; taskId: string; tabId: string; mode: string } | null>(
        computerId,
        'chatSessionOwner',
        { sessionId, mode }
      ),
    sessionTasks: (computerId: string, conversationIds: string[]) =>
      call<Record<string, string>>(computerId, 'sessionTasks', { conversationIds }),
    listSharedSessionClaims: (computerId: string) =>
      call<
        Array<{
          conversationId: string
          claims: Array<{ taskId: string; mode: string; firstClaimAt: number }>
        }>
      >(computerId, 'listSharedSessionClaims'),

    // One-time per-tab recovery (session-tab-recovery.ts)
    retagBackfilledSessionTab: (
      computerId: string,
      args: { taskId: string; mode: string; conversationId: string; tabId: string; upTo: number }
    ) => call<number>(computerId, 'retagBackfilledSessionTab', args),
    resumableSessionBefore: (
      computerId: string,
      args: { taskId: string; mode: string; tabId: string; at: number }
    ) => call<string | null>(computerId, 'resumableSessionBefore', args),
    freshSessionsOfTabBetween: (
      computerId: string,
      args: { taskId: string; mode: string; tabId: string; from: number; to: number }
    ) => call<string[]>(computerId, 'freshSessionsOfTabBetween', args),
    conversationMintedAt: (
      computerId: string,
      args: { taskId: string; mode: string; conversationId: string }
    ) => call<number | null>(computerId, 'conversationMintedAt', args)
  }
}

export type ComputerSessionLedger = ReturnType<typeof createComputerSessionLedger>

/**
 * The terminal runtime's ledger seam, bound late: the composition root wires the
 * pty runtime before the computer services exist. Every call goes to the ledger
 * `get` returns at that moment.
 */
export function lateSessionStore(get: () => ComputerSessionLedger): TaskSessionStore {
  return {
    recordConversation: (...args) => get().store.recordConversation(...args),
    recordPendingSpawn: (...args) => get().store.recordPendingSpawn(...args),
    prunePendingSpawns: (...args) => get().store.prunePendingSpawns(...args),
    bindSessionToTask: (...args) => get().store.bindSessionToTask(...args),
    recordSessionSpawn: (...args) => get().store.recordSessionSpawn(...args),
    markSessionDead: (...args) => get().store.markSessionDead(...args),
    isHonoredConversation: (...args) => get().store.isHonoredConversation(...args),
    getCurrentConversationId: (...args) => get().store.getCurrentConversationId(...args)
  }
}
