import { createContext, useContext } from 'react'
import type { AgentMode } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'

export interface ChatViewState {
  /**
   * Monotonic counter. When it increments, all expandable items should reset to collapsed.
   * Items close when it CHANGES (state adjusted during render), never on mount —
   * so an item's own default (e.g. errored / `defaultOpen` tool cards) holds.
   */
  collapseSignal: number
  /** When true, timeline filters down to user messages + final assistant reply per turn. */
  finalOnly: boolean
  /** When true, file-edit tool cards (Edit/Write) start expanded. */
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
   * handleModeChange. Renderers consume it for inline approval flows — e.g.
   * the ExitPlanMode tool exposes an "Approve & exit plan" button that calls
   * `setChatMode('auto-accept')`, which kills + respawns the subprocess with
   * the new flag.
   */
  setChatMode?: (next: AgentMode) => Promise<void>
  /**
   * Send a user message into the chat session. Used as a fallback by inline
   * answer flows when the adapter lacks a structured-input channel.
   */
  sendMessage?: (text: string) => void
  /**
   * Resolve a pending `tool_use_id` with a `tool_result` content block.
   * Preferred path for AskUserQuestion's submit so the SDK's turn machinery
   * sees a normal completion. Returns false when the adapter lacks a
   * structured-input channel — caller should fall back to `sendMessage`.
   */
  sendToolResult?: (args: {
    toolUseId: string
    content: string
    isError?: boolean
  }) => Promise<boolean>
  /**
   * Live `can_use_tool` permission requests keyed by `tool_use_id`. Set when
   * the adapter runs with `--permission-prompt-tool stdio` and Claude calls
   * a tool the active permission mode hasn't already auto-approved (notably
   * AskUserQuestion). Renderers correlate by `tool_use_id` (matches the
   * tool card's `invocation.id`) and resolve via `respondPermission`.
   */
  permissionRequests?: Map<string, { requestId: string; toolName: string; input: unknown }>
  /**
   * Reply to an inbound permission request. `behavior:'allow'` carries
   * `updatedInput` (e.g. AskUserQuestion answers). `behavior:'deny'` blocks
   * the tool with a message.
   */
  respondPermission?: (args: {
    requestId: string
    decision:
      | {
          behavior: 'allow'
          updatedInput?: Record<string, unknown>
          updatedPermissions?: unknown[]
        }
      | { behavior: 'deny'; message: string; interrupt?: boolean }
  }) => Promise<boolean>
  /**
   * Interrupt the running agent + clear queued messages. Same path as the
   * Stop button. Inline cancel flows (e.g. AskUserQuestion's Cancel) call
   * this so dismissing a question kills the turn instead of just denying
   * the tool. Undefined in harness contexts → callers fall back.
   */
  abortAgent?: () => Promise<void>
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
