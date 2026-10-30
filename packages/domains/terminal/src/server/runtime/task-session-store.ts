import type { SlayzoneDb } from '@slayzone/platform'
import type { ConversationOrigin } from '@slayzone/terminal-contracts'

/**
 * Task-side session/conversation ledger writes the terminal runtime makes
 * (`task_conversations` + `agent_sessions` rows). Terminal owns this interface;
 * the task package owns the implementation (`taskSessionStore` in its server
 * barrel) and the composition root passes it in. This keeps the
 * dependency one-way (task → terminal) while the `createDb*` default ops below run
 * the exact same task functions they always called.
 *
 * Every method takes the db handle first, mirroring the task functions' own
 * signatures, so the implementation is the task functions themselves.
 */
export interface TaskSessionStore {
  /** Append a `task_conversations` ledger row (task's `recordConversation`). */
  recordConversation(db: SlayzoneDb, input: RecordConversationInput): Promise<void>
  /** Spawn-intent anchor (task's `recordPendingSpawn`). */
  recordPendingSpawn(db: SlayzoneDb, args: PendingSpawnInput): Promise<void>
  /** Drop pending-spawn rows (task's `prunePendingSpawns`). */
  prunePendingSpawns(db: SlayzoneDb, scope?: { taskId: string; mode: string }): Promise<number>
  /** Bind a pooled agent session to a task+tab, set-once (task's `bindSessionToTask`). */
  bindSessionToTask(
    db: SlayzoneDb,
    args: { sessionId: string; taskId: string; tabId: string }
  ): Promise<boolean>
  /** Record an `agent_sessions` spawn row (task's `recordSessionSpawn`). */
  recordSessionSpawn(db: SlayzoneDb, input: SessionSpawnInput): Promise<void>
  /** Mark a session's process dead (task's `markSessionDead`). */
  markSessionDead(db: SlayzoneDb, sessionId: string): Promise<void>
  /**
   * Did this task really run `conversationId` in `mode` (an honored, not deleted
   * ledger row)? Task's `isHonoredConversation` — the guard before a switch.
   */
  isHonoredConversation(
    db: SlayzoneDb,
    taskId: string,
    mode: string,
    conversationId: string
  ): Promise<boolean>
  /** The conversation `mode` resumes next for this task (task's `getCurrentConversationId`). */
  getCurrentConversationId(db: SlayzoneDb, taskId: string, mode: string): Promise<string | null>
}

/** Input of `TaskSessionStore.recordConversation` (task-conversations ledger append). */
export interface RecordConversationInput {
  taskId: string
  mode: string
  conversationId: string | null
  origin: ConversationOrigin
  pendingMeta?: { usedResume: boolean; spawnedAt: number }
  /**
   * Which JSON key inside `provider_config.{mode}` to mirror to during the
   * transition slice. Defaults to `'conversationId'`; chat-mode callers pass
   * `'chatConversationId'`.
   */
  legacyJsonField?: 'conversationId' | 'chatConversationId'
}

/** Input of `TaskSessionStore.recordPendingSpawn`. */
export interface PendingSpawnInput {
  taskId: string
  mode: string
  /** `null` = fresh spawn without a pre-minted id (agent mints its own). */
  expectedSessionId: string | null
  usedResume: boolean
}

/** Input of `TaskSessionStore.recordSessionSpawn`. */
export interface SessionSpawnInput {
  id: string
  taskId: string | null
  tabId: string | null
  mode: string
  cwd: string | null
  /** Id slay expects the provider to echo back (pre-minted), or null. */
  expectedConversationId: string | null
  usedResume: boolean
  status: 'pooled' | 'bound'
}
