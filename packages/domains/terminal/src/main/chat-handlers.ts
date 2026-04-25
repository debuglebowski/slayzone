import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import {
  createChat,
  sendUserMessage,
  kill as killChat,
  interrupt as interruptChat,
  removeSession,
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
} from './chat-events-store'
import { parseShellArgs } from './adapters/flag-parser'
import { buildMcpEnv } from './mcp-env'
import { getEnrichedPath } from './shell-env'
import { supportsChatMode } from './agents/registry'
import { listSkills } from './skills'
import { listCommands } from './commands'
import { listAgents } from './agents-registry'
import { listProjectFiles } from './files-scan'
import type { SkillInfo, CommandInfo, AgentInfo, FileMatch } from '../shared/types'
import type { AgentEvent } from '../shared/agent-events'

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

export function registerChatHandlers(ipcMain: IpcMain, db: Database, opts: ChatHandlerOpts = {}): void {
  // Wire SQLite persistence into the transport. Default deps had a no-op
  // persistEvent; configureTransport keeps spawn/whichBinary/broadcast* untouched.
  configureTransport({
    persistEvent: (tabId, seq, event) => {
      try {
        persistChatEvent(db, tabId, seq, event)
      } catch (err) {
        console.error('[chat-handlers] persistChatEvent failed:', err)
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

  ipcMain.handle('chat:supports', (_, mode: string): boolean => supportsChatMode(mode))

  ipcMain.handle('chat:create', async (_, opts: ChatCreateOpts): Promise<ChatSessionInfo> => {
    const providerCfg = readProviderConfig(db, opts.taskId, opts.mode)
    const flagsString =
      opts.providerFlagsOverride ??
      providerCfg.flags ??
      readTaskModeDefaultFlags(db, opts.mode) ??
      ''
    const providerFlags = parseShellArgs(flagsString)

    // Restore persisted history so chat panel re-fills immediately after app reload.
    // Empty arrays for fresh tabs — no extra cost, single SELECT each.
    const initialBuffer = loadChatEvents(db, opts.tabId)
    const initialNextSeq = getNextSeqForTab(db, opts.tabId)

    // Match PTY behavior: chat SDK subprocess + its nested Bash tool need the user's
    // enriched PATH so they find pnpm/nvm/asdf-installed binaries (slay, node, etc).
    // Electron's bare PATH would otherwise hide them.
    const enrichedPath = getEnrichedPath()
    const subprocessEnv: Record<string, string> = {
      ...buildMcpEnv(db, opts.taskId),
      ...(enrichedPath ? { PATH: enrichedPath } : {}),
    }

    const info = await createChat({
      tabId: opts.tabId,
      taskId: opts.taskId,
      mode: opts.mode,
      cwd: opts.cwd,
      conversationId: providerCfg.chatConversationId ?? null,
      providerFlags,
      env: subprocessEnv,
      initialBuffer,
      initialNextSeq,
      onPersistSessionId: (id) => {
        writeChatConversationId(db, opts.taskId, opts.mode, id)
      },
      onInvalidResume: () => {
        clearChatConversationId(db, opts.taskId, opts.mode)
      },
    })
    return info
  })

  ipcMain.handle('chat:send', (_, tabId: string, text: string): boolean => {
    return sendUserMessage(tabId, text)
  })

  ipcMain.handle('chat:interrupt', (_, tabId: string): void => {
    interruptChat(tabId)
  })

  ipcMain.handle('chat:kill', (_, tabId: string): void => {
    killChat(tabId)
  })

  ipcMain.handle('chat:remove', (_, tabId: string): void => {
    removeSession(tabId)
    // Tab is gone — drop persisted history. (FK ON DELETE CASCADE also clears
    // it when the terminal_tabs row itself is deleted, but chat:remove can be
    // invoked before the tab row is gone, so be explicit.)
    try {
      clearChatEventsForTab(db, tabId)
    } catch (err) {
      console.error('[chat-handlers] clearChatEventsForTab failed:', err)
    }
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
}

/** Call on app quit to reap child processes. */
export function shutdownChatTransports(): void {
  killAll()
}
