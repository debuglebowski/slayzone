import { useState, useCallback } from 'react'
import { History, MessageSquare, X } from 'lucide-react'
import { IconButton, cn } from '@slayzone/ui'
import { useTaskSessions } from './useTaskSessions'

const storageKey = (taskId: string): string => `slayzone:sessions-sidebar:${taskId}`

/**
 * Per-task open/closed state for the sessions sidebar, persisted to localStorage
 * so it survives app restarts. Distinct key from the prompts sidebar so the two
 * dock independently (both can be open at once). `taskId` is stable for a
 * TerminalContainer's lifetime, so the lazy initializer reads it once on mount.
 */
export function useSessionsSidebarOpen(taskId: string): [boolean, () => void] {
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
 * Tab-bar button that OPENS the sessions sidebar (the close affordance is the X
 * in the sidebar header). Same IconButton (size-7, size-3.5 glyph, ghost) as the
 * sibling `AgentPromptsToggleButton` so size + spacing match exactly.
 */
export function SessionHistoryToggleButton({
  onToggle
}: {
  onToggle: () => void
}): React.ReactElement {
  return (
    <IconButton
      data-testid="session-history-toggle"
      variant="ghost"
      className="size-7"
      aria-label="Show sessions sidebar"
      onClick={onToggle}
    >
      <History className="size-3.5" />
    </IconButton>
  )
}

/** Coarse relative time — "just now", "5m ago", "3h ago", "2d ago". */
function formatRelative(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const ORIGIN_LABEL: Record<string, string> = {
  'slay-spawned-fresh': 'New session',
  'slay-spawned-resume': 'Resumed session',
  'cas-repoint-heal': 'Recovered session',
  'legacy-migration': 'Earlier session'
}

/** Card title: first user prompt (preferred), else a provenance label. */
function sessionTitle(firstPrompt: string | null, origin: string): string {
  const p = firstPrompt?.trim()
  if (p) return p
  return ORIGIN_LABEL[origin] ?? 'Session'
}

/**
 * Read-only sidebar listing every agent session tied to the task's main agent
 * (mode `agentId`), newest first. One card per distinct provider conversation —
 * `--resume` re-spawns collapse into a single session. Docks beside the terminal
 * inside TerminalContainer, alongside the messages sidebar.
 */
export function SessionsSidebar({
  taskId,
  agentId,
  onToggle
}: {
  taskId: string
  agentId: string
  /** Closes the sidebar — the toggle lives in this header while open. */
  onToggle: () => void
}): React.ReactElement {
  const sessions = useTaskSessions(taskId, agentId, true)
  // Stable "now" anchored at mount — relative labels don't need per-ms churn, and
  // reading the clock in render is an impure call the React Compiler rejects.
  const [now] = useState(() => Date.now())

  return (
    <div
      data-testid="agent-sessions-sidebar"
      className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-surface-1"
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pl-3 pr-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Sessions
        </span>
        <IconButton
          data-testid="session-history-toggle"
          variant="ghost"
          className="size-7"
          aria-label="Close sessions sidebar"
          onClick={onToggle}
        >
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.conversationId}
              data-testid="agent-session-item"
              className={cn(
                'rounded-md px-2.5 py-2 text-sm',
                s.isCurrent
                  ? 'bg-surface-2 ring-1 ring-primary/40'
                  : 'bg-surface-2 text-foreground'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 break-words text-foreground">
                  {sessionTitle(s.firstPrompt, s.origin)}
                </p>
                {s.isCurrent && (
                  <span className="mt-0.5 shrink-0 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
                    Current
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
                <span className="flex items-center gap-0.5">
                  <MessageSquare className="size-2.5" />
                  {s.messageCount}
                </span>
                <span>·</span>
                <time>{formatRelative(s.lastActiveAt, now)}</time>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
