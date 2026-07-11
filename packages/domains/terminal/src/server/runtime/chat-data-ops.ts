import type { SlayzoneDb } from '@slayzone/platform'
import { recordConversation } from '@slayzone/task/server'
import {
  persistChatEvent,
  loadChatEvents,
  getNextSeqForTab,
  clearChatEventsForTab,
  type BufferedEvent
} from '../chat-events-store'
import { clearChatQueue } from '../chat-queue-store'
import { buildMcpEnv } from '../mcp-env'
import {
  bumpAutocompleteUsage,
  getAutocompleteUsage,
  type UsageMap
} from '../autocomplete-usage-store'
import type { AgentEvent } from '../../shared/agent-events'
import type { ChatEffort } from '../../shared/chat-effort'
import type { ChatCollaborationMode } from '../../shared/chat-collaboration'

export interface ProviderConfigEntry {
  conversationId?: string | null
  /**
   * Chat-transport session id. Separate from PTY's conversationId because the two
   * transports store Claude sessions under different paths — a session spawned via
   * PTY `claude --session-id X` is NOT resumable by `claude -p --resume X` (headless
   * stream-json store differs).
   */
  chatConversationId?: string | null
  flags?: string | null
  /** Chat permission/runtime mode (Claude `ChatMode` / Codex runtime mode). */
  chatMode?: string | null
  /** Provider-specific chat model id (Claude alias / Codex model id). */
  chatModel?: string | null
  /** Reasoning effort level. `null`/missing = inherit provider default. */
  chatEffort?: ChatEffort | null
  /** Collaboration mode (Codex `plan`/`default`). `null`/missing = provider default. */
  chatCollaboration?: ChatCollaborationMode | null
  /** Codex Fast Mode (`serviceTier: 'fast'`). `undefined`/missing = off. */
  chatFastMode?: boolean
}

/** Input shape of `recordConversation` (task-conversations ledger append). */
export type RecordConversationInput = Parameters<typeof recordConversation>[1]

/**
 * Every DB touchpoint of the terminal chat runtime, behind one injectable
 * seam. The chat handlers never touch `tasks` / `terminal_modes` /
 * `chat_events` / `chat_queue` / `autocomplete_usage` directly — they go
 * through this interface. The default implementation
 * (`createDbChatDataOps`) runs the exact SQL the handlers previously ran
 * inline; a future hub/runner split swaps in a remote implementation with
 * zero handler changes.
 */
export interface ChatDataOps {
  /** Read `provider_config.{mode}` off the task row. `{}` on missing/corrupt. */
  readProviderConfig(taskId: string, mode: string): Promise<ProviderConfigEntry>
  writeChatMode(taskId: string, mode: string, chatMode: string): Promise<void>
  writeChatModel(taskId: string, mode: string, chatModel: string): Promise<void>
  writeChatEffort(taskId: string, mode: string, chatEffort: ChatEffort | null): Promise<void>
  writeChatCollaboration(
    taskId: string,
    mode: string,
    chatCollaboration: ChatCollaborationMode | null
  ): Promise<void>
  writeChatFastMode(taskId: string, mode: string, chatFastMode: boolean): Promise<void>
  clearChatConversationId(taskId: string, mode: string): Promise<void>
  /** `terminal_modes.default_flags` for a mode (PTY fallback flags). */
  getModeDefaultFlags(mode: string): Promise<string | null>
  /** Append to the task_conversations ledger (+ transition-slice dual-writes). */
  recordConversation(input: RecordConversationInput): Promise<void>
  /**
   * Monotonic `tasks.last_interaction_at` bump. Returns true when the row
   * changed (drives the `tasks:changed` renderer notify at the call site).
   */
  bumpLastInteraction(taskId: string, now: number): Promise<boolean>
  persistChatEvent(tabId: string, seq: number, event: AgentEvent): Promise<void>
  loadChatEvents(tabId: string): Promise<BufferedEvent[]>
  getNextSeqForTab(tabId: string): Promise<number>
  clearChatEventsForTab(tabId: string): Promise<void>
  /** Drop all queued messages for a tab. Returns the number removed. */
  clearChatQueue(tabId: string): Promise<number>
  /** MCP env vars for the chat subprocess (task/project ids, hook URL, …).
   *  Intentionally local-only (no `remote` param): chat is SDK-spawned in THIS
   *  process, never routed to a runner, so it always gets the loopback env. If
   *  chat ever spawns on a runner, thread a `remote` arg here mirroring the pty
   *  ledger's buildMcpEnv (hub/runner split, wave 3). */
  buildMcpEnv(taskId: string, mode: string): Promise<Record<string, string>>
  bumpAutocompleteUsage(source: string, name: string): Promise<void>
  getAutocompleteUsage(): Promise<UsageMap>
}

/**
 * Default local-DB implementation. Bodies are the exact SQL the chat handlers
 * ran inline before the ops split — behavior (incl. no-op write skips and
 * corrupt-JSON tolerance) is preserved verbatim.
 */
export function createDbChatDataOps(db: SlayzoneDb): ChatDataOps {
  return {
    readProviderConfig: async (taskId, mode) => {
      const row = (await db
        .prepare('SELECT provider_config FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null } | undefined
      if (!row?.provider_config) return {}
      try {
        const parsed = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
        return parsed?.[mode] ?? {}
      } catch {
        return {}
      }
    },

    writeChatMode: async (taskId, mode, chatMode) => {
      const row = (await db
        .prepare('SELECT provider_config FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null } | undefined
      let cfg: Record<string, ProviderConfigEntry> = {}
      if (row?.provider_config) {
        try {
          cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
        } catch {
          cfg = {}
        }
      }
      const existing = cfg[mode] ?? {}
      // Idempotent: skip the write when nothing changed. Persisted chat events
      // tick this on every turn-init (live sync); no-op writes would burn I/O for
      // the common case where mode hasn't moved.
      if (existing.chatMode === chatMode) return
      cfg[mode] = { ...existing, chatMode }
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), taskId)
    },

    writeChatModel: async (taskId, mode, chatModel) => {
      const row = (await db
        .prepare('SELECT provider_config FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null } | undefined
      let cfg: Record<string, ProviderConfigEntry> = {}
      if (row?.provider_config) {
        try {
          cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
        } catch {
          cfg = {}
        }
      }
      const existing = cfg[mode] ?? {}
      if (existing.chatModel === chatModel) return
      cfg[mode] = { ...existing, chatModel }
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), taskId)
    },

    writeChatEffort: async (taskId, mode, chatEffort) => {
      const row = (await db
        .prepare('SELECT provider_config FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null } | undefined
      let cfg: Record<string, ProviderConfigEntry> = {}
      if (row?.provider_config) {
        try {
          cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
        } catch {
          cfg = {}
        }
      }
      const existing = cfg[mode] ?? {}
      if ((existing.chatEffort ?? null) === chatEffort) return
      cfg[mode] = { ...existing, chatEffort }
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), taskId)
    },

    writeChatCollaboration: async (taskId, mode, chatCollaboration) => {
      const row = (await db
        .prepare('SELECT provider_config FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null } | undefined
      let cfg: Record<string, ProviderConfigEntry> = {}
      if (row?.provider_config) {
        try {
          cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
        } catch {
          cfg = {}
        }
      }
      const existing = cfg[mode] ?? {}
      if ((existing.chatCollaboration ?? null) === chatCollaboration) return
      cfg[mode] = { ...existing, chatCollaboration }
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), taskId)
    },

    writeChatFastMode: async (taskId, mode, chatFastMode) => {
      const row = (await db
        .prepare('SELECT provider_config FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null } | undefined
      let cfg: Record<string, ProviderConfigEntry> = {}
      if (row?.provider_config) {
        try {
          cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
        } catch {
          cfg = {}
        }
      }
      const existing = cfg[mode] ?? {}
      if ((existing.chatFastMode ?? false) === chatFastMode) return
      cfg[mode] = { ...existing, chatFastMode }
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), taskId)
    },

    clearChatConversationId: async (taskId, mode) => {
      const row = (await db
        .prepare('SELECT provider_config FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null } | undefined
      if (!row?.provider_config) return
      let cfg: Record<string, ProviderConfigEntry> = {}
      try {
        cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
      } catch {
        return
      }
      const existing = cfg[mode]
      if (!existing?.chatConversationId) return
      cfg[mode] = { ...existing, chatConversationId: null }
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), taskId)
    },

    getModeDefaultFlags: async (mode) => {
      const row = (await db
        .prepare('SELECT default_flags FROM terminal_modes WHERE id = ?')
        .get(mode)) as { default_flags: string | null } | undefined
      return row?.default_flags ?? null
    },

    recordConversation: (input) => recordConversation(db, input),

    bumpLastInteraction: async (taskId, now) => {
      const res = await db
        .prepare(
          `UPDATE tasks SET last_interaction_at = ? WHERE id = ? AND (last_interaction_at IS NULL OR last_interaction_at < ?)`
        )
        .run(now, taskId, now)
      return res.changes > 0
    },

    persistChatEvent: (tabId, seq, event) => persistChatEvent(db, tabId, seq, event),

    loadChatEvents: (tabId) => loadChatEvents(db, tabId),

    getNextSeqForTab: (tabId) => getNextSeqForTab(db, tabId),

    clearChatEventsForTab: (tabId) => clearChatEventsForTab(db, tabId),

    clearChatQueue: (tabId) => clearChatQueue(db, tabId),

    buildMcpEnv: (taskId, mode) => buildMcpEnv(db, taskId, mode),

    bumpAutocompleteUsage: (source, name) => bumpAutocompleteUsage(db, source, name),

    getAutocompleteUsage: () => getAutocompleteUsage(db)
  }
}
