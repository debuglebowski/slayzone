/**
 * The computer's agent-session ledger service: answers the hub's `ledger` requests
 * from this computer's chat store (robustness plan §9, P0). The ledger rules are in
 * `session-ledger.ts`; this module only validates each request, runs it against the
 * store, and reports which tasks' sessions changed.
 *
 * @module chat-runtime/server/session-ledger-service
 */
import type { BatchOp, RunResult, SlayzoneDb } from '@slayzone/platform'
import {
  type LedgerAgentSessionRow,
  type LedgerConversationRow,
  type LedgerOperation,
  ledgerOperationSchemas,
  ledgerRequestSchema
} from '../shared'
import { type ConversationHealIo, healConversation } from './conversation-heal'
import * as ledger from './session-ledger'
import type { ChatStorage } from './storage'
import { isStorageOnlyChatOwner, terminalStorageAgentId } from './storage-mode'

/**
 * The chat store as the async `SlayzoneDb` the ledger rules are written against.
 * better-sqlite3 is synchronous; each call runs at once. `batchTxn` is one
 * transaction. Nothing else of the interface is used by the ledger.
 */
export function ledgerDb(storage: ChatStorage): SlayzoneDb {
  const run = (sql: string, params: unknown[] = []): RunResult =>
    storage.compose((db) => {
      const r = db.prepare(sql).run(...(params as never[]))
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
    })
  const unsupported = (name: string) => () => {
    throw new Error(`ledger db: ${name} is not supported`)
  }
  return {
    get: async <T>(sql: string, params: unknown[] = []) =>
      storage.compose((db) => db.prepare(sql).get(...(params as never[])) as T | undefined),
    all: async <T>(sql: string, params: unknown[] = []) =>
      storage.compose((db) => db.prepare(sql).all(...(params as never[])) as T[]),
    run: async (sql: string, params?: unknown[]) => run(sql, params),
    exec: async (sql: string) => storage.compose((db) => void db.exec(sql)),
    batchTxn: async (ops: BatchOp[]) =>
      storage.transaction(() =>
        ops.map((op) =>
          op.type === 'run'
            ? run(op.sql, op.params)
            : op.type === 'get'
              ? storage.compose((db) => db.prepare(op.sql).get(...(op.params as never[])))
              : storage.compose((db) => db.prepare(op.sql).all(...(op.params as never[])))
        )
      ),
    namedTxn: unsupported('namedTxn') as never,
    backup: unsupported('backup') as never,
    prepare: unsupported('prepare') as never,
    close: async () => undefined
  }
}

/** Operations that change which sessions a task has (the hub refreshes its views). */
const WRITES: ReadonlySet<LedgerOperation> = new Set<LedgerOperation>([
  'recordConversation',
  'recordPendingSpawn',
  'prunePendingSpawns',
  'bindSessionToTask',
  'recordSessionSpawn',
  'markSessionDead',
  'retireDeadPool',
  'confirmSessionConversation',
  'recordHookConversation',
  'markSessionFirstTurn',
  'applySessionIntents',
  'retagBackfilledSessionTab',
  'healConversation'
])

export function createSessionLedgerService(
  storage: ChatStorage,
  opts: {
    /** This computer's disk and checkout (jailed), for `healConversation`. */
    healIo?: ConversationHealIo
  } = {}
) {
  const db = ledgerDb(storage)
  const healIo = opts.healIo
  async function run(op: LedgerOperation, args: unknown): Promise<unknown> {
    switch (op) {
      case 'recordConversation': {
        const a = ledgerOperationSchemas.recordConversation.parse(args)
        await ledger.recordConversation(db, a)
        return null
      }
      case 'recordPendingSpawn':
        return ledger.recordPendingSpawn(db, ledgerOperationSchemas.recordPendingSpawn.parse(args))
      case 'prunePendingSpawns': {
        const a = ledgerOperationSchemas.prunePendingSpawns.parse(args)
        return ledger.prunePendingSpawns(db, a.ids ? { ids: a.ids } : undefined)
      }
      case 'bindSessionToTask':
        return ledger.bindSessionToTask(db, ledgerOperationSchemas.bindSessionToTask.parse(args))
      case 'recordSessionSpawn':
        await ledger.recordSessionSpawn(db, ledgerOperationSchemas.recordSessionSpawn.parse(args))
        return null
      case 'markSessionDead':
        await ledger.markSessionDead(
          db,
          ledgerOperationSchemas.markSessionDead.parse(args).sessionId
        )
        return null
      case 'retireDeadPool':
        return ledger.retireDeadPool(db)
      case 'isHonoredConversation': {
        const a = ledgerOperationSchemas.isHonoredConversation.parse(args)
        return ledger.isHonoredConversation(db, a.taskId, a.mode, a.conversationId)
      }
      case 'getCurrentConversationId': {
        const a = ledgerOperationSchemas.getCurrentConversationId.parse(args)
        return ledger.getCurrentConversationId(db, a.taskId, a.mode, a.tabId)
      }
      case 'listResumeCandidates': {
        const a = ledgerOperationSchemas.listResumeCandidates.parse(args)
        return ledger.listResumeCandidates(db, a.taskId, a.mode, a.tabId)
      }
      case 'claimedByOtherTasks': {
        const a = ledgerOperationSchemas.claimedByOtherTasks.parse(args)
        return [...(await ledger.claimedByOtherTasks(db, a.taskId, a.conversationIds))]
      }
      case 'getConversationFirstSeenAt':
        return ledger.getConversationFirstSeenAt(
          db,
          ledgerOperationSchemas.getConversationFirstSeenAt.parse(args).conversationId
        )
      case 'legacyConversationHistory': {
        const a = ledgerOperationSchemas.legacyConversationHistory.parse(args)
        return ledger.legacyConversationHistory(db, a.taskId, a.mode)
      }
      case 'referencedConversationIds':
        return ledger.referencedConversationIds(db)
      case 'listTaskSessionRows': {
        const a = ledgerOperationSchemas.listTaskSessionRows.parse(args)
        return ledger.listTaskSessionRows(db, a.taskId, a.mode, a.tabId)
      }
      case 'deletableSession': {
        const a = ledgerOperationSchemas.deletableSession.parse(args)
        return ledger.deletableSession(db, a.taskId, a.mode, a.conversationId)
      }
      case 'sessionModesInScope': {
        const a = ledgerOperationSchemas.sessionModesInScope.parse(args)
        return ledger.sessionModesInScope(db, a.taskId, a.tabId)
      }
      case 'confirmSessionConversation':
        return ledger.confirmSessionConversation(
          db,
          ledgerOperationSchemas.confirmSessionConversation.parse(args)
        )
      case 'recordHookConversation':
        return ledger.recordHookConversation(
          db,
          ledgerOperationSchemas.recordHookConversation.parse(args)
        )
      case 'markSessionFirstTurn':
        return ledger.markSessionFirstTurn(
          db,
          ledgerOperationSchemas.markSessionFirstTurn.parse(args).conversationId
        )
      case 'applySessionIntents':
        await ledger.applySessionIntents(db, ledgerOperationSchemas.applySessionIntents.parse(args))
        return null
      case 'listSharedSessionClaims':
        return ledger.listSharedSessionClaims(db)
      case 'retagBackfilledSessionTab':
        return ledger.retagBackfilledSessionTab(
          db,
          ledgerOperationSchemas.retagBackfilledSessionTab.parse(args)
        )
      case 'resumableSessionBefore':
        return ledger.resumableSessionBefore(
          db,
          ledgerOperationSchemas.resumableSessionBefore.parse(args)
        )
      case 'freshSessionsOfTabBetween':
        return ledger.freshSessionsOfTabBetween(
          db,
          ledgerOperationSchemas.freshSessionsOfTabBetween.parse(args)
        )
      case 'conversationMintedAt':
        return ledger.conversationMintedAt(
          db,
          ledgerOperationSchemas.conversationMintedAt.parse(args)
        )
      case 'heldIntents': {
        const ids = JSON.stringify(ledgerOperationSchemas.heldIntents.parse(args).ids)
        return (
          await db.all<{ id: string }>(
            `SELECT id FROM session_resets WHERE id IN (SELECT value FROM json_each(?))
             UNION SELECT id FROM session_deletions WHERE id IN (SELECT value FROM json_each(?))`,
            [ids, ids]
          )
        ).map((r) => r.id)
      }
      case 'chatSessionOwner': {
        const a = ledgerOperationSchemas.chatSessionOwner.parse(args)
        const provider = terminalStorageAgentId(a.mode)
        // Earliest claim first: the chat that recorded the session before any other.
        const rows = await db.all<{
          conversationId: string
          taskId: string
          tabId: string
          mode: string
          recordMode: string | null
        }>(
          `SELECT c.id AS conversationId, c.task_id AS taskId, c.tab_id AS tabId, c.mode,
                  CASE WHEN json_valid(r.value) THEN json_extract(r.value,'$.mode') END AS recordMode
             FROM records r JOIN conversations c ON c.id = r.conversation_id
            WHERE c.state = 'active' AND r.kind = 'settings' AND r.id GLOB 'session:*'
              AND (r.id = 'session:' || ?
                   OR (json_valid(r.value) AND json_extract(r.value,'$.conversationId') = ?))
            ORDER BY r.saved_at, c.rowid`,
          [a.sessionId, a.sessionId]
        )
        const owner = rows.find(
          (r) =>
            !isStorageOnlyChatOwner(r) &&
            terminalStorageAgentId(r.recordMode ?? r.mode) === provider &&
            terminalStorageAgentId(r.mode) === provider
        )
        return owner
          ? {
              conversationId: owner.conversationId,
              taskId: owner.taskId,
              tabId: owner.tabId,
              mode: owner.mode
            }
          : null
      }
      case 'healConversation': {
        const a = ledgerOperationSchemas.healConversation.parse(args)
        // No disk wired (a hub-side harness): unknown — the caller keeps the id.
        if (!healIo) throw new Error('Conversation heal is unavailable here')
        return healConversation(db, healIo, {
          ...a,
          taskCreatedAtMs: a.taskCreatedAtMs ?? Number.NaN
        })
      }
      case 'listConversations': {
        const a = ledgerOperationSchemas.listConversations.parse(args)
        return db.all<LedgerConversationRow>(
          `SELECT id, conversation_id AS conversationId, origin, tab_id AS tabId, created_at AS createdAt
             FROM task_conversations
            WHERE task_id = ? AND mode = ? AND (? IS NULL OR tab_id = ?)
            ORDER BY created_at, rowid`,
          [a.taskId, a.mode, a.tabId ?? null, a.tabId ?? null]
        )
      }
      case 'listAgentSessions': {
        const a = ledgerOperationSchemas.listAgentSessions.parse(args)
        return db.all<LedgerAgentSessionRow>(
          `SELECT id, task_id AS taskId, tab_id AS tabId, mode, status, conversation_id AS conversationId
             FROM agent_sessions
            WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id = ?)
            ORDER BY created_at, rowid LIMIT 1000`,
          [a.status ?? null, a.status ?? null, a.id ?? null, a.id ?? null]
        )
      }
      case 'sessionTasks':
        return sessionTasks(ledgerOperationSchemas.sessionTasks.parse(args).conversationIds)
    }
  }

  /** The task each provider session belongs to (first claim wins), for usage attribution. */
  function sessionTasks(conversationIds: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    if (!conversationIds.length) return out
    const rows = storage.compose(
      (raw) =>
        raw
          .prepare(
            `SELECT conversation_id, task_id FROM agent_sessions
            WHERE conversation_id IN (SELECT value FROM json_each(?)) AND task_id IS NOT NULL
              AND origin <> 'foreign-observed'
            ORDER BY coalesce(bound_at, created_at), task_id`
          )
          .all(JSON.stringify(conversationIds)) as Array<{
          conversation_id: string
          task_id: string
        }>
    )
    for (const r of rows) if (!(r.conversation_id in out)) out[r.conversation_id] = r.task_id
    return out
  }

  return {
    db,
    /**
     * One hub request. Returns the operation's result and, for a write, the task
     * whose sessions it may have changed (null when unknown: every task).
     */
    async handle(raw: unknown): Promise<unknown> {
      const request = ledgerRequestSchema.parse(raw)
      if (!Object.hasOwn(ledgerOperationSchemas, request.op))
        throw new Error(`Unknown ledger operation: ${request.op}`)
      if (request.modeAgents) await ledger.noteModeAgents(db, request.modeAgents)
      return run(request.op as LedgerOperation, request.args)
    },
    isWrite: (op: string) => WRITES.has(op as LedgerOperation),
    /** Record a chat-runtime conversation (the chat's own sessions share the ledger). */
    recordConversation: (input: ledger.RecordConversationInput) =>
      ledger.recordConversation(db, input),
    getCurrentConversationId: (taskId: string, mode: string, tabId?: string) =>
      ledger.getCurrentConversationId(db, taskId, mode, tabId),
    isHonoredConversation: (taskId: string, mode: string, conversationId: string) =>
      ledger.isHonoredConversation(db, taskId, mode, conversationId),
    sessionTasks
  }
}

export type SessionLedgerService = ReturnType<typeof createSessionLedgerService>
