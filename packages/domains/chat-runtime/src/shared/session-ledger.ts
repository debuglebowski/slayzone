/**
 * The agent-session ledger's wire shapes (robustness plan §9, P0): the requests the
 * hub sends the computer that holds a task's sessions (`chat.request` kind
 * `ledger`), and the session intents it delivers. The ledger itself lives only on
 * that computer (`chat-runtime/server/session-ledger.ts`).
 *
 * Import-light (zod only).
 *
 * @module chat-runtime/shared/session-ledger
 */
import { z } from 'zod'

const id = z.string().min(1).max(500)
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const origin = z.enum([
  'slay-spawned-fresh',
  'slay-spawned-resume',
  'slay-spawned-fork',
  'in-band-clear',
  'user-selected',
  'handoff',
  'cas-repoint-heal',
  'legacy-migration',
  'foreign-observed',
  'pending-spawn',
  'manual-reset'
])
const pendingMeta = z.object({
  usedResume: z.boolean(),
  spawnedAt: ts,
  spawnToken: z.string().max(500).optional()
})
const taskMode = z.object({ taskId: id, mode: id })
const taskModeTab = taskMode.extend({ tabId: id.optional() })

export const sessionResetIntentSchema = z.object({
  id,
  taskId: id,
  /** `*` = every mode. */
  mode: id,
  tabId: id.nullable(),
  exceptChat: z.boolean(),
  createdAt: ts
})
export const sessionDeletionIntentSchema = z.object({
  id,
  taskId: id,
  mode: id,
  conversationId: id,
  createdAt: ts
})
export const sessionIntentsSchema = z.object({
  resets: z.array(sessionResetIntentSchema).max(10_000),
  deletions: z.array(sessionDeletionIntentSchema).max(10_000)
})
export type SessionIntents = z.infer<typeof sessionIntentsSchema>

export const recordConversationArgsSchema = z.object({
  id: id.optional(),
  createdAt: ts.optional(),
  taskId: id,
  mode: id,
  tabId: id.optional(),
  conversationId: id.nullable(),
  origin,
  pendingMeta: pendingMeta.optional()
})

/** Every ledger operation and its arguments. */
export const ledgerOperationSchemas = {
  recordConversation: recordConversationArgsSchema,
  recordPendingSpawn: taskModeTab.extend({
    expectedSessionId: id.nullable(),
    usedResume: z.boolean(),
    spawnToken: z.string().max(500).optional()
  }),
  prunePendingSpawns: z.object({ ids: z.array(id).max(10_000).optional() }),
  bindSessionToTask: z.object({ sessionId: id, taskId: id, tabId: id }),
  recordSessionSpawn: z.object({
    id,
    taskId: id.nullable(),
    tabId: id.nullable(),
    mode: id,
    cwd: z.string().max(10_000).nullable(),
    expectedConversationId: id.nullable(),
    usedResume: z.boolean(),
    spawnToken: z.string().max(500).optional(),
    status: z.enum(['pooled', 'bound'])
  }),
  markSessionDead: z.object({ sessionId: id }),
  retireDeadPool: z.object({}),
  isHonoredConversation: taskMode.extend({ conversationId: id }),
  getCurrentConversationId: taskModeTab,
  listResumeCandidates: taskModeTab,
  claimedByOtherTasks: z.object({ taskId: id, conversationIds: z.array(id).max(10_000) }),
  getConversationFirstSeenAt: z.object({ conversationId: id }),
  legacyConversationHistory: taskMode,
  referencedConversationIds: z.object({}),
  listTaskSessionRows: taskModeTab,
  deletableSession: taskMode.extend({ conversationId: id }),
  sessionModesInScope: z.object({ taskId: id, tabId: id.nullable() }),
  confirmSessionConversation: z.object({ sessionId: id, observedConversationId: id }),
  recordHookConversation: taskMode.extend({
    sessionId: id,
    source: z.string().max(100).optional(),
    spawnToken: z.string().max(500).optional(),
    ctxTabId: id.optional()
  }),
  markSessionFirstTurn: z.object({ conversationId: id }),
  applySessionIntents: sessionIntentsSchema,
  listSharedSessionClaims: z.object({}),
  retagBackfilledSessionTab: taskMode.extend({ conversationId: id, tabId: id, upTo: ts }),
  resumableSessionBefore: taskMode.extend({ tabId: id, at: ts }),
  freshSessionsOfTabBetween: taskMode.extend({ tabId: id, from: ts, to: ts }),
  conversationMintedAt: taskMode.extend({ conversationId: id }),
  /** Of these session intent ids, the ones held here (consistency check). */
  heldIntents: z.object({ ids: z.array(id).max(100_000) }),
  /**
   * The chat on this computer that holds a provider session (its `session:*`
   * record), whichever side of the provider names it — the computer's answer to
   * what the hub's provider bindings used to mirror (robustness plan §9, v208).
   */
  chatSessionOwner: z.object({ sessionId: id, mode: id }),
  /**
   * Before a resume: keep `storedId`, repoint to a surviving sibling, start it
   * fresh, or leave it for the overlay — decided here, where the transcripts are.
   */
  healConversation: taskMode.extend({
    tabId: id,
    cwd: z.string().max(10_000),
    projectId: id.nullable(),
    storedId: id,
    /** The task's creation time (ms); null = unknown. */
    taskCreatedAtMs: ts.nullable()
  }),
  /** A task's conversation ledger rows of `mode` (optionally one tab), oldest first (diagnostics). */
  listConversations: taskModeTab,
  /** Session rows by status and/or id (diagnostics, warm-pool inspection). */
  listAgentSessions: z.object({
    status: z.enum(['pooled', 'bound', 'dead']).optional(),
    id: id.optional()
  }),
  /** Which task ran each provider session, for usage attribution. */
  sessionTasks: z.object({ conversationIds: z.array(id).max(10_000) })
} as const
export type LedgerOperation = keyof typeof ledgerOperationSchemas
export type LedgerArgs<K extends LedgerOperation> = z.infer<(typeof ledgerOperationSchemas)[K]>

/** One `chat.request` of kind `ledger`. `modeAgents`: which agent user-defined modes wrap. */
export const ledgerRequestSchema = z.object({
  op: z.string().min(1).max(100),
  args: z.unknown(),
  modeAgents: z.record(z.string(), z.string().nullable()).optional()
})
export type LedgerRequest = z.infer<typeof ledgerRequestSchema>

/** One `task_conversations` row as `listConversations` returns it. */
export interface LedgerConversationRow {
  id: string
  conversationId: string | null
  origin: z.infer<typeof origin>
  tabId: string
  createdAt: number
}

/** One `agent_sessions` row as `listAgentSessions` returns it. */
export interface LedgerAgentSessionRow {
  id: string
  taskId: string | null
  tabId: string | null
  mode: string
  status: 'pooled' | 'bound' | 'dead'
  conversationId: string | null
}

/** A task session row as the computer returns it (no prompt summary). */
export interface LedgerTaskSessionRow {
  conversationId: string
  origin: z.infer<typeof origin>
  startedAt: number
  lastActiveAt: number
  ownerTabId: string
  currentInOtherTab: boolean
  isCurrent: boolean
}
