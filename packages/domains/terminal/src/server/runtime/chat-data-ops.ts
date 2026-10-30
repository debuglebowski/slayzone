import type { SlayzoneDb } from '@slayzone/platform'
import { recordedProjectRoot } from '@slayzone/computers/server'
import type { RecordConversationInput, TaskSessionStore } from './task-session-store'
import {
  persistChatEvent,
  loadChatEvents,
  loadChatEventsRange,
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
import type { ChatCollaborationMode } from '@slayzone/terminal-contracts'
import type { ChatModelInfo, CliCommandDetails, CliCommandList } from '@slayzone/terminal-contracts'
import {
  getChatCliCommandDetails,
  getChatCliModels,
  getChatCliSnapshot,
  saveChatCliCommandDetails,
  saveChatCliModels,
  saveChatCliSnapshot
} from '../chat-cli-snapshot-store'
import {
  userMessageAttachments,
  type ChatAttachment,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import type { AttachmentLookup } from './chat-attachment-guard'
import { getChatTabState, saveChatDraft, saveChatScroll } from '../chat-tab-state-store'
import type { ChatDraft, ChatScrollAnchor, ChatTabState } from '@slayzone/terminal-contracts'

export interface ProviderConfigEntry {
  conversationId?: string | null
  /**
   * Chat-transport session id — its own field because chat and terminal are two
   * modes with their own current conversation. The CLI's store is the same: a
   * TUI session resumes under `claude -p --resume X` and the reverse (2.1.312,
   * chat-a check R1), which is what the chat ↔ terminal hand-off relies on.
   */
  chatConversationId?: string | null
  flags?: string | null
  /** Chat permission/runtime mode (Claude `ChatMode` / Codex runtime mode). */
  chatMode?: string | null
  /** Provider-specific chat model id (Claude alias / Codex model id). */
  chatModel?: string | null
  /** Reasoning effort level. `null`/missing = inherit provider default. */
  /** Claude: a `ChatEffort`; Codex: any effort its model lists. */
  chatEffort?: string | null
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
  writeChatEffort(taskId: string, mode: string, chatEffort: string | null): Promise<void>
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
  /** Did this task run `conversationId` in `mode` (honored, not deleted)? */
  isHonoredConversation(taskId: string, mode: string, conversationId: string): Promise<boolean>
  /** The conversation `mode` resumes next for this task (the ledger's current). */
  getCurrentConversationId(taskId: string, mode: string): Promise<string | null>
  /**
   * Monotonic `tasks.last_interaction_at` bump. Returns true when the row
   * changed (drives the `tasks:changed` renderer notify at the call site).
   */
  bumpLastInteraction(taskId: string, now: number): Promise<boolean>
  /** Insert-only; `'clash'` when a row already exists at that seq (never overwritten). */
  persistChatEvent(tabId: string, seq: number, event: AgentEvent): Promise<'inserted' | 'clash'>
  loadChatEvents(tabId: string): Promise<BufferedEvent[]>
  /** Saved events with `afterSeq < seq < beforeSeq` (history older than the in-memory cache). */
  loadChatEventsRange(tabId: string, afterSeq: number, beforeSeq: number): Promise<BufferedEvent[]>
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
  /** The project's folder on that computer as the hub knows it, or null.
   *  Mirrors the pty spawn lookups' `getProjectRoot`. */
  getProjectRoot(projectId: string, computerId: string): Promise<string | null>
  bumpAutocompleteUsage(source: string, name: string): Promise<void>
  getAutocompleteUsage(): Promise<UsageMap>
  /** Store the slash commands a chat CLI advertised, for the task's project + mode. */
  saveCliSnapshot(taskId: string, mode: string, list: CliCommandList): Promise<void>
  /** Store the CLI's command descriptions + argument hints, for the task's project + mode. */
  saveCliCommandDetails(taskId: string, mode: string, details: CliCommandDetails): Promise<void>
  /** Last stored slash-command list for the task's project + mode, or null. */
  getCliSnapshot(taskId: string, mode: string): Promise<CliCommandList | null>
  /** Stored command descriptions + argument hints for the task's project + mode, or null. */
  getCliCommandDetails(taskId: string, mode: string): Promise<CliCommandDetails | null>
  /** Store the models the CLI offers (Codex `model/list`), for the task's project + mode. */
  saveCliModels(taskId: string, mode: string, models: ChatModelInfo[]): Promise<void>
  /** Stored models for the task's project + mode, or null. */
  getCliModels(taskId: string, mode: string): Promise<ChatModelInfo[] | null>
  /** A chat tab's saved draft + scroll anchor, or null. */
  getTabState(tabId: string): Promise<ChatTabState | null>
  /** Save the draft; the new revision, or null when the tab is gone. */
  saveTabDraft(tabId: string, draft: ChatDraft): Promise<{ rev: number } | null>
  saveTabScroll(tabId: string, anchor: ChatScrollAnchor): Promise<void>
  /** What the attachment gate reads (`chat-attachment-guard.ts`). */
  attachments: AttachmentLookup
}

/** The attachment gate's reads, over the local DB. */
export function createDbAttachmentLookup(db: SlayzoneDb): AttachmentLookup {
  return {
    tab: async (tabId) => {
      const row = await db.get<{ task_id: string; mode: string }>(
        `SELECT task_id, mode FROM terminal_tabs WHERE id = ?`,
        [tabId]
      )
      return row ? { taskId: row.task_id, mode: row.mode } : null
    },
    artifacts: async (ids) => {
      if (ids.length === 0) return new Map()
      const rows = await db.all<{ id: string; task_id: string; content_hash: string | null }>(
        `SELECT a.id, a.task_id, v.content_hash
           FROM task_artifacts a
           LEFT JOIN artifact_versions v ON v.id = a.current_version_id
          WHERE a.id IN (${ids.map(() => '?').join(',')})`,
        ids
      )
      return new Map(rows.map((r) => [r.id, { taskId: r.task_id, contentHash: r.content_hash }]))
    },
    queued: async (tabId, exceptId) => {
      const rows = await db.all<{ id: string; content: string | null }>(
        `SELECT id, content FROM chat_queue WHERE tab_id = ? AND content IS NOT NULL`,
        [tabId]
      )
      const out: ChatAttachment[] = []
      for (const row of rows) {
        if (row.id === exceptId || !row.content) continue
        try {
          const content = JSON.parse(row.content) as unknown
          if (Array.isArray(content))
            out.push(...userMessageAttachments(content as UserContentBlock[]))
        } catch {
          /* corrupt row: nothing attached */
        }
      }
      return out
    },
    hasVersion: async (artifactId, contentHash) =>
      !!(await db.get(
        `SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND content_hash = ? LIMIT 1`,
        [artifactId, contentHash]
      ))
  }
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

    isHonoredConversation: (taskId, mode, conversationId) =>
      taskStore.isHonoredConversation(db, taskId, mode, conversationId),

    getCurrentConversationId: (taskId, mode) =>
      taskStore.getCurrentConversationId(db, taskId, mode),

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
    loadChatEventsRange: (tabId, afterSeq, beforeSeq) =>
      loadChatEventsRange(db, tabId, afterSeq, beforeSeq),

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

    getProjectRoot: (projectId, computerId) => recordedProjectRoot(db, projectId, computerId),

    bumpAutocompleteUsage: (source, name) => bumpAutocompleteUsage(db, source, name),

    getAutocompleteUsage: () => getAutocompleteUsage(db),

    saveCliSnapshot: (taskId, mode, list) => saveChatCliSnapshot(db, taskId, mode, list),

    saveCliCommandDetails: (taskId, mode, details) =>
      saveChatCliCommandDetails(db, taskId, mode, details),

    getCliSnapshot: (taskId, mode) => getChatCliSnapshot(db, taskId, mode),

    getCliCommandDetails: (taskId, mode) => getChatCliCommandDetails(db, taskId, mode),

    saveCliModels: (taskId, mode, models) => saveChatCliModels(db, taskId, mode, models),

    getCliModels: (taskId, mode) => getChatCliModels(db, taskId, mode),

    getTabState: (tabId) => getChatTabState(db, tabId),
    saveTabDraft: (tabId, draft) => saveChatDraft(db, tabId, draft),
    saveTabScroll: (tabId, anchor) => saveChatScroll(db, tabId, anchor),

    attachments: createDbAttachmentLookup(db)
  }
}
