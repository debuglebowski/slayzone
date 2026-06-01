import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  hydrateSession,
  ensureSpawned,
  sendUserMessage,
  sendToolResult,
  sendControlRequest,
  respondToPermissionRequest,
  updateSessionChatMode,
  updateSessionChatModel,
  updateSessionChatEffort,
  updateSessionChatCollaboration,
  updateSessionChatFastMode,
  kill as killChat,
  removeSession,
  recordInterrupted,
  popLastUserMessage,
  getEventBufferSince,
  getSessionInfo,
  getSessionTerminalState,
  killAll,
  shutdownAll,
  configureTransport,
  type ChatSessionInfo,
  type ShutdownOptions,
  type TransportShutdownResult
} from './chat-transport-manager'
import {
  persistChatEvent,
  loadChatEvents,
  getNextSeqForTab,
  clearChatEventsForTab
} from './chat-events-store'
import { registerChatQueueHandlers } from './chat-queue-handlers'
import { clearChatQueue } from './chat-queue-store'
import { notifyGlobalStateListeners } from './pty-manager'
import { parseShellArgs } from './adapters/flag-parser'
import { buildMcpEnv } from './mcp-env'
import { getEnrichedPath } from './shell-env'
import { supportsChatMode } from './agents/registry'
import { getAutoModeEligibility, type AutoModeEligibility } from './auto-mode-eligibility'
import { resolveAccountDefaultModel } from './account-default-model'
import { listSkills } from './skills'
import { listCommands } from './commands'
import { listAgents } from './agents-registry'
import { listProjectFiles } from './files-scan'
import {
  bumpAutocompleteUsage,
  getAutocompleteUsage,
  type UsageMap
} from './autocomplete-usage-store'
import type { SkillInfo, CommandInfo, AgentInfo, FileMatch } from '../shared/types'
import type { AgentEvent } from '../shared/agent-events'
import {
  rawPermissionModeToChatMode,
  chatModeToFlags as chatModeToFlagsShared,
  chatModeToCliPermissionMode,
  type ChatMode as ChatModeShared
} from '../shared/chat-mode'
import { chatModelToFlags } from '../shared/chat-model'
import { defaultModelForMode, isValidModelForMode } from '../shared/chat-model-catalog'
import { defaultChatModeForMode, isValidChatModeForMode } from '../shared/chat-mode-catalog'
import { chatEffortToFlags, isChatEffort, type ChatEffort } from '../shared/chat-effort'
import {
  isChatCollaborationMode,
  modeSupportsCollaboration,
  type ChatCollaborationMode
} from '../shared/chat-collaboration'
import { modeSupportsFastMode } from '../shared/chat-fast-mode'

export interface ChatHandlerOpts {
  /** Optional secondary subscriber to every persisted chat event. Used by the
   * agent-turns domain to detect turn boundaries (user-message + result). */
  onChatEvent?: (tabId: string, event: AgentEvent) => void
}

interface ChatCreateOpts {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
}

/**
 * Permission/operating mode for chat sessions. Live mode flips ride a
 * `control_request {subtype:'set_permission_mode', mode}` over stdin so the
 * subprocess (and warm conversation state) survives — see `chat:setMode`.
 * `bypass` still needs a kill+respawn because it's enabled via a separate
 * `--allow-dangerously-skip-permissions` flag with no in-flight equivalent;
 * the handler falls back to that path when control_request can't apply.
 *
 * Inbound `tool_result` blocks (e.g. AskUserQuestion answer) ride the same
 * stdin channel — `chat:sendToolResult`.
 *
 * `auto` requires Max/Team/Enterprise + a one-time opt-in. Capability is
 * detected via `chat:getAutoEligibility` (reads ~/.claude.json + settings.json);
 * the UI hides the option when ineligible and disables it when not opted in.
 */
export type ChatMode = ChatModeShared

export const DEFAULT_CHAT_MODE_NEW_TASK: ChatMode = 'auto-accept'
/** Pre-existing tasks (no chatMode) keep current behavior on first upgrade. */
export const DEFAULT_CHAT_MODE_LEGACY: ChatMode = 'bypass'

export const chatModeToFlags = chatModeToFlagsShared

/**
 * Downgrade `auto` to `auto-accept` when the user is no longer eligible / opted
 * in. Covers a real edge case: a task saved with `chatMode: 'auto'` survives a
 * plan downgrade or opt-in revocation. Without the downgrade, `chatModeToFlags`
 * would still emit `--permission-mode auto`, which `claude-code` rejects → the
 * child crashes immediately on every chat spawn for that task. All other modes
 * pass through untouched.
 */
async function resolveSafeChatMode(stored: string): Promise<string> {
  if (stored !== 'auto') return stored
  const cap = await getAutoModeEligibility()
  return cap.optedIn ? 'auto' : 'auto-accept'
}

interface ProviderConfigEntry {
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

async function readProviderConfig(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<ProviderConfigEntry> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
  if (!row?.provider_config) return {}
  try {
    const parsed = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
    return parsed?.[mode] ?? {}
  } catch {
    return {}
  }
}

async function writeChatConversationId(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  id: string
): Promise<void> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
  let cfg: Record<string, ProviderConfigEntry> = {}
  if (row?.provider_config) {
    try {
      cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
    } catch {
      cfg = {}
    }
  }
  const existing = cfg[mode] ?? {}
  cfg[mode] = { ...existing, chatConversationId: id }
  await db
    .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
    .run(JSON.stringify(cfg), taskId)
}

async function writeChatModel(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  chatModel: string
): Promise<void> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
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
}

async function writeChatEffort(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  chatEffort: ChatEffort | null
): Promise<void> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
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
}

async function writeChatCollaboration(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  chatCollaboration: ChatCollaborationMode | null
): Promise<void> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
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
}

async function writeChatFastMode(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  chatFastMode: boolean
): Promise<void> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
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
}

async function writeChatMode(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  chatMode: string
): Promise<void> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
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
}

/**
 * One-shot backfill: every chat-capable task gets `chatMode='bypass'` set on
 * its terminal_mode entry — preserving current default behavior
 * (`--allow-dangerously-skip-permissions`) for pre-upgrade tasks. New tasks
 * created after this migration runs get `auto-accept` by default via
 * `buildHydrateOpts`.
 *
 * Two categories of pre-existing tasks are covered:
 *   1. Existing provider_config entry but no `chatMode` field — patched.
 *   2. NULL provider_config (or missing entry for the task's terminal_mode) —
 *      a fresh entry with `chatMode='bypass'` is created.
 *
 * Idempotent: skips entries that already have `chatMode` set. Safe to call
 * on every app start. Only chat-capable modes (per `supportsChatMode`) are
 * touched, leaving non-chat modes alone.
 */
export async function backfillChatModes(
  db: SlayzoneDb
): Promise<{ scanned: number; updated: number }> {
  const rows = (await db.prepare('SELECT id, terminal_mode, provider_config FROM tasks').all()) as {
    id: string
    terminal_mode: string | null
    provider_config: string | null
  }[]
  let scanned = 0
  let updated = 0
  for (const row of rows) {
    scanned++
    let cfg: Record<string, ProviderConfigEntry> = {}
    if (row.provider_config) {
      try {
        cfg = JSON.parse(row.provider_config) as Record<string, ProviderConfigEntry>
      } catch {
        continue
      }
    }
    let dirty = false
    // Patch existing entries — only chat-capable modes. Non-chat modes (PTY-only
    // like 'claude-code' after the chat split) don't carry chatMode semantics.
    for (const mode of Object.keys(cfg)) {
      const entry = cfg[mode]
      if (!entry || entry.chatMode != null) continue
      if (!supportsChatMode(mode)) continue
      cfg[mode] = { ...entry, chatMode: DEFAULT_CHAT_MODE_LEGACY }
      dirty = true
    }
    // Ensure the task's primary terminal_mode has an entry if it's chat-capable.
    if (
      row.terminal_mode &&
      supportsChatMode(row.terminal_mode) &&
      cfg[row.terminal_mode]?.chatMode == null
    ) {
      cfg[row.terminal_mode] = {
        ...(cfg[row.terminal_mode] ?? {}),
        chatMode: DEFAULT_CHAT_MODE_LEGACY
      }
      dirty = true
    }
    if (dirty) {
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), row.id)
      updated++
    }
  }
  return { scanned, updated }
}

async function clearChatConversationId(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<void> {
  const row = (await db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId)) as
    | { provider_config: string | null }
    | undefined
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
}

async function readTaskModeDefaultFlags(db: SlayzoneDb, mode: string): Promise<string | null> {
  const row = (await db
    .prepare('SELECT default_flags FROM terminal_modes WHERE id = ?')
    .get(mode)) as { default_flags: string | null } | undefined
  return row?.default_flags ?? null
}

/**
 * Check whether effective flags contain a non-interactive permission mode.
 * Chat mode has no prompt events; without this, tool calls fail silently.
 * Returns { ok, hasSkipPerms, hasPermissionMode }.
 */
export function inspectPermissionFlags(flags: string[]): {
  ok: boolean
  hasSkipPerms: boolean
  hasPermissionMode: boolean
  permissionModeValue: string | null
} {
  const hasSkipPerms = flags.includes('--allow-dangerously-skip-permissions')
  let hasPermissionMode = false
  let permissionModeValue: string | null = null
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--permission-mode' && i + 1 < flags.length) {
      hasPermissionMode = true
      permissionModeValue = flags[i + 1]
      break
    }
  }
  // 'default' mode requires prompts — not safe for chat. Others auto-approve.
  const permissiveModes = ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']
  const modeIsPermissive = permissionModeValue
    ? permissiveModes.includes(permissionModeValue)
    : false
  return {
    ok: hasSkipPerms || modeIsPermissive,
    hasSkipPerms,
    hasPermissionMode,
    permissionModeValue
  }
}

/**
 * Shared opts builder for `chat:hydrate` + `chat:reset` + `chat:start` + control
 * fast-paths.
 *
 * `fresh: true` forces a new session id (skips --resume) — used by reset to
 * guarantee a clean thread regardless of whatever was previously stored. PATH
 * enrichment + MCP env are identical across both paths, so factoring here
 * prevents drift.
 *
 * `chatModeOverride` short-circuits the DB lookup of provider_config.chatMode —
 * used by `chat:setMode` so the spawn flags reflect the user's intent before
 * the DB cache is updated. Lets us run the DB write *after* spawn succeeds
 * (transactional) without a race where the builder re-reads stale DB.
 */
async function buildHydrateOpts(
  db: SlayzoneDb,
  opts: ChatCreateOpts,
  {
    fresh,
    chatModeOverride,
    chatModelOverride,
    chatEffortOverride,
    chatCollaborationOverride,
    chatFastModeOverride
  }: {
    fresh: boolean
    chatModeOverride?: string
    chatModelOverride?: string
    chatEffortOverride?: ChatEffort | null
    chatCollaborationOverride?: ChatCollaborationMode | null
    chatFastModeOverride?: boolean
  }
): Promise<Parameters<typeof hydrateSession>[0]> {
  const providerCfg = await readProviderConfig(db, opts.taskId, opts.mode)
  // Flag-resolution priority for chat:
  //   1. per-call override (`providerFlagsOverride`)
  //   2. per-task explicit flags (`providerCfg.flags`)
  //   3. chatMode (override > DB-cached > default)
  // terminal_modes default_flags is intentionally NOT consulted for chat — chat owns
  // its own permission UX through chatMode. Terminal still uses default_flags.
  let providerFlags: string[]
  let resolvedChatMode: string | null = null
  if (chatModeOverride) {
    // Explicit chatMode change (chat:setMode): override wins over both per-call
    // flag overrides and providerCfg.flags — the user explicitly asked for a
    // mode, and chatMode-derived flags must take effect for the spawn.
    resolvedChatMode = await resolveSafeChatMode(chatModeOverride)
    providerFlags = chatModeToFlags(resolvedChatMode)
  } else if (opts.providerFlagsOverride) {
    providerFlags = parseShellArgs(opts.providerFlagsOverride)
  } else if (providerCfg.flags) {
    providerFlags = parseShellArgs(providerCfg.flags)
  } else {
    const stored = providerCfg.chatMode ?? defaultChatModeForMode(opts.mode)
    resolvedChatMode = await resolveSafeChatMode(stored)
    providerFlags = chatModeToFlags(resolvedChatMode)
  }

  // Resolve the model: override > stored (validated against the mode's
  // catalog) > provider default. `codex-chat` defaults to a Codex model;
  // claude-chat falls back to the account default from ~/.claude/settings.json.
  const storedChatModel = isValidModelForMode(opts.mode, providerCfg.chatModel)
    ? providerCfg.chatModel
    : null
  const resolvedChatModel: string =
    chatModelOverride ??
    storedChatModel ??
    (opts.mode === 'codex-chat'
      ? defaultModelForMode(opts.mode)
      : await resolveAccountDefaultModel())
  const resolvedChatEffort: ChatEffort | null =
    chatEffortOverride !== undefined ? chatEffortOverride : (providerCfg.chatEffort ?? null)
  // Collaboration mode (Codex `plan`/`default`). Only codex-chat carries it;
  // for other providers it stays null and the driver omits `collaborationMode`.
  const resolvedChatCollaboration: ChatCollaborationMode | null = modeSupportsCollaboration(
    opts.mode
  )
    ? chatCollaborationOverride !== undefined
      ? chatCollaborationOverride
      : (providerCfg.chatCollaboration ?? null)
    : null
  // Codex Fast Mode (`serviceTier: 'fast'`). Only codex-chat carries it.
  const resolvedChatFastMode: boolean = modeSupportsFastMode(opts.mode)
    ? chatFastModeOverride !== undefined
      ? chatFastModeOverride
      : (providerCfg.chatFastMode ?? false)
    : false
  // Append --model/--effort flags only for flag-driven providers (claude-chat).
  // codex-chat carries model/effort over the JSON-RPC `turn/start` params, not
  // CLI flags — its backend ignores `providerFlags` entirely.
  const usedExplicitFlags = !chatModeOverride && (opts.providerFlagsOverride || providerCfg.flags)
  if (!usedExplicitFlags && opts.mode !== 'codex-chat') {
    providerFlags = [...providerFlags, ...chatModelToFlags(resolvedChatModel)]
    providerFlags = [...providerFlags, ...chatEffortToFlags(resolvedChatEffort)]
  }

  const initialBuffer = fresh ? [] : await loadChatEvents(db, opts.tabId)
  const initialNextSeq = fresh ? 0 : await getNextSeqForTab(db, opts.tabId)

  const enrichedPath = getEnrichedPath()
  const subprocessEnv: Record<string, string> = {
    ...(await buildMcpEnv(db, opts.taskId, opts.mode)),
    ...(enrichedPath ? { PATH: enrichedPath } : {})
  }

  return {
    tabId: opts.tabId,
    taskId: opts.taskId,
    mode: opts.mode,
    cwd: opts.cwd,
    conversationId: fresh ? null : (providerCfg.chatConversationId ?? null),
    providerFlags,
    env: subprocessEnv,
    initialBuffer,
    initialNextSeq,
    chatMode: resolvedChatMode,
    chatModel: resolvedChatModel,
    chatEffort: resolvedChatEffort,
    chatCollaboration: resolvedChatCollaboration,
    chatFastMode: resolvedChatFastMode,
    onPersistSessionId: (id) => {
      // Fire-and-forget DB write — the transport invokes this without awaiting
      // (same as before the async-DB lift; the write was already a void side
      // effect). Errors surface via the persist path's own logging.
      void writeChatConversationId(db, opts.taskId, opts.mode, id)
    },
    onInvalidResume: () => {
      void clearChatConversationId(db, opts.taskId, opts.mode)
    }
  }
}

export function registerChatHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb,
  opts: ChatHandlerOpts = {}
): void {
  // Wire SQLite persistence into the transport. Default deps had a no-op
  // persistEvent; configureTransport keeps spawn/whichBinary/broadcast* untouched.
  configureTransport({
    onStateChange: (sessionId, newState, oldState) => {
      // ChatTerminalState includes `not-spawned` which doesn't exist in the
      // shared `TerminalState` union (PTY domain). transitionState skips into
      // `not-spawned` (it's only set at hydrate time), so by the time
      // onStateChange fires both endpoints are real terminal states — cast
      // narrows them down for the global listener.
      if (newState === 'not-spawned' || oldState === 'not-spawned') return
      notifyGlobalStateListeners(sessionId, newState, oldState)
    },
    // Async because the DB lift makes persistChatEvent / the last_interaction_at
    // UPDATE / writeChatMode Promises. The transport invokes this without
    // awaiting (fire-and-forget, wrapped in its own try/catch), matching the
    // prior void semantics — the returned Promise simply floats.
    persistEvent: (tabId, seq, event) => {
      void (async () => {
        try {
          await persistChatEvent(db, tabId, seq, event)
        } catch (err) {
          console.error('[chat-handlers] persistChatEvent failed:', err)
        }
        // Tree-view "Last interaction" sort marker — only fire on user-message
        // (clear "I interacted" signal). Agent-side bumps come via agent_turns.
        if (event.kind === 'user-message') {
          const info = getSessionInfo(tabId)
          if (info) {
            try {
              const now = Date.now()
              const res = await db
                .prepare(
                  `UPDATE tasks SET last_interaction_at = ? WHERE id = ? AND (last_interaction_at IS NULL OR last_interaction_at < ?)`
                )
                .run(now, info.taskId, now)
              // Notify renderer so the tree-view sort reorders without waiting
              // for an unrelated tasks reload. Skip when UPDATE was a no-op.
              if (res.changes > 0) {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const { BrowserWindow } = require('electron') as typeof import('electron')
                  for (const w of BrowserWindow.getAllWindows()) {
                    if (!w.isDestroyed()) w.webContents.send('tasks:changed')
                  }
                } catch {
                  // non-electron (tests) — no-op
                }
              }
            } catch (err) {
              console.error('[chat-handlers] bump last_interaction_at failed:', err)
            }
          }
        }
        // Subprocess is the source of truth for permission mode. Cache it back
        // into provider_config whenever turn-init carries a recognized mode so
        // cold-start spawn flags match the last observed live value.
        if (event.kind === 'turn-init') {
          const mapped = rawPermissionModeToChatMode(event.permissionMode)
          if (mapped) {
            const info = getSessionInfo(tabId)
            if (info) {
              try {
                await writeChatMode(db, info.taskId, info.mode, mapped)
              } catch (err) {
                console.error('[chat-handlers] writeChatMode (live sync) failed:', err)
              }
            }
          }
        }
      })()
      if (opts.onChatEvent) {
        try {
          opts.onChatEvent(tabId, event)
        } catch (err) {
          console.error('[chat-handlers] onChatEvent failed:', err)
        }
      }
    }
  })

  registerChatQueueHandlers(ipcMain, db)

  ipcMain.handle('chat:supports', (_, mode: string): boolean => supportsChatMode(mode))

  /**
   * Lazy hydrate: load persisted buffer + chat metadata into an in-memory
   * skeleton session WITHOUT spawning a subprocess. The actual OS process is
   * started lazily on the first `chat:send` (or queue drain). Idempotent —
   * reattaches to an existing live session for the same tab.
   */
  ipcMain.handle('chat:hydrate', async (_, opts: ChatCreateOpts): Promise<ChatSessionInfo> => {
    return hydrateSession(await buildHydrateOpts(db, opts, { fresh: false }))
  })

  /**
   * Eager spawn entrypoint. Used by the renderer's "Restart" button after a
   * session ended — user wants a live subprocess immediately, not on the next
   * keystroke. Hydrates if needed, then `ensureSpawned`. Idempotent for live
   * sessions.
   */
  ipcMain.handle('chat:start', async (_, opts: ChatCreateOpts): Promise<ChatSessionInfo> => {
    hydrateSession(await buildHydrateOpts(db, opts, { fresh: false }))
    return ensureSpawned(opts.tabId)
  })

  ipcMain.handle('chat:send', async (_, tabId: string, text: string): Promise<boolean> => {
    // Lazy trigger: a `chat:send` is the canonical "spawn this subprocess now"
    // signal. ensureSpawned is idempotent + dedupes concurrent callers, so
    // simultaneous send + queue drain on the same tab share one spawn.
    try {
      await ensureSpawned(tabId)
    } catch (err) {
      console.error('[chat-handlers] ensureSpawned failed during chat:send:', err)
      return false
    }
    return sendUserMessage(tabId, text)
  })

  // Inline tool-answer flows (e.g. AskUserQuestion). Resolves the pending
  // tool_use_id with a tool_result content block so the SDK's turn machinery
  // sees a normal completion. Returns false when the adapter lacks a
  // structured-input channel — renderer falls back to chat:send.
  ipcMain.handle(
    'chat:sendToolResult',
    (
      _,
      tabId: string,
      args: { toolUseId: string; content: string; isError?: boolean }
    ): boolean => {
      return sendToolResult(tabId, args)
    }
  )

  // Reply to an inbound permission_request from the CLI (subtype:'can_use_tool',
  // surfaces under `--permission-prompt-tool stdio`). The renderer collected
  // the user's decision; this IPC writes the matching control_response so the
  // CLI unblocks the tool. AskUserQuestion uses `behavior:'allow'` with
  // `updatedInput.answers` populated; other tools the renderer decides
  // independently.
  ipcMain.handle(
    'chat:respondPermission',
    (
      _,
      tabId: string,
      args: {
        requestId: string
        decision:
          | {
              behavior: 'allow'
              updatedInput?: Record<string, unknown>
              updatedPermissions?: unknown[]
            }
          | { behavior: 'deny'; message: string; interrupt?: boolean }
      }
    ): boolean => {
      return respondToPermissionRequest(tabId, args)
    }
  )

  // Interrupt = stop the current turn but keep the session. Fast path: live
  // `interrupt` control_request preserves the warm subprocess + conversation
  // state. Fallback: kill + respawn with --resume (legacy path; SIGINT was
  // unreliable on claude-code per Spike C). The identity guard in the
  // transport's exit handler swallows the dying child's process-exit
  // broadcast on the fallback path so the renderer doesn't flash "Session
  // ended". Mirrors `chat:setMode`.
  ipcMain.handle('chat:interrupt', async (_, opts: ChatCreateOpts): Promise<ChatSessionInfo> => {
    // Persist interrupted marker FIRST so replay sees the turn boundary
    // regardless of which path resolves. recordInterrupted no-ops for
    // pre-spawn skeletons (nothing to interrupt).
    recordInterrupted(opts.tabId)

    // Fast path: control_request `interrupt` over stdin. Only applies to live
    // (spawned, not-ended) sessions; pre-spawn skeletons have no turn in flight.
    const liveState = getSessionTerminalState(opts.tabId)
    const liveInfo = getSessionInfo(opts.tabId)
    if (liveState && liveState !== 'not-spawned' && liveInfo && !liveInfo.ended) {
      try {
        await sendControlRequest(opts.tabId, { subtype: 'interrupt' })
        const refreshed = getSessionInfo(opts.tabId)
        if (refreshed) return refreshed
      } catch (err) {
        console.warn(
          '[chat-handlers] interrupt control_request failed, falling back to kill+respawn:',
          err
        )
        // fall through
      }
    }

    // Fallback: kill + respawn. Eager-spawn here mirrors the warm-subprocess
    // semantics of the control_request fast path — after interrupt the user
    // typically continues the turn immediately, so a ready process avoids the
    // double-latency of "interrupt → next send waits on spawn".
    removeSession(opts.tabId)
    hydrateSession(await buildHydrateOpts(db, opts, { fresh: false }))
    return ensureSpawned(opts.tabId)
  })

  // Stop-button / Esc path. Same kill+respawn as `chat:interrupt`, but if no
  // assistant progress arrived since the trailing user-message we cancel that
  // user-message instead of leaving an `interrupted` marker — Claude CLI parity
  // for "abort an unanswered turn and edit the prompt". Authoritative verdict
  // (`popped`) flows back to the caller so the renderer can restore the input.
  ipcMain.handle(
    'chat:abortAndPop',
    async (
      _,
      opts: ChatCreateOpts
    ): Promise<{
      popped: boolean
      text: string | null
    }> => {
      const result = popLastUserMessage(opts.tabId)
      if (!result.popped) recordInterrupted(opts.tabId)
      // Stop button discards queued follow-ups alongside the in-flight turn —
      // matches pre-backend behavior where handleStop did `setQueuedMessages([])`.
      try {
        await clearChatQueue(db, opts.tabId)
      } catch (err) {
        console.error('[chat-handlers] clearChatQueue failed:', err)
      }
      removeSession(opts.tabId)
      // Eager respawn after Stop matches Claude CLI parity — user just hit the
      // big red button on a turn, the implicit expectation is "ready to keep
      // chatting"; making them wait for spawn on next send is worse UX than the
      // lazy mode the rest of the app uses for first-ever messages.
      hydrateSession(await buildHydrateOpts(db, opts, { fresh: false }))
      await ensureSpawned(opts.tabId)
      return { popped: result.popped, text: result.text }
    }
  )

  ipcMain.handle('chat:kill', (_, tabId: string): void => {
    killChat(tabId)
  })

  ipcMain.handle('chat:remove', async (_, tabId: string): Promise<void> => {
    removeSession(tabId)
    // Tab is gone — drop persisted history + queue. (FK ON DELETE CASCADE
    // also clears them when the terminal_tabs row itself is deleted, but
    // chat:remove can be invoked before the tab row is gone, so be explicit.)
    try {
      await clearChatEventsForTab(db, tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatEventsForTab failed:', err)
    }
    try {
      await clearChatQueue(db, tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatQueue failed:', err)
    }
  })

  // Reset = atomic kill+wipe+spawn-fresh in a single IPC. Doing this client-side
  // (kill → remove → create across multiple awaits) opened a race window where the
  // old child's exit broadcast could leak between IPCs and stick "Session ended"
  // in the renderer. Inlining the whole sequence on the main side closes that
  // window: SIGTERM is sent + the session is removed from the map sync'ly, so any
  // exit event the OS later delivers is swallowed by the identity guard in
  // chat-transport-manager's child.on('exit') handler.
  /**
   * Atomic reset: kills the current session, wipes persisted history + queue +
   * stored conversation id, and re-hydrates a fresh skeleton in one IPC. The
   * fresh skeleton is `not-spawned` — no subprocess until the user's next
   * `chat:send`. Matches the lazy-spawn end-to-end semantics: nothing runs
   * until the user actually engages.
   */
  ipcMain.handle('chat:reset', async (_, opts: ChatCreateOpts): Promise<ChatSessionInfo> => {
    removeSession(opts.tabId)
    try {
      await clearChatEventsForTab(db, opts.tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatEventsForTab failed:', err)
    }
    try {
      await clearChatQueue(db, opts.tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatQueue failed:', err)
    }
    try {
      await clearChatConversationId(db, opts.taskId, opts.mode)
    } catch (err) {
      console.error('[chat-handlers] clearChatConversationId failed:', err)
    }
    return hydrateSession(await buildHydrateOpts(db, opts, { fresh: true }))
  })

  ipcMain.handle('chat:getBufferSince', (_, tabId: string, afterSeq: number) => {
    return getEventBufferSince(tabId, afterSeq)
  })

  ipcMain.handle('chat:getInfo', (_, tabId: string) => getSessionInfo(tabId))

  ipcMain.handle(
    'chat:inspectPermissions',
    async (
      _,
      taskId: string,
      mode: string
    ): Promise<ReturnType<typeof inspectPermissionFlags>> => {
      // codex-chat governs permissions through the JSON-RPC approval protocol,
      // not CLI flags — the flag-based safety check doesn't apply.
      if (mode === 'codex-chat') {
        return {
          ok: true,
          hasSkipPerms: false,
          hasPermissionMode: false,
          permissionModeValue: null
        }
      }
      const providerCfg = await readProviderConfig(db, taskId, mode)
      const flagsString = providerCfg.flags ?? (await readTaskModeDefaultFlags(db, mode)) ?? ''
      return inspectPermissionFlags(parseShellArgs(flagsString))
    }
  )

  ipcMain.handle('chat:getMode', async (_, taskId: string, mode: string): Promise<string> => {
    const cfg = await readProviderConfig(db, taskId, mode)
    const stored = cfg.chatMode ?? defaultChatModeForMode(mode)
    // Hide stale `auto` from UI when capability is gone — pill would otherwise
    // show violet, and the next mode change would attempt a forbidden flag.
    return resolveSafeChatMode(stored)
  })

  ipcMain.handle(
    'chat:getAutoEligibility',
    (): Promise<AutoModeEligibility> => getAutoModeEligibility()
  )

  ipcMain.handle(
    'chat:setMode',
    async (_, opts: ChatCreateOpts & { chatMode: string }): Promise<ChatSessionInfo> => {
      // Reject a mode that isn't valid for this terminal mode's vocabulary.
      if (!isValidChatModeForMode(opts.mode, opts.chatMode)) {
        throw new Error(`Invalid chat mode for mode ${opts.mode}: ${String(opts.chatMode)}`)
      }
      // Server-side guard: ignore `auto` when capability is missing. Renderer
      // already filters in the pill, but a stale renderer or a direct IPC call
      // shouldn't be able to persist a forbidden mode.
      const safe = await resolveSafeChatMode(opts.chatMode)

      // Pre-spawn fast path: skeleton session, no live subprocess to inform.
      // Just persist to DB + update the in-memory skeleton so the next spawn
      // picks it up via buildSpawnArgs. No control_request, no respawn.
      const liveState = getSessionTerminalState(opts.tabId)
      if (liveState === 'not-spawned') {
        await writeChatMode(db, opts.taskId, opts.mode, safe)
        updateSessionChatMode(opts.tabId, safe)
        const refreshed = getSessionInfo(opts.tabId)
        if (refreshed) return refreshed
        // Skeleton vanished between checks — fall through to re-hydrate path below.
      }

      // Fast path: live `set_permission_mode` control_request. Preserves the
      // warm subprocess + conversation state. For claude-chat this maps to a
      // CLI permission_mode value (bypass → null → fallback). For codex-chat
      // the runtime mode itself rides the control request — the driver applies
      // it to the next `turn/start`, no respawn.
      const cliMode = opts.mode === 'codex-chat' ? safe : chatModeToCliPermissionMode(safe)
      const liveInfo = getSessionInfo(opts.tabId)
      if (cliMode && liveState && liveState !== 'not-spawned' && liveInfo && !liveInfo.ended) {
        try {
          await sendControlRequest(opts.tabId, {
            subtype: 'set_permission_mode',
            mode: cliMode
          })
          await writeChatMode(db, opts.taskId, opts.mode, safe)
          updateSessionChatMode(opts.tabId, safe)
          const refreshed = getSessionInfo(opts.tabId)
          if (refreshed) return refreshed
        } catch (err) {
          console.warn(
            '[chat-handlers] set_permission_mode control_request failed, falling back to kill+respawn:',
            err
          )
          // fall through to respawn path below
        }
      }

      // Fallback: kill + respawn with new flags. Required for `bypass` (uses
      // --allow-dangerously-skip-permissions, no live equivalent) and as a
      // safety net when the control channel rejects/times out. Transactional:
      // spawn first, persist DB after spawn succeeds. chatModeOverride bypasses
      // DB read so the new child uses `safe` flags even though provider_config
      // still has the old value.
      removeSession(opts.tabId)
      hydrateSession(await buildHydrateOpts(db, opts, { fresh: false, chatModeOverride: safe }))
      const created = await ensureSpawned(opts.tabId)
      await writeChatMode(db, opts.taskId, opts.mode, safe)
      // Returned ChatSessionInfo carries `chatMode: safe` via Session.chatMode,
      // so renderer trusts the server's resolved value (e.g. auto → auto-accept
      // downgrade) instead of its optimistic guess.
      return created
    }
  )

  ipcMain.handle('chat:getModel', async (_, taskId: string, mode: string): Promise<string> => {
    const cfg = await readProviderConfig(db, taskId, mode)
    const stored = cfg.chatModel
    if (isValidModelForMode(mode, stored)) return stored
    // No (or legacy/invalid) stored value → provider default. codex-chat uses
    // its own default; claude-chat resolves the account default from
    // `~/.claude/settings.json` (Pro → sonnet, Max → opus, …).
    if (mode === 'codex-chat') return defaultModelForMode(mode)
    return resolveAccountDefaultModel()
  })

  ipcMain.handle(
    'chat:setModel',
    async (_, opts: ChatCreateOpts & { chatModel: string }): Promise<ChatSessionInfo> => {
      if (!isValidModelForMode(opts.mode, opts.chatModel)) {
        throw new Error(`Invalid chat model for mode ${opts.mode}: ${String(opts.chatModel)}`)
      }

      // Pre-spawn fast path: DB write + skeleton mutation only.
      const liveState = getSessionTerminalState(opts.tabId)
      if (liveState === 'not-spawned') {
        await writeChatModel(db, opts.taskId, opts.mode, opts.chatModel)
        updateSessionChatModel(opts.tabId, opts.chatModel)
        const refreshed = getSessionInfo(opts.tabId)
        if (refreshed) return refreshed
      }

      // Fast path: `set_model` control_request — preserves warm subprocess +
      // conversation state. Same shape as `chat:setMode` (subtype
      // set_permission_mode). The CLI accepts the chat model alias directly
      // (`opus`/`sonnet`/`haiku`) on `--model`; protocol mirrors that.
      const liveInfo = getSessionInfo(opts.tabId)
      if (liveState && liveState !== 'not-spawned' && liveInfo && !liveInfo.ended) {
        try {
          await sendControlRequest(opts.tabId, {
            subtype: 'set_model',
            model: opts.chatModel
          })
          await writeChatModel(db, opts.taskId, opts.mode, opts.chatModel)
          updateSessionChatModel(opts.tabId, opts.chatModel)
          const refreshed = getSessionInfo(opts.tabId)
          if (refreshed) return refreshed
        } catch (err) {
          console.warn(
            '[chat-handlers] set_model control_request failed, falling back to kill+respawn:',
            err
          )
          // fall through
        }
      }

      // Fallback: kill + respawn. chatModelOverride bypasses DB so the new
      // child uses the requested model before we persist.
      removeSession(opts.tabId)
      hydrateSession(
        await buildHydrateOpts(db, opts, { fresh: false, chatModelOverride: opts.chatModel })
      )
      const created = await ensureSpawned(opts.tabId)
      await writeChatModel(db, opts.taskId, opts.mode, opts.chatModel)
      return created
    }
  )

  ipcMain.handle(
    'chat:getEffort',
    async (_, taskId: string, mode: string): Promise<ChatEffort | null> => {
      const cfg = await readProviderConfig(db, taskId, mode)
      const stored = cfg.chatEffort ?? null
      return isChatEffort(stored) ? stored : null
    }
  )

  ipcMain.handle(
    'chat:setEffort',
    async (_, opts: ChatCreateOpts & { chatEffort: ChatEffort }): Promise<ChatSessionInfo> => {
      if (!isChatEffort(opts.chatEffort)) {
        throw new Error(`Invalid chat effort: ${String(opts.chatEffort)}`)
      }
      // Pre-spawn: DB write + skeleton mutation. Effort flag takes effect on
      // first spawn via buildSpawnArgs reading the (now-updated) skeleton.
      const liveState = getSessionTerminalState(opts.tabId)
      if (liveState === 'not-spawned') {
        await writeChatEffort(db, opts.taskId, opts.mode, opts.chatEffort)
        updateSessionChatEffort(opts.tabId, opts.chatEffort)
        const refreshed = getSessionInfo(opts.tabId)
        if (refreshed) return refreshed
      }
      // Same kill+respawn pattern as chat:setMode/setModel — effort flag only
      // takes effect on a fresh process. chatEffortOverride bypasses DB so the
      // new child uses the requested level before we persist.
      removeSession(opts.tabId)
      hydrateSession(
        await buildHydrateOpts(db, opts, { fresh: false, chatEffortOverride: opts.chatEffort })
      )
      const created = await ensureSpawned(opts.tabId)
      await writeChatEffort(db, opts.taskId, opts.mode, opts.chatEffort)
      return created
    }
  )

  ipcMain.handle(
    'chat:getCollaboration',
    async (_, taskId: string, mode: string): Promise<ChatCollaborationMode | null> => {
      if (!modeSupportsCollaboration(mode)) return null
      const cfg = await readProviderConfig(db, taskId, mode)
      const stored = cfg.chatCollaboration ?? null
      return isChatCollaborationMode(stored) ? stored : null
    }
  )

  ipcMain.handle(
    'chat:setCollaboration',
    async (
      _,
      opts: ChatCreateOpts & { chatCollaboration: ChatCollaborationMode }
    ): Promise<ChatSessionInfo> => {
      if (!isChatCollaborationMode(opts.chatCollaboration)) {
        throw new Error(`Invalid chat collaboration mode: ${String(opts.chatCollaboration)}`)
      }
      if (!modeSupportsCollaboration(opts.mode)) {
        throw new Error(`Collaboration mode not supported for "${opts.mode}"`)
      }
      // Pre-spawn: DB write + skeleton mutation. The collaboration mode is read
      // off the skeleton when the first spawn builds the driver context.
      const liveState = getSessionTerminalState(opts.tabId)
      if (liveState === 'not-spawned') {
        await writeChatCollaboration(db, opts.taskId, opts.mode, opts.chatCollaboration)
        updateSessionChatCollaboration(opts.tabId, opts.chatCollaboration)
        const refreshed = getSessionInfo(opts.tabId)
        if (refreshed) return refreshed
      }
      // Live session: kill+respawn (same pattern as chat:setEffort). Codex
      // applies `collaborationMode` per `turn/start`, but a respawn keeps the
      // thread cleanly re-initialized on the new mode.
      removeSession(opts.tabId)
      hydrateSession(
        await buildHydrateOpts(db, opts, {
          fresh: false,
          chatCollaborationOverride: opts.chatCollaboration
        })
      )
      const created = await ensureSpawned(opts.tabId)
      await writeChatCollaboration(db, opts.taskId, opts.mode, opts.chatCollaboration)
      return created
    }
  )

  ipcMain.handle('chat:getFastMode', async (_, taskId: string, mode: string): Promise<boolean> => {
    if (!modeSupportsFastMode(mode)) return false
    const cfg = await readProviderConfig(db, taskId, mode)
    return cfg.chatFastMode ?? false
  })

  ipcMain.handle(
    'chat:setFastMode',
    async (
      _,
      opts: ChatCreateOpts & { chatFastMode: boolean }
    ): Promise<ChatSessionInfo> => {
      if (typeof opts.chatFastMode !== 'boolean') {
        throw new Error(`Invalid chat fast mode: ${String(opts.chatFastMode)}`)
      }
      if (!modeSupportsFastMode(opts.mode)) {
        throw new Error(`Fast mode not supported for "${opts.mode}"`)
      }
      // Pre-spawn: DB write + skeleton mutation. The next spawn reads it off
      // the skeleton when building the driver context.
      const liveState = getSessionTerminalState(opts.tabId)
      if (liveState === 'not-spawned') {
        await writeChatFastMode(db, opts.taskId, opts.mode, opts.chatFastMode)
        updateSessionChatFastMode(opts.tabId, opts.chatFastMode)
        const refreshed = getSessionInfo(opts.tabId)
        if (refreshed) return refreshed
      }
      // Live session: kill+respawn (same pattern as chat:setEffort).
      removeSession(opts.tabId)
      hydrateSession(
        await buildHydrateOpts(db, opts, {
          fresh: false,
          chatFastModeOverride: opts.chatFastMode
        })
      )
      const created = await ensureSpawned(opts.tabId)
      await writeChatFastMode(db, opts.taskId, opts.mode, opts.chatFastMode)
      return created
    }
  )

  ipcMain.handle('chat:listSkills', async (_, cwd: string): Promise<SkillInfo[]> => {
    return listSkills(cwd)
  })

  ipcMain.handle('chat:listCommands', async (_, cwd: string): Promise<CommandInfo[]> => {
    return listCommands(cwd)
  })

  ipcMain.handle('chat:listAgents', async (_, cwd: string): Promise<AgentInfo[]> => {
    return listAgents(cwd)
  })

  ipcMain.handle(
    'chat:listFiles',
    async (_, cwd: string, query: string, limit?: number): Promise<FileMatch[]> => {
      return listProjectFiles(cwd, query, limit ?? 50)
    }
  )

  ipcMain.handle(
    'chat:bumpAutocompleteUsage',
    async (_, source: string, name: string): Promise<void> => {
      try {
        await bumpAutocompleteUsage(db, source, name)
      } catch (err) {
        console.error('[chat-handlers] bumpAutocompleteUsage failed:', err)
      }
    }
  )

  ipcMain.handle('chat:getAutocompleteUsage', async (): Promise<UsageMap> => {
    try {
      return await getAutocompleteUsage(db)
    } catch (err) {
      console.error('[chat-handlers] getAutocompleteUsage failed:', err)
      return {}
    }
  })
}

/** Call on app quit to reap child processes. */
export function shutdownChatTransports(opts?: ShutdownOptions): Promise<TransportShutdownResult> {
  return shutdownAll(opts)
}

/** Test/reset helper: kill chats without entering app-shutdown mode. */
export function killAllChatTransports(): void {
  killAll()
}
