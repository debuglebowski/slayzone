import type { SlayzoneDb } from '@slayzone/platform'
import type { RecordConversationInput, TaskSessionStore } from './task-session-store'
import {
  persistChatEvent,
  loadChatEvents,
  getNextSeqForTab,
  clearChatEventsForTab,
  type BufferedEvent
} from '../chat-events-store'
import { clearChatQueue } from '../chat-queue-store'
import { buildMcpEnv, resolveRemoteMcpEnv } from '../mcp-env'
import { getRemoteMcpEnvProvider } from './pty-manager'
import type { TerminalMode } from '@slayzone/terminal-contracts'
import {
  bumpAutocompleteUsage,
  getAutocompleteUsage,
  type UsageMap
} from '../autocomplete-usage-store'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { ChatEffort } from '@slayzone/terminal-contracts'
import type { ChatCollaborationMode } from '@slayzone/terminal-contracts'
import type { CliCommandList } from '@slayzone/terminal-contracts'
import { getChatCliSnapshot, saveChatCliSnapshot } from '../chat-cli-snapshot-store'

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

export type { RecordConversationInput }

/**
 * Every DB touchpoint of the terminal chat runtime, behind one injectable
 * seam. The chat handlers never touch `tasks` / `terminal_modes` /
 * `chat_events` / `chat_queue` / `autocomplete_usage` directly — they go
 * through this interface. The default implementation
 * (`createDbChatDataOps`) runs the exact SQL the handlers previously ran
 * inline; a future hub/computer split swaps in a remote implementation with
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
  /** Insert-only; `'clash'` when a row already exists at that seq (never overwritten). */
  persistChatEvent(tabId: string, seq: number, event: AgentEvent): Promise<'inserted' | 'clash'>
  loadChatEvents(tabId: string): Promise<BufferedEvent[]>
  getNextSeqForTab(tabId: string): Promise<number>
  clearChatEventsForTab(tabId: string): Promise<void>
  /** Drop all queued messages for a tab. Returns the number removed. */
  clearChatQueue(tabId: string): Promise<number>
  /** MCP env vars for the chat subprocess (task/project ids, hook URL, …).
   *  Computer-aware: when the task resolves to a computer, the env is built for a
   *  REMOTE spawn (no loopback agent-hook URL — the computer overlays its own and
   *  relays over its authed ws), exactly as the pty ledger does. `computerId` null
   *  keeps today's loopback env. */
  buildMcpEnv(
    taskId: string,
    mode: string,
    computerId?: string | null
  ): Promise<Record<string, string>>
  /** Effective computer for this task, or null for the hub. Mirrors the pty spawn
   *  lookups' `resolveComputerId`; the default impl reads the tasks/projects rows. */
  resolveComputerId(taskId: string): Promise<string | null>
  /** Project this task belongs to, so the COMPUTER can resolve its own cwd.
   *  Mirrors the pty spawn lookups' `getTaskProjectId`. */
  getTaskProjectId(taskId: string): Promise<string | null>
  bumpAutocompleteUsage(source: string, name: string): Promise<void>
  getAutocompleteUsage(): Promise<UsageMap>
  /** Store the slash commands a chat CLI advertised, for the task's project + mode. */
  saveCliSnapshot(taskId: string, mode: string, list: CliCommandList): Promise<void>
  /** Last stored slash-command list for the task's project + mode, or null. */
  getCliSnapshot(taskId: string, mode: string): Promise<CliCommandList | null>
}

/**
 * Default local-DB implementation. Bodies are the exact SQL the chat handlers
 * ran inline before the ops split — behavior (incl. no-op write skips and
 * corrupt-JSON tolerance) is preserved verbatim. The conversation-ledger
 * append goes through the injected task-owned `taskStore`.
 */
/**
 * Set `provider_config[mode][key] = value` in ONE statement, so two writers of
 * different keys can never lose each other's write. Corrupt JSON (or a mode
 * entry that is not an object) is replaced by a fresh object, as before.
 */
const PATCH_PROVIDER_CONFIG_SQL = `UPDATE tasks SET provider_config = (
  SELECT json_set(
    json_set(cfg, ?, CASE WHEN json_type(cfg, ?) = 'object' THEN json(json_extract(cfg, ?)) ELSE json('{}') END),
    ?, json(?))
  FROM (SELECT CASE WHEN json_valid(provider_config) THEN provider_config ELSE '{}' END AS cfg)
) WHERE id = ?`

export function createDbChatDataOps(db: SlayzoneDb, taskStore: TaskSessionStore): ChatDataOps {
  const readEntry = async (taskId: string, mode: string): Promise<ProviderConfigEntry> => {
    const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
      | { provider_config: string | null }
      | undefined
    if (!row?.provider_config) return {}
    try {
      const parsed = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry> | null
      return parsed?.[mode] ?? {}
    } catch {
      return {}
    }
  }
  const patchProviderConfig = async (
    taskId: string,
    mode: string,
    key: keyof ProviderConfigEntry,
    value: unknown
  ): Promise<void> => {
    const modePath = `$.${JSON.stringify(mode)}`
    await db
      .prepare(PATCH_PROVIDER_CONFIG_SQL)
      .run(modePath, modePath, modePath, `${modePath}.${key}`, JSON.stringify(value), taskId)
  }
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

    // Each write skips when the value is already stored (turn-init re-syncs the
    // mode every turn), then patches ONE key in place — never a read-modify-write
    // of the whole JSON, which lost a concurrent write of another key.
    writeChatMode: async (taskId, mode, chatMode) => {
      const existing = await readEntry(taskId, mode)
      if (existing.chatMode === chatMode) return
      await patchProviderConfig(taskId, mode, 'chatMode', chatMode)
    },

    writeChatModel: async (taskId, mode, chatModel) => {
      const existing = await readEntry(taskId, mode)
      if (existing.chatModel === chatModel) return
      await patchProviderConfig(taskId, mode, 'chatModel', chatModel)
    },

    writeChatEffort: async (taskId, mode, chatEffort) => {
      const existing = await readEntry(taskId, mode)
      if ((existing.chatEffort ?? null) === chatEffort) return
      await patchProviderConfig(taskId, mode, 'chatEffort', chatEffort)
    },

    writeChatCollaboration: async (taskId, mode, chatCollaboration) => {
      const existing = await readEntry(taskId, mode)
      if ((existing.chatCollaboration ?? null) === chatCollaboration) return
      await patchProviderConfig(taskId, mode, 'chatCollaboration', chatCollaboration)
    },

    writeChatFastMode: async (taskId, mode, chatFastMode) => {
      const existing = await readEntry(taskId, mode)
      if ((existing.chatFastMode ?? false) === chatFastMode) return
      await patchProviderConfig(taskId, mode, 'chatFastMode', chatFastMode)
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
      await patchProviderConfig(taskId, mode, 'chatConversationId', null)
    },

    getModeDefaultFlags: async (mode) => {
      const row = (await db
        .prepare('SELECT default_flags FROM terminal_modes WHERE id = ?')
        .get(mode)) as { default_flags: string | null } | undefined
      return row?.default_flags ?? null
    },

    recordConversation: (input) => taskStore.recordConversation(db, input),

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

    buildMcpEnv: async (taskId, mode, computerId) => {
      // Mirrors the pty spawn path: a computer-routed session resolves a remote
      // target so the agent env omits the hub-loopback hook URL (the computer
      // overlays its own and relays over its authed ws). `computerId` null →
      // `resolveRemoteMcpEnv` short-circuits to null → today's loopback env.
      const remote = await resolveRemoteMcpEnv(getRemoteMcpEnvProvider(), {
        taskId,
        computerId: computerId ?? null,
        mode: mode as TerminalMode
      })
      return buildMcpEnv(db, taskId, mode as TerminalMode, undefined, remote)
    },

    resolveComputerId: async (taskId) => {
      // Task pin over project default — IDENTICAL to `resolveTaskComputerId` in
      // the computers store. Divergence here would route a chat agent and a
      // terminal agent for the SAME task to different computers.
      const row = await db.get<{ computer_id: string | null }>(
        `SELECT COALESCE(t.computer_id, p.default_computer_id) AS computer_id
           FROM tasks t
           LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.id = ?`,
        [taskId]
      )
      return row?.computer_id ?? null
    },

    getTaskProjectId: async (taskId) => {
      const row = await db.get<{ project_id: string | null }>(
        `SELECT project_id FROM tasks WHERE id = ?`,
        [taskId]
      )
      return row?.project_id ?? null
    },

    bumpAutocompleteUsage: (source, name) => bumpAutocompleteUsage(db, source, name),

    getAutocompleteUsage: () => getAutocompleteUsage(db),

    saveCliSnapshot: (taskId, mode, list) => saveChatCliSnapshot(db, taskId, mode, list),

    getCliSnapshot: (taskId, mode) => getChatCliSnapshot(db, taskId, mode)
  }
}
