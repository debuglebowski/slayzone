import type { TerminalMode } from '@slayzone/terminal/shared'

export interface TerminalProps {
  sessionId: string
  cwd: string
  mode?: TerminalMode
  conversationId?: string | null
  existingConversationId?: string | null
  supportsSessionId?: boolean
  initialPrompt?: string | null
  providerFlags?: string | null
  executionContext?: import('@slayzone/terminal/shared').ExecutionContext | null
  isActive?: boolean
  onAttached?: (api: { sessionId: string; focus: () => void }) => void
  /** Start a brand-new session: clear the stored conversation id + remount.
   *  Wired to the dead overlay's "Start fresh" action for a stale (auto-cleaned)
   *  session — see issue #90. */
  onStartFresh?: () => void
  onReady?: (api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => void
  onFirstInput?: () => void
  onRetry?: () => void
  onOpenUrl?: (url: string) => void
  onOpenFile?: (filePath: string, options?: { position?: { line: number; col?: number } }) => void
}

export interface TerminalHandle {
  focus: () => void
  hasSelection: () => boolean
  getSelection: () => string
  selectAll: () => void
  scrollToBottom: () => void
  openSearch: () => void
  clearBuffer: () => Promise<void>
}
