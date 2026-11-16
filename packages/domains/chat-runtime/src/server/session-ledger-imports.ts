/**
 * Hand-off kinds of the agent-session ledger (robustness plan §9, P0; hub
 * migration v206): the rows the hub held before the ledger moved here, delivered
 * once by `computer-data-handoff`. Each item is idempotent by its stable key and
 * never overwrites a row this computer already has (that one is newer).
 *
 * @module chat-runtime/server/session-ledger-imports
 */
import { z } from 'zod'
import type { DataImportKind, DataImportKinds } from './task-data'

const id = z.string().min(1).max(500)
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const agentSession = z.object({
  id,
  mode: id,
  cwd: z.string().max(10_000).nullable(),
  taskId: id.nullable(),
  tabId: id.nullable(),
  conversationId: id.nullable(),
  origin: id,
  status: z.enum(['pooled', 'bound', 'dead']),
  pendingMeta: z.string().max(10_000).nullable(),
  createdAt: ts,
  boundAt: ts.nullable(),
  endedAt: ts.nullable()
})

const taskConversation = z.object({
  id,
  taskId: id,
  mode: id,
  tabId: id.nullable(),
  conversationId: id.nullable(),
  origin: id,
  pendingMeta: z.string().max(10_000).nullable(),
  createdAt: ts
})

const sessionTurn = z.object({ conversationId: id, firstTurnAt: ts })

const legacyHistory = z.object({ mode: id, ids: z.array(id).max(10_000) })

/** `agent_sessions` rows (the task's own; a hub row never names another task). */
export const agentSessionImport: DataImportKind<z.infer<typeof agentSession>> = {
  value: agentSession,
  apply(storage, item) {
    const r = item.value
    if (r.taskId !== null && r.taskId !== item.taskId) throw new Error('Session of another task')
    storage.compose((db) =>
      db
        .prepare(
          `INSERT INTO agent_sessions
             (id, mode, cwd, task_id, tab_id, conversation_id, origin, status, pending_meta, created_at, bound_at, ended_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
        )
        .run(
          r.id,
          r.mode,
          r.cwd,
          r.taskId,
          r.tabId,
          r.conversationId,
          r.origin,
          r.status,
          r.pendingMeta,
          r.createdAt,
          r.boundAt,
          r.endedAt
        )
    )
  }
}

/** `task_conversations` rows (the provenance trail). */
export const taskConversationImport: DataImportKind<z.infer<typeof taskConversation>> = {
  value: taskConversation,
  apply(storage, item) {
    const r = item.value
    if (r.taskId !== item.taskId) throw new Error('Conversation row of another task')
    storage.compose((db) =>
      db
        .prepare(
          `INSERT INTO task_conversations
             (id, task_id, mode, tab_id, conversation_id, origin, pending_meta, created_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
        )
        .run(
          r.id,
          r.taskId,
          r.mode,
          r.tabId,
          r.conversationId,
          r.origin,
          r.pendingMeta,
          r.createdAt
        )
    )
  }
}

/** `session_turns`: the resumability proof. Write-once: an existing proof stays. */
export const sessionTurnImport: DataImportKind<z.infer<typeof sessionTurn>> = {
  value: sessionTurn,
  apply(storage, item) {
    storage.compose((db) =>
      db
        .prepare('INSERT OR IGNORE INTO session_turns(conversation_id, first_turn_at) VALUES(?,?)')
        .run(item.value.conversationId, item.value.firstTurnAt)
    )
  }
}

/** A task's pre-ledger session list of one mode (`provider_config.conversationHistory`). */
export const legacyConversationHistoryImport: DataImportKind<z.infer<typeof legacyHistory>> = {
  value: legacyHistory,
  apply(storage, item) {
    storage.compose((db) => {
      const existing = db
        .prepare('SELECT ids FROM legacy_conversation_history WHERE task_id=? AND mode=?')
        .get(item.taskId, item.value.mode) as { ids: string } | undefined
      let known: string[] = []
      try {
        known = existing ? (JSON.parse(existing.ids) as string[]) : []
      } catch {
        known = []
      }
      const ids = [...new Set([...known, ...item.value.ids])]
      db.prepare(
        `INSERT INTO legacy_conversation_history(task_id, mode, ids) VALUES(?,?,?)
         ON CONFLICT(task_id, mode) DO UPDATE SET ids = excluded.ids`
      ).run(item.taskId, item.value.mode, JSON.stringify(ids))
    })
  }
}

/** Every ledger hand-off kind, by the name the hub stages it under. */
export const sessionLedgerImports: DataImportKinds = {
  'agent-session': agentSessionImport,
  'task-conversation': taskConversationImport,
  'session-turn': sessionTurnImport,
  'legacy-conversation-history': legacyConversationHistoryImport
}
