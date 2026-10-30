import { useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleX, Loader2, ShieldAlert } from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { ToolInvocation } from '@slayzone/terminal/client'
import { useChatProvider, useChatView } from '../ChatViewContext'
import { LinkifiedText } from '../LinkifiedText'
import { useRowUiState } from '../row-ui-state'
import { HOOK_TONE, hookLabel } from '../hook-labels'
import { HighlightedText } from '../HighlightedText'
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

/**
 * The call's result text to show — none for a call a hook blocked: that
 * "result" is the CLI's copy of the hook's reason, which the card's block line
 * already shows (`BlockedByHook`).
 */
function resultTextOf(invocation: ToolInvocation): string {
  return invocation.blockedBy ? '' : extractRawText(invocation.result?.rawContent)
}

/** A PreToolUse hook stopped the call: which hook, who saw its reason, the reason. */
function BlockedByHook({ block }: { block: NonNullable<ToolInvocation['blockedBy']> }) {
  const provider = useChatProvider()
  return (
    <div
      data-testid="chat-tool-blocked"
      className={cn('border-t px-3 py-1.5 text-xs', HOOK_TONE.blocked)}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-3 shrink-0" />
        <span className="font-medium min-w-0 truncate">
          {hookLabel(
            {
              hookName: block.hookName,
              hookEvent: 'PreToolUse',
              effect: 'blocked',
              text: block.text
            },
            provider.agent
          )}
        </span>
        <span className="shrink-0 rounded-sm border border-current/30 px-1 text-[10px] uppercase tracking-wide opacity-80">
          {block.audience === 'agent' ? `Sent to ${provider.agent}` : 'Shown only to you'}
        </span>
      </div>
      {block.text && (
        <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] opacity-90">
          <HighlightedText text={block.text} />
        </pre>
      )}
    </div>
  )
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
  // Kept while scrolled away; "Collapse all" closes it (the default holds on mount).
  const [open, setOpen] = useRowUiState('card', defaultOpen ?? status === 'error', false)
  // "Show this card" (files-changed row) opens it, also when it mounts after the
  // request (the timeline scrolled it in first).
  const focusRequested = useToolFocusRequest(invocation.id)
  useEffect(() => {
    if (focusRequested && !open) setOpen(true)
  }, [focusRequested, open, setOpen])
  // Body fallback chain: per-tool rich children > rawContent text > pending placeholder.
  // Keeps any tool card non-blank when structured data is missing or absent.
  const rawText = useMemo(() => resultTextOf(invocation), [invocation])
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
        {invocation.blockedBy && <BlockedByHook block={invocation.blockedBy} />}
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
  resultTextOf,
  ToolShell,
  StatusIcon,
  shortenPath
}
export type { ToolProps }
