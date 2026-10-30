/**
 * What a chat provider can do, asked by the chat UI instead of checking
 * "is this Claude?". One entry per chat mode; a mode not listed gets nothing.
 * Codex gains them as its chat catches up (Codex chat plan, X1/X2).
 *
 * Features gated on the data a provider reports (e.g. the context meter,
 * which only renders when results carry a context window) don't need an
 * entry here.
 *
 * @module shared/chat-capabilities
 */

export interface ChatCapabilities {
  /**
   * The provider runs its own slash commands from raw `/name args` user text
   * and advertises their names. The composer then passes unknown `/name` text
   * through on Enter, and Enter on an exactly typed command sends that text.
   */
  nativeSlashCommands: boolean
  /** The composer recalls the task's earlier prompts (↑/↓, Ctrl+R) and chat sends are recorded for it. */
  promptHistory: boolean
  /**
   * Every permission request, question and plan approval is answered from a
   * prompt card (the prompt dock), with the TUI's options and wording.
   */
  promptCards: boolean
  /**
   * Stop / Esc interrupts the running turn over the control channel and the
   * agent process stays (a restart is only the fallback). Without it Stop
   * replaces the process.
   */
  liveInterrupt: boolean
  /** Reasoning effort changes on the running process (no restart). */
  liveEffort: boolean
  /** A past message can be edited & resent, or the conversation (and code) rewound to it. */
  rewind: boolean
  /** A new conversation can branch off a past message; the original stays as it is. */
  fork: boolean
  /** The task's earlier conversations can be listed and resumed (the Sessions picker). */
  sessions: boolean
  /** The conversation can move between this chat and the provider's terminal UI. */
  handoff: boolean
  /**
   * How attached files reach the agent: `blocks` — images, PDFs and text files
   * as content blocks built from artifact references at write time; `paths` —
   * images only, as `![name](/abs/path)` lines in the text (the agent reads them).
   */
  attachments: 'blocks' | 'paths'
  /** The composer's draft (text + attachments) and the timeline's scroll position survive remounts and reloads, per tab. */
  restoreComposerState: boolean
  /** Queued messages can be edited (held while editing) and reordered. */
  editableQueue: boolean
  /**
   * Which files the agent's own file tools changed: a summary row at the end of
   * each turn and a files-changed panel with one combined diff per file.
   */
  filesChanged: boolean
  /** A line of a diff can be commented on; the comment goes into the next message. */
  diffComments: boolean
  /** The chat's actions are in the app's Cmd+K palette while the tab is active. */
  commandPalette: boolean
  /** `/compact` compacts the conversation: the chat offers Compact (Cmd+K, the `/` menu). */
  compact: boolean
  /**
   * The provider starts turns by itself (Claude Code answers a finished
   * background task or a hook with init, output and a result — no user
   * message): the chat reads as working through such a turn. Codex never
   * does; its handshake's synthetic turn-init must not read as work.
   */
  agentStartedTurns: boolean
}

const NONE: ChatCapabilities = {
  nativeSlashCommands: false,
  promptHistory: false,
  promptCards: false,
  liveInterrupt: false,
  liveEffort: false,
  rewind: false,
  fork: false,
  sessions: false,
  handoff: false,
  attachments: 'paths',
  restoreComposerState: false,
  editableQueue: false,
  filesChanged: false,
  diffComments: false,
  commandPalette: false,
  compact: false,
  agentStartedTurns: false
}

const CAPABILITIES: Record<string, ChatCapabilities> = {
  'claude-chat': {
    nativeSlashCommands: true,
    promptHistory: true,
    promptCards: true,
    liveInterrupt: true,
    liveEffort: true,
    rewind: true,
    fork: true,
    sessions: true,
    handoff: true,
    attachments: 'blocks',
    restoreComposerState: true,
    editableQueue: true,
    filesChanged: true,
    diffComments: true,
    commandPalette: true,
    compact: true,
    agentStartedTurns: true
  },
  'codex-chat': {
    ...NONE,
    // Approvals, questions, permission and MCP input requests (app-server server requests).
    promptCards: true,
    // `turn/interrupt` in place; a Stop before the turn has an id waits for it.
    liveInterrupt: true,
    // Effort is a `turn/start` param: the next turn takes it, no restart.
    liveEffort: true,
    // `thread/revert` (history only: Codex keeps no file checkpoints).
    rewind: true,
    // `thread/fork {lastTurnId}` through the message's turn.
    fork: true,
    // The task's Codex threads; a switched-to one's past comes from `thread/turns/list`.
    sessions: true,
    // `turn/diff`-free: from the file-change items (X2).
    filesChanged: true,
    diffComments: true,
    // The Cmd+K Chat page is client-only; Compact lives on it.
    commandPalette: true,
    // `/compact` → `thread/compact/start` (the driver).
    compact: true
  }
}

export function chatCapabilitiesForMode(mode: string): ChatCapabilities {
  return CAPABILITIES[mode] ?? NONE
}

/**
 * The terminal (TUI) mode a chat mode hands its conversation to and takes it
 * from — the same CLI and the same session files (Claude: verified on 2.1.312,
 * chat-a check R1). Null: no hand-off.
 */
const HANDOFF_PARTNER: Record<string, string> = { 'claude-chat': 'claude-code' }

export function terminalModeForChat(chatMode: string): string | null {
  return chatCapabilitiesForMode(chatMode).handoff ? (HANDOFF_PARTNER[chatMode] ?? null) : null
}

export function chatModeForTerminal(terminalMode: string): string | null {
  for (const [chat, terminal] of Object.entries(HANDOFF_PARTNER)) {
    if (terminal === terminalMode && chatCapabilitiesForMode(chat).handoff) return chat
  }
  return null
}
