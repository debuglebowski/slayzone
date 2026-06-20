import { useState, useEffect, useCallback, useRef } from 'react'
import { MessageSquareText, X } from 'lucide-react'
import { IconButton } from '@slayzone/ui'
import { useAgentPrompts } from './useAgentPrompts'

const storageKey = (taskId: string): string => `slayzone:prompts-sidebar:${taskId}`

/**
 * Per-task open/closed state for the prompts sidebar, persisted to localStorage
 * so it survives app restarts. `taskId` is stable for a TerminalContainer's
 * lifetime (one per task), so the lazy initializer reads it once on mount.
 */
export function usePromptsSidebarOpen(taskId: string): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey(taskId)) === '1'
    } catch {
      return false
    }
  })

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      try {
        localStorage.setItem(storageKey(taskId), next ? '1' : '0')
      } catch {
        /* storage unavailable — state still toggles in-memory */
      }
      return next
    })
  }, [taskId])

  return [open, toggle]
}

/**
 * Tab-bar button that OPENS the prompts sidebar (the close affordance is the X
 * in the sidebar header). Same IconButton (size-7, size-3.5 glyph, ghost) as
 * the sibling terminal-header icons so size + spacing match exactly.
 */
export function AgentPromptsToggleButton({
  onToggle
}: {
  onToggle: () => void
}): React.ReactElement {
  return (
    <IconButton
      data-testid="agent-prompts-toggle"
      variant="ghost"
      className="size-7"
      aria-label="Show messages sidebar"
      onClick={onToggle}
    >
      <MessageSquareText className="size-3.5" />
    </IconButton>
  )
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * Read-only sidebar listing every user prompt sent to the task's main agent
 * (mode `agentId`), oldest first — reads like a transcript. Docks beside the
 * terminal inside TerminalContainer.
 */
export function AgentPromptsSidebar({
  taskId,
  agentId,
  onToggle
}: {
  taskId: string
  agentId: string
  /** Closes the sidebar — the toggle lives in this header while open. */
  onToggle: () => void
}): React.ReactElement {
  const prompts = useAgentPrompts(taskId, agentId, true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Keep the newest message in view as the list grows (transcript behaviour).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [prompts.length])

  return (
    <div
      data-testid="agent-prompts-sidebar"
      className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-surface-1"
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pl-3 pr-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Messages
        </span>
        <IconButton
          data-testid="agent-prompts-toggle"
          variant="ghost"
          className="size-7"
          aria-label="Close messages sidebar"
          onClick={onToggle}
        >
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {prompts.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            No messages yet
          </div>
        ) : (
          prompts.map((p) => (
            <div
              key={p.id}
              data-testid="agent-prompt-item"
              className="rounded-md bg-surface-2 px-2.5 py-2 text-sm text-foreground"
            >
              <p className="whitespace-pre-wrap break-words">{p.text}</p>
              <time className="mt-1 block text-[10px] tabular-nums text-muted-foreground">
                {formatTime(p.created_at)}
              </time>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
