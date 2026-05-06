import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import {
  createChat,
  sendUserMessage,
  sendToolResult,
  sendControlRequest,
  respondToPermissionRequest,
  updateSessionChatMode,
  updateSessionChatModel,
  kill as killChat,
  removeSession,
  recordInterrupted,
  popLastUserMessage,
  getEventBufferSince,
  getSessionInfo,
  killAll,
  configureTransport,
  type ChatSessionInfo,
} from './chat-transport-manager'
import {
  persistChatEvent,
  loadChatEvents,
  getNextSeqForTab,
  clearChatEventsForTab,
} from '../server/chat-events-store'
import { registerChatQueueHandlers } from './chat-queue-handlers'
import { clearChatQueue } from '../server/chat-queue-store'
import { notifyGlobalStateListeners } from './pty-manager'
import { parseShellArgs } from '../server/adapters/flag-parser'
import { buildMcpEnv } from '../server/mcp-env'
import { getEnrichedPath } from '../server/shell-env'
import { supportsChatMode } from '../server/agents/registry'
import { getAutoModeEligibility, type AutoModeEligibility } from '../server/auto-mode-eligibility'
import { resolveAccountDefaultModel } from '../server/account-default-model'
import { listSkills } from '../server/skills'
import { listCommands } from '../server/commands'
import { listAgents } from '../server/agents-registry'
import { listProjectFiles } from '../server/files-scan'
import { bumpAutocompleteUsage, getAutocompleteUsage, type UsageMap } from '../server/autocomplete-usage-store'
import type { SkillInfo, CommandInfo, AgentInfo, FileMatch } from '../shared/types'
import type { AgentEvent } from '../shared/agent-events'
import {
  rawPermissionModeToChatMode,
  chatModeToFlags as chatModeToFlagsShared,
  chatModeToCliPermissionMode,
  type ChatMode as ChatModeShared,
} from '../shared/chat-mode'
import { chatModelToFlags, isChatModel, type ChatModel } from '../shared/chat-model'
import { chatEffortToFlags, isChatEffort, type ChatEffort } from '../shared/chat-effort'

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
async function resolveSafeChatMode(stored: ChatMode): Promise<ChatMode> {
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
  /** Chat permission/operating mode. See `ChatMode`. */
  chatMode?: ChatMode | null
  /** Claude model alias for chat. See `ChatModel`. */
  chatModel?: ChatModel | null
  /** Reasoning effort level. `null`/missing = inherit provider default. */
  chatEffort?: ChatEffort | null
}

function readProviderConfig(db: Database, taskId: string, mode: string): ProviderConfigEntry {
  const row = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
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

function writeChatConversationId(db: Database, taskId: string, mode: string, id: string): void {
  const row = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
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
  db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?').run(JSON.stringify(cfg), taskId)
}

function writeChatModel(db: Database, taskId: string, mode: string, chatModel: ChatModel): void {
  const row = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
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
  db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?').run(JSON.stringify(cfg), taskId)
}

function writeChatEffort(db: Database, taskId: string, mode: string, chatEffort: ChatEffort | null): void {
  const row = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
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
  db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?').run(JSON.stringify(cfg), taskId)
}

function writeChatMode(db: Database, taskId: string, mode: string, chatMode: ChatMode): void {
  const row = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
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
  db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?').run(JSON.stringify(cfg), taskId)
}


/**
 * One-shot backfill: every chat-capable task gets `chatMode='bypass'` set on
 * its terminal_mode entry — preserving current default behavior
 * (`--allow-dangerously-skip-permissions`) for pre-upgrade tasks. New tasks
 * created after this migration runs get `auto-accept` by default via
 * `buildCreateOpts`.
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
export function backfillChatModes(db: Database): { scanned: number; updated: number } {
  const rows = db.prepare('SELECT id, terminal_mode, provider_config FROM tasks').all() as
    | { id: string; terminal_mode: string | null; provider_config: string | null }[]
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
    // Patch existing entries.
    for (const mode of Object.keys(cfg)) {
      const entry = cfg[mode]
      if (!entry || entry.chatMode != null) continue
      cfg[mode] = { ...entry, chatMode: DEFAULT_CHAT_MODE_LEGACY }
      dirty = true
    }
    // Ensure the task's primary terminal_mode has an entry if it's chat-capable.
    if (row.terminal_mode && supportsChatMode(row.terminal_mode) && cfg[row.terminal_mode]?.chatMode == null) {
      cfg[row.terminal_mode] = { ...(cfg[row.terminal_mode] ?? {}), chatMode: DEFAULT_CHAT_MODE_LEGACY }
      dirty = true
    }
    if (dirty) {
      db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?').run(JSON.stringify(cfg), row.id)
      updated++
    }
  }
  return { scanned, updated }
}

function clearChatConversationId(db: Database, taskId: string, mode: string): void {
  const row = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
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
  db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?').run(JSON.stringify(cfg), taskId)
}

function readTaskModeDefaultFlags(db: Database, mode: string): string | null {
  const row = db.prepare('SELECT default_flags FROM terminal_modes WHERE id = ?').get(mode) as
    | { default_flags: string | null }
    | undefined
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
  const modeIsPermissive = permissionModeValue ? permissiveModes.includes(permissionModeValue) : false
  return {
    ok: hasSkipPerms || modeIsPermissive,
    hasSkipPerms,
    hasPermissionMode,
    permissionModeValue,
  }
}

/**
 * Shared opts builder for `chat:create` + `chat:reset` + `chat:setMode`.
 *
 * `fresh: true` forces a new session id (skips --resume) — used by reset to
 * guarantee a clean thread regardless of whatever was previously stored. PATH
 * enrichment + MCP env are identical across both paths, so factoring here
 * prevents drift.
 *
 * `chatModeOverride` short-circuits the DB lookup of provider_config.chatMode —
 * used by `chat:setMode` so the spawn flags reflect the user's intent before
 * the DB cache is updated. Lets us run the DB write *after* spawn succeeds
 * (transactional) without a race where buildCreateOpts re-reads stale DB.
 */
async function buildCreateOpts(
  db: Database,
  opts: ChatCreateOpts,
  { fresh, chatModeOverride, chatModelOverride, chatEffortOverride }: { fresh: boolean; chatModeOverride?: ChatMode; chatModelOverride?: ChatModel; chatEffortOverride?: ChatEffort | null }
): Promise<Parameters<typeof createChat>[0]> {
  const providerCfg = readProviderConfig(db, opts.taskId, opts.mode)
  // Flag-resolution priority for chat:
  //   1. per-call override (`providerFlagsOverride`)
  //   2. per-task explicit flags (`providerCfg.flags`)
  //   3. chatMode (override > DB-cached > default)
  // terminal_modes default_flags is intentionally NOT consulted for chat — chat owns
  // its own permission UX through chatMode. Terminal still uses default_flags.
  let providerFlags: string[]
  let resolvedChatMode: ChatMode | null = null
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
    const stored = providerCfg.chatMode ?? DEFAULT_CHAT_MODE_NEW_TASK
    resolvedChatMode = await resolveSafeChatMode(stored)
    providerFlags = chatModeToFlags(resolvedChatMode)
  }

  // Append --model when set. Override > stored > default. providerFlags from
  // explicit `flags` may already contain --model; we don't dedupe — that path
  // is power-user override and the chat model dropdown is hidden behind the
  // chatModel field. When `flags` is set, chatModel is not appended (the
  // explicit flag string is the source of truth).
  const storedChatModel = isChatModel(providerCfg.chatModel) ? providerCfg.chatModel : null
  const resolvedChatModel: ChatModel =
    chatModelOverride ?? storedChatModel ?? (await resolveAccountDefaultModel())
  const resolvedChatEffort: ChatEffort | null =
    chatEffortOverride !== undefined ? chatEffortOverride : (providerCfg.chatEffort ?? null)
  const usedExplicitFlags = !chatModeOverride && (opts.providerFlagsOverride || providerCfg.flags)
  if (!usedExplicitFlags) {
    providerFlags = [...providerFlags, ...chatModelToFlags(resolvedChatModel)]
    providerFlags = [...providerFlags, ...chatEffortToFlags(resolvedChatEffort)]
  }

  const initialBuffer = fresh ? [] : loadChatEvents(db, opts.tabId)
  const initialNextSeq = fresh ? 0 : getNextSeqForTab(db, opts.tabId)

  const enrichedPath = getEnrichedPath()
  const subprocessEnv: Record<string, string> = {
    ...buildMcpEnv(db, opts.taskId),
    ...(enrichedPath ? { PATH: enrichedPath } : {}),
  }

  return {
    tabId: opts.tabId,
    taskId: opts.taskId,
    mode: opts.mode,
    cwd: opts.cwd,
    conversationId: fresh ? null : providerCfg.chatConversationId ?? null,
    providerFlags,
    env: subprocessEnv,
    initialBuffer,
    initialNextSeq,
    chatMode: resolvedChatMode,
    chatModel: resolvedChatModel,
    chatEffort: resolvedChatEffort,
    onPersistSessionId: (id) => {
      writeChatConversationId(db, opts.taskId, opts.mode, id)
    },
    onInvalidResume: () => {
      clearChatConversationId(db, opts.taskId, opts.mode)
    },
  }
}

export function registerChatHandlers(ipcMain: IpcMain, db: Database, opts: ChatHandlerOpts = {}): void {
  // Wire SQLite persistence into the transport. Default deps had a no-op
  // persistEvent; configureTransport keeps spawn/whichBinary/broadcast* untouched.
  configureTransport({
    onStateChange: notifyGlobalStateListeners,
    persistEvent: (tabId, seq, event) => {
      try {
        persistChatEvent(db, tabId, seq, event)
      } catch (err) {
        console.error('[chat-handlers] persistChatEvent failed:', err)
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
              writeChatMode(db, info.taskId, info.mode, mapped)
            } catch (err) {
              console.error('[chat-handlers] writeChatMode (live sync) failed:', err)
            }
          }
        }
      }
      if (opts.onChatEvent) {
        try {
          opts.onChatEvent(tabId, event)
        } catch (err) {
          console.error('[chat-handlers] onChatEvent failed:', err)
        }
      }
    },
  })

  registerChatQueueHandlers(ipcMain, db)

  ipcMain.handle('chat:supports', (_, mode: string): boolean => supportsChatMode(mode))

  ipcMain.handle('chat:create', async (_, opts: ChatCreateOpts): Promise<ChatSessionInfo> => {
    return createChat(await buildCreateOpts(db, opts, { fresh: false }))
  })

  ipcMain.handle('chat:send', (_, tabId: string, text: string): boolean => {
    return sendUserMessage(tabId, text)
  })

  // Inline tool-answer flows (e.g. AskUserQuestion). Resolves the pending
  // tool_use_id with a tool_result content block so the SDK's turn machinery
  // sees a normal completion. Returns false when the adapter lacks a
  // structured-input channel — renderer falls back to chat:send.
  ipcMain.handle(
    'chat:sendToolResult',
    (_, tabId: string, args: { toolUseId: string; content: string; isError?: boolean }): boolean => {
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
          | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
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
    // regardless of which path resolves.
    recordInterrupted(opts.tabId)

    // Fast path: control_request `interrupt` over stdin.
    const liveInfo = getSessionInfo(opts.tabId)
    if (liveInfo && !liveInfo.ended) {
      try {
        await sendControlRequest(opts.tabId, { subtype: 'interrupt' })
        const refreshed = getSessionInfo(opts.tabId)
        if (refreshed) return refreshed
      } catch (err) {
        console.warn('[chat-handlers] interrupt control_request failed, falling back to kill+respawn:', err)
        // fall through
      }
    }

    // Fallback: kill + respawn.
    removeSession(opts.tabId)
    return createChat(await buildCreateOpts(db, opts, { fresh: false }))
  })

  // Stop-button / Esc path. Same kill+respawn as `chat:interrupt`, but if no
  // assistant progress arrived since the trailing user-message we cancel that
  // user-message instead of leaving an `interrupted` marker — Claude CLI parity
  // for "abort an unanswered turn and edit the prompt". Authoritative verdict
  // (`popped`) flows back to the caller so the renderer can restore the input.
  ipcMain.handle('chat:abortAndPop', async (_, opts: ChatCreateOpts): Promise<{
    popped: boolean
    text: string | null
  }> => {
    const result = popLastUserMessage(opts.tabId)
    if (!result.popped) recordInterrupted(opts.tabId)
    // Stop button discards queued follow-ups alongside the in-flight turn —
    // matches pre-backend behavior where handleStop did `setQueuedMessages([])`.
    try {
      clearChatQueue(db, opts.tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatQueue failed:', err)
    }
    removeSession(opts.tabId)
    await createChat(await buildCreateOpts(db, opts, { fresh: false }))
    return { popped: result.popped, text: result.text }
  })

  ipcMain.handle('chat:kill', (_, tabId: string): void => {
    killChat(tabId)
  })

  ipcMain.handle('chat:remove', (_, tabId: string): void => {
    removeSession(tabId)
    // Tab is gone — drop persisted history + queue. (FK ON DELETE CASCADE
    // also clears them when the terminal_tabs row itself is deleted, but
    // chat:remove can be invoked before the tab row is gone, so be explicit.)
    try {
      clearChatEventsForTab(db, tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatEventsForTab failed:', err)
    }
    try {
      clearChatQueue(db, tabId)
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
  ipcMain.handle('chat:reset', async (_, opts: ChatCreateOpts): Promise<ChatSessionInfo> => {
    removeSession(opts.tabId)
    try {
      clearChatEventsForTab(db, opts.tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatEventsForTab failed:', err)
    }
    try {
      clearChatQueue(db, opts.tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatQueue failed:', err)
    }
    try {
      clearChatConversationId(db, opts.taskId, opts.mode)
    } catch (err) {
      console.error('[chat-handlers] clearChatConversationId failed:', err)
    }
    return createChat(await buildCreateOpts(db, opts, { fresh: true }))
  })

  ipcMain.handle('chat:getBufferSince', (_, tabId: string, afterSeq: number) => {
    return getEventBufferSince(tabId, afterSeq)
  })

  ipcMain.handle('chat:getInfo', (_, tabId: string) => getSessionInfo(tabId))

  ipcMain.handle(
    'chat:inspectPermissions',
    (_, taskId: string, mode: string): ReturnType<typeof inspectPermissionFlags> => {
      const providerCfg = readProviderConfig(db, taskId, mode)
      const flagsString =
        providerCfg.flags ?? readTaskModeDefaultFlags(db, mode) ?? ''
      return inspectPermissionFlags(parseShellArgs(flagsString))
    }
  )

  ipcMain.handle(
    'chat:getMode',
    async (_, taskId: string, mode: string): Promise<ChatMode> => {
      const cfg = readProviderConfig(db, taskId, mode)
      const stored = cfg.chatMode ?? DEFAULT_CHAT_MODE_NEW_TASK
      // Hide stale `auto` from UI when capability is gone — pill would otherwise
      // show violet, and the next mode change would attempt a forbidden flag.
      return resolveSafeChatMode(stored)
    }
  )

  ipcMain.handle(
    'chat:getAutoEligibility',
    (): Promise<AutoModeEligibility> => getAutoModeEligibility()
  )


  ipcMain.handle(
    'chat:setMode',
    async (_, opts: ChatCreateOpts & { chatMode: ChatMode }): Promise<ChatSessionInfo> => {
      // Server-side guard: ignore `auto` when capability is missing. Renderer
      // already filters in the pill, but a stale renderer or a direct IPC call
      // shouldn't be able to persist a forbidden mode.
      const safe = await resolveSafeChatMode(opts.chatMode)

      // Fast path: live `set_permission_mode` control_request. Preserves the
      // warm subprocess + conversation state. Only available when the live
      // session has a control channel AND the target maps to a CLI
      // permission_mode value (bypass uses a separate flag → null → fallback).
      const cliMode = chatModeToCliPermissionMode(safe)
      const liveInfo = getSessionInfo(opts.tabId)
      if (cliMode && liveInfo && !liveInfo.ended) {
        try {
          await sendControlRequest(opts.tabId, {
            subtype: 'set_permission_mode',
            mode: cliMode,
          })
          writeChatMode(db, opts.taskId, opts.mode, safe)
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
      // spawn first, persist DB after spawn succeeds. If createChat throws, DB
      // stays at previous mode. chatModeOverride bypasses DB read so the new
      // child uses `safe` flags even though provider_config still has the old
      // value.
      removeSession(opts.tabId)
      const created = await createChat(
        await buildCreateOpts(db, opts, { fresh: false, chatModeOverride: safe })
      )
      writeChatMode(db, opts.taskId, opts.mode, safe)
      // Returned ChatSessionInfo carries `chatMode: safe` via Session.chatMode,
      // so renderer trusts the server's resolved value (e.g. auto → auto-accept
      // downgrade) instead of its optimistic guess.
      return created
    }
  )

  ipcMain.handle(
    'chat:getModel',
    async (_, taskId: string, mode: string): Promise<ChatModel> => {
      const cfg = readProviderConfig(db, taskId, mode)
      const stored = cfg.chatModel
      if (isChatModel(stored)) return stored
      // No (or legacy/invalid) stored value → fall back to account default
      // resolved from `~/.claude/settings.json`. Pro accounts → sonnet,
      // Max accounts → opus, etc. Hard fallback DEFAULT_CHAT_MODEL.
      return resolveAccountDefaultModel()
    }
  )

  ipcMain.handle(
    'chat:setModel',
    async (_, opts: ChatCreateOpts & { chatModel: ChatModel }): Promise<ChatSessionInfo> => {
      if (!isChatModel(opts.chatModel)) {
        throw new Error(`Invalid chat model: ${String(opts.chatModel)}`)
      }

      // Fast path: `set_model` control_request — preserves warm subprocess +
      // conversation state. Same shape as `chat:setMode` (subtype
      // set_permission_mode). The CLI accepts the chat model alias directly
      // (`opus`/`sonnet`/`haiku`) on `--model`; protocol mirrors that.
      const liveInfo = getSessionInfo(opts.tabId)
      if (liveInfo && !liveInfo.ended) {
        try {
          await sendControlRequest(opts.tabId, {
            subtype: 'set_model',
            model: opts.chatModel,
          })
          writeChatModel(db, opts.taskId, opts.mode, opts.chatModel)
          updateSessionChatModel(opts.tabId, opts.chatModel)
          const refreshed = getSessionInfo(opts.tabId)
          if (refreshed) return refreshed
        } catch (err) {
          console.warn('[chat-handlers] set_model control_request failed, falling back to kill+respawn:', err)
          // fall through
        }
      }

      // Fallback: kill + respawn. chatModelOverride bypasses DB so the new
      // child uses the requested model before we persist.
      removeSession(opts.tabId)
      const created = await createChat(
        await buildCreateOpts(db, opts, { fresh: false, chatModelOverride: opts.chatModel })
      )
      writeChatModel(db, opts.taskId, opts.mode, opts.chatModel)
      return created
    }
  )

  ipcMain.handle(
    'chat:getEffort',
    (_, taskId: string, mode: string): ChatEffort | null => {
      const cfg = readProviderConfig(db, taskId, mode)
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
      // Same kill+respawn pattern as chat:setMode/setModel — effort flag only
      // takes effect on a fresh process. chatEffortOverride bypasses DB so the
      // new child uses the requested level before we persist.
      removeSession(opts.tabId)
      const created = await createChat(
        await buildCreateOpts(db, opts, { fresh: false, chatEffortOverride: opts.chatEffort })
      )
      writeChatEffort(db, opts.taskId, opts.mode, opts.chatEffort)
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
    (_, source: string, name: string): void => {
      try {
        bumpAutocompleteUsage(db, source, name)
      } catch (err) {
        console.error('[chat-handlers] bumpAutocompleteUsage failed:', err)
      }
    }
  )

  ipcMain.handle(
    'chat:getAutocompleteUsage',
    (): UsageMap => {
      try {
        return getAutocompleteUsage(db)
      } catch (err) {
        console.error('[chat-handlers] getAutocompleteUsage failed:', err)
        return {}
      }
    }
  )
}

/** Call on app quit to reap child processes. */
export function shutdownChatTransports(): void {
  killAll()
}
