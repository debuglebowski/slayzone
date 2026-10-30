import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { cn, useDepsChanged } from '@slayzone/ui'
import type { ToolInvocation } from '@slayzone/terminal/client'
import { useChatView } from '../ChatViewContext'
import { LinkifiedText } from '../LinkifiedText'
import { useToolFocusRequest } from './tool-focus'

// Shared chat card primitives (moved verbatim from renderers.tsx), so tool cards
// in their own files can use them without importing renderers.tsx.

/**
 * Context-bound LinkifiedText. Pulls `onOpenUrl`/`onOpenFile` from ChatViewContext
 * so renderers don't have to thread them per call site. When unset, falls back to
 * shell.openExternal / shell.openPath.
 */
function LinkText({ text }: { text: string }) {
  const { onOpenUrl, onOpenFile } = useChatView()
  return <LinkifiedText text={text} onOpenUrl={onOpenUrl} onOpenFile={onOpenFile} />
}

// Card indent for tool/sub-agent rows: aligns with assistant card position
// (assistant uses pl-4 + size-7 avatar + gap-3 = 56px = pl-14).
const CHAT_CARD_INDENT = 'pl-14'

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return ''
  }
}

interface ToolProps {
  invocation: ToolInvocation
  /** Wall-clock ts of the tool-call timeline item — surfaced on card hover. */
  timestamp?: number
}

/** Hover-revealed timestamp, sits beside left-aligned cards (tool, sub-agent, etc.). */
function HoverTimestamp({ timestamp }: { timestamp?: number }) {
  if (timestamp == null) return null
  return (
    <span className="shrink-0 self-center text-[11px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
      {formatTime(timestamp)}
    </span>
  )
}

function extractRawText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return (raw as Array<{ text?: string }>).map((c) => c?.text ?? '').join('\n')
  }
  return ''
}

function ToolShell({
  invocation,
  icon,
  title,
  summary,
  children,
  defaultOpen,
  timestamp
}: {
  invocation: ToolInvocation
  icon: React.ReactNode
  title: React.ReactNode
  summary?: React.ReactNode
  children?: React.ReactNode
  defaultOpen?: boolean
  timestamp?: number
}) {
  const status = invocation.status
  const [open, setOpen] = useState(defaultOpen ?? status === 'error')
  const { collapseSignal } = useChatView()
  // "Collapse all": closes on a collapseSignal CHANGE only (adjusted during
  // render), so the default above holds on mount.
  const collapseBumped = useDepsChanged([collapseSignal])
  if (collapseBumped) setOpen(false)
  // "Show this card" (files-changed row) opens it, also when it mounts after the request.
  const focusRequested = useToolFocusRequest(invocation.id)
  if (focusRequested && !open) setOpen(true)
  // Body fallback chain: per-tool rich children > rawContent text > pending placeholder.
  // Keeps any tool card non-blank when structured data is missing or absent.
  const rawText = useMemo(() => extractRawText(invocation.result?.rawContent), [invocation.result])
  let body: React.ReactNode = children
  if (!body && rawText) {
    body = (
      <pre className="p-3 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto bg-muted/30 text-muted-foreground">
        <LinkText text={rawText} />
      </pre>
    )
  }
  if (!body && status === 'pending') {
    body = <div className="px-3 py-2 text-xs text-muted-foreground italic">Waiting for result…</div>
  }
  const canOpen = Boolean(body)
  return (
    <div className={cn(CHAT_CARD_INDENT, 'pr-4 py-1 group flex items-start gap-2')}>
      <div className="w-fit max-w-full rounded-lg border border-border/50 bg-card/40 overflow-hidden shadow-sm">
        <button
          onClick={() => canOpen && setOpen(!open)}
          disabled={!canOpen}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 text-xs text-left max-w-full',
            canOpen && 'hover:bg-muted/40 cursor-pointer',
            !canOpen && 'cursor-default'
          )}
        >
          <StatusIcon status={status} />
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          <span className="font-medium shrink-0">{title}</span>
          {summary !== undefined && summary !== '' && (
            <span className="text-muted-foreground truncate min-w-0 font-mono text-[11px]">
              {summary}
            </span>
          )}
          {canOpen && (
            <span className="shrink-0 text-muted-foreground">
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </span>
          )}
        </button>
        {open && canOpen && (
          <div className="border-t border-border/40 bg-background/40">{body}</div>
        )}
      </div>
      <HoverTimestamp timestamp={timestamp} />
    </div>
  )
}

function StatusIcon({ status }: { status: ToolInvocation['status'] }) {
  if (status === 'pending')
    return <Loader2 className="size-3 animate-spin text-muted-foreground shrink-0" />
  if (status === 'error') return <CircleX className="size-3 text-destructive shrink-0" />
  if (status === 'denied') return <CircleX className="size-3 text-warning shrink-0" />
  return <CircleCheck className="size-3 text-success shrink-0" />
}

function shortenPath(p?: string): string {
  if (!p) return ''
  const parts = p.split('/')
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p
}

export {
  LinkText,
  CHAT_CARD_INDENT,
  formatTime,
  HoverTimestamp,
  extractRawText,
  ToolShell,
  StatusIcon,
  shortenPath
}
export type { ToolProps }
