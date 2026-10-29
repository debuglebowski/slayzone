import { createContext, useContext } from 'react'
import type { AgentMode } from '@slayzone/ui'
import type { ChatPrompt, TimelineItem } from '@slayzone/terminal/client'
import type { PermissionDecision } from '@slayzone/terminal-contracts'

export interface ChatViewState {
  /**
   * Monotonic counter. When it increments, all expandable items should reset to collapsed.
   * Items close when it CHANGES (state adjusted during render), never on mount —
   * so an item's own default (e.g. errored / `defaultOpen` tool cards) holds.
   */
  collapseSignal: number
  /** When true, timeline filters down to user messages + final assistant reply per turn. */
  finalOnly: boolean
  /** When true, file-edit tool cards (Edit/Write/MultiEdit/NotebookEdit) start expanded. */
  fileEditsOpenByDefault: boolean
  /** When true, the per-turn meta footer (duration, cost, turn count) is shown. */
  showMessageMeta: boolean
  /**
   * Search highlight metadata. When `query` is non-empty, plain-text renderers
   * (UserMessage, ThinkingBlock, StderrBlock, ResultFooter expanded text, tool
   * inputs/outputs) wrap matches in `<mark>` so users see every hit, not just
   * the active item.
   */
  search: {
    query: string
    caseSensitive: boolean
  }
  /**
   * Switch the chat's permission mode. Wired by ChatPanel to `useChatMode`'s
   * handleModeChange.
   */
  setChatMode?: (next: AgentMode) => Promise<void>
  /**
   * Send a user message into the chat session (plan approval's "approve with
   * this feedback" sends the feedback this way).
   */
  sendMessage?: (text: string) => void
  /** Send a failed user message again (same id). */
  retryMessage?: (id: string) => void
  /** Start the agent again (the start-failure card's Retry). */
  restartAgent?: () => void
  /**
   * Resolve a pending `tool_use_id` with a `tool_result` content block.
   * Returns false when the adapter lacks a structured-input channel.
   */
  sendToolResult?: (args: {
    toolUseId: string
    content: string
    isError?: boolean
  }) => Promise<boolean>
  /**
   * The provider answers prompts from prompt cards (`ChatCapabilities.promptCards`).
   * Off: no dock, no prompt status on cards (Codex keeps today's behavior).
   */
  promptCards?: boolean
  /** The agent's questions to the user with their state, oldest first (`chat-prompts.ts`). */
  prompts?: ChatPrompt[]
  /** Request ids whose answer is on its way to the server. */
  submittingPrompts?: ReadonlySet<string>
  /**
   * Answer a pending prompt with a wire decision; `optionId` names the row
   * picked. Resolves false when the request is no longer pending.
   */
  respondPermission?: (args: {
    requestId: string
    decision: PermissionDecision
    optionId?: string
  }) => Promise<boolean>
  /** The account has auto mode and opted in (prompt rows offer "switch to auto mode"). */
  autoModeAvailable?: boolean
  /** The session's working directory (rows that name it). */
  cwd?: string
  /**
   * Full flat timeline + parent→children index, exposed so SubAgentRow can
   * render the items emitted while it ran (parentToolUseId === toolUseId).
   * Empty defaults are safe for harnesses that don't construct sub-agents.
   */
  timeline: TimelineItem[]
  childIndex: Map<string, number[]>
  /**
   * Cmd+Click on URL → in-app slay browser. Mirrors terminal pane wiring.
   * Cmd+Shift+Click always goes external regardless. Bare click does nothing.
   * Falls back to `shell.openExternal` when undefined.
   */
  onOpenUrl?: (url: string) => void
  /**
   * Cmd+Click on file path → editor pane. Falls back to `shell.openPath`.
   */
  onOpenFile?: (filePath: string, line?: number, col?: number) => void
}

export const ChatViewContext = createContext<ChatViewState>({
  collapseSignal: 0,
  finalOnly: false,
  fileEditsOpenByDefault: true,
  showMessageMeta: true,
  search: { query: '', caseSensitive: false },
  timeline: [],
  childIndex: new Map()
})

export function useChatView(): ChatViewState {
  return useContext(ChatViewContext)
}
