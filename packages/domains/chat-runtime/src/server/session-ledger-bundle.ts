import { z } from 'zod'

/**
 * A task's session ledger on one computer, as a cross-hub move carries it (slice 4):
 * the shape only — no storage, so the hub may use it too (session-moves.ts reads and
 * writes it on computers, session-ledger-merge.ts merges several on the hub).
 *
 * @module chat-runtime/server/session-ledger-bundle
 */
const id = z.string().min(1).max(500)
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().max(1_000_000)

const agentSessionRow = z.object({
  id,
  mode: id,
  tabId: id.nullable(),
  conversationId: id.nullable(),
  origin: id,
  status: z.enum(['pooled', 'bound', 'dead']),
  pendingMeta: z.string().max(10_000).nullable(),
  createdAt: ts,
  boundAt: ts.nullable(),
  endedAt: ts.nullable()
})
const taskConversationRow = z.object({
  id,
  mode: id,
  tabId: id.nullable(),
  conversationId: id.nullable(),
  origin: id,
  pendingMeta: z.string().max(10_000).nullable(),
  createdAt: ts
})
const sessionResetRow = z.object({
  id,
  mode: id,
  tabId: id.nullable(),
  exceptChat: z.number().int().min(0).max(1),
  createdAt: ts
})
const sessionDeletionRow = z.object({ id, mode: id, conversationId: id, createdAt: ts })
const legacyHistoryRow = z.object({ mode: id, ids: z.array(id).max(10_000) })
const providerConfigRow = z.object({ mode: id, revision: ts, value: text })
const sessionTurnRow = z.object({ conversationId: id, firstTurnAt: ts })

/** A task's session ledger on one computer, without what is bound to this computer's paths. */
export const sessionLedgerBundleSchema = z.object({
  agentSessions: z.array(agentSessionRow).max(100_000),
  taskConversations: z.array(taskConversationRow).max(100_000),
  sessionTurns: z.array(sessionTurnRow).max(100_000),
  sessionResets: z.array(sessionResetRow).max(100_000),
  sessionDeletions: z.array(sessionDeletionRow).max(100_000),
  legacyHistory: z.array(legacyHistoryRow).max(100),
  providerConfigs: z.array(providerConfigRow).max(100)
})
export type SessionLedgerBundle = z.infer<typeof sessionLedgerBundleSchema>
