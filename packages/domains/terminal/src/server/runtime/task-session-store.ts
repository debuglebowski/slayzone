import type { ConversationOrigin } from '@slayzone/terminal-contracts'

/**
 * The agent-session ledger as the terminal runtime reaches it (robustness plan §9,
 * P0). The ledger (`agent_sessions`, `task_conversations`, `session_turns`) lives
 * ONLY on the computer that runs a task's agents; the hub keeps no copy. Every call
 * therefore names the computer holding the sessions. The hub's composition root
 * implements this over the computer link (`apps/hub/src/computer-session-ledger.ts`);
 * terminal tests pass `createFakeTaskSessionStore`.
 *
 * `computerId: null` is a hub-local spawn (tests only): there is no computer to hold
 * its sessions, so the hub's implementation records nothing and resolves nothing.
 */
export interface TaskSessionStore {
  /** Append a ledger row (task_conversations + agent_sessions). */
  recordConversation(computerId: string | null, input: RecordConversationInput): Promise<void>
  /** Spawn-intent anchor. Returns the row id. */
  recordPendingSpawn(computerId: string | null, args: PendingSpawnInput): Promise<string>
  /** Drop pending-spawn rows by id, or sweep stale ones. */
  prunePendingSpawns(computerId: string | null, scope?: { ids: string[] }): Promise<number>
  /** Bind a pooled agent session to a task+tab, set-once. */
  bindSessionToTask(
    computerId: string | null,
    args: { sessionId: string; taskId: string; tabId: string }
  ): Promise<boolean>
  /** Record an `agent_sessions` spawn row. */
  recordSessionSpawn(computerId: string | null, input: SessionSpawnInput): Promise<void>
  /** Mark a session's process dead. */
  markSessionDead(computerId: string | null, sessionId: string): Promise<void>
  /** Did this task really run `conversationId` in `mode`? (the guard before a switch) */
  isHonoredConversation(
    computerId: string | null,
    taskId: string,
    mode: string,
    conversationId: string
  ): Promise<boolean>
  /** The conversation `mode` resumes next for this task's tab (omitted = main tab). */
  getCurrentConversationId(
    computerId: string | null,
    taskId: string,
    mode: string,
    tabId?: string
  ): Promise<string | null>
}

/** Input of `TaskSessionStore.recordConversation` (task-conversations ledger append). */
export interface RecordConversationInput {
  /** Stable identity and original time when replaying a row. */
  id?: string
  createdAt?: number
  taskId: string
  mode: string
  /** The tab whose session this is; omitted = the main tab (id = task id). */
  tabId?: string
  conversationId: string | null
  origin: ConversationOrigin
  pendingMeta?: { usedResume: boolean; spawnedAt: number; spawnToken?: string }
  /**
   * Which key of the CHAT runtime's own provider configuration (on the computer)
   * also takes the id: `'chatConversationId'` for a chat mode. Not a hub field.
   */
  legacyJsonField?: 'conversationId' | 'chatConversationId'
}

/** Input of `TaskSessionStore.recordPendingSpawn`. */
export interface PendingSpawnInput {
  taskId: string
  mode: string
  /** The spawning tab; omitted = the main tab. */
  tabId?: string
  /** `null` = fresh spawn without a pre-minted id (agent mints its own). */
  expectedSessionId: string | null
  usedResume: boolean
  /** Per-launch proof echoed by the agent hook. */
  spawnToken?: string
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
  spawnToken?: string
  status: 'pooled' | 'bound'
}
