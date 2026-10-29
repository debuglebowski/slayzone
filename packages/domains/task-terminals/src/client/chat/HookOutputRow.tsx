import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleX,
  OctagonX,
  ShieldAlert,
  TimerOff,
  Webhook
} from 'lucide-react'
import { cn, useDepsChanged } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatView } from './ChatViewContext'
import { HighlightedText } from './HighlightedText'
import { CHAT_CARD_INDENT, HoverTimestamp } from './tool-cards/card-shell'

type HookItem = Extract<TimelineItem, { kind: 'hook' }>

/** What a hook's block stopped from happening, by hook event. */
const BLOCKED_WHAT: Record<string, string> = {
  PreToolUse: 'blocked the tool call',
  PostToolUse: 'flagged the tool result',
  UserPromptSubmit: 'blocked your message',
  Stop: 'kept Claude working',
  SubagentStop: 'kept the sub-agent working',
  PermissionRequest: 'denied the permission request'
}

function hookLabel(item: HookItem): string {
  const name = `${item.hookName} hook`
  switch (item.effect) {
    case 'blocked':
      return `${name} ${BLOCKED_WHAT[item.hookEvent] ?? 'blocked this'}`
    case 'failed':
      return `${name} failed${item.exitCode != null ? ` (exit ${item.exitCode})` : ''}`
    case 'cancelled':
      return `${name} timed out or was cancelled`
    case 'stopped':
      return `${name} stopped Claude`
    case 'context': {
      const lines = item.text.split('\n').length
      return `${name} added context for Claude · ${lines} line${lines === 1 ? '' : 's'}`
    }
  }
}

const TONE: Record<HookItem['effect'], string> = {
  blocked: 'border-warning/40 bg-warning/10 text-warning-foreground',
  stopped: 'border-warning/40 bg-warning/10 text-warning-foreground',
  cancelled: 'border-warning/30 bg-warning/5 text-warning-foreground',
  failed: 'border-destructive/40 bg-destructive/5 text-destructive',
  context: 'border-border/50 bg-muted/20 text-muted-foreground'
}

function EffectIcon({ effect }: { effect: HookItem['effect'] }) {
  const cls = 'size-3 shrink-0'
  if (effect === 'blocked') return <ShieldAlert className={cls} />
  if (effect === 'stopped') return <OctagonX className={cls} />
  if (effect === 'cancelled') return <TimerOff className={cls} />
  if (effect === 'failed') return <CircleX className={cls} />
  return <Webhook className={cls} />
}

/**
 * A hook run that mattered: it blocked something, failed, timed out, stopped
 * Claude, or added context for Claude. Quiet hook runs never reach the
 * timeline. Problems start open; added context starts collapsed.
 */
export function HookOutputRow({ item }: { item: HookItem }) {
  const hasText = item.text.trim().length > 0
  const [open, setOpen] = useState(hasText && item.effect !== 'context')
  const { collapseSignal } = useChatView()
  // "Collapse all": closes on a collapseSignal CHANGE only (adjusted during render).
  const collapseBumped = useDepsChanged([collapseSignal])
  if (collapseBumped) setOpen(false)
  return (
    <div className={cn(CHAT_CARD_INDENT, 'pr-4 py-1 group flex items-start gap-2')}>
      <div
        data-testid="chat-hook-output"
        data-effect={item.effect}
        className={cn('w-fit max-w-full rounded-md border overflow-hidden', TONE[item.effect])}
      >
        <button
          type="button"
          onClick={() => hasText && setOpen((v) => !v)}
          disabled={!hasText}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 text-xs text-left max-w-full',
            hasText ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default'
          )}
        >
          <EffectIcon effect={item.effect} />
          <span className="font-medium min-w-0 truncate">{hookLabel(item)}</span>
          {item.effect !== 'context' && hasText && (
            <span className="shrink-0 rounded-sm border border-current/30 px-1 text-[10px] uppercase tracking-wide opacity-80">
              {item.audience === 'agent' ? 'Sent to Claude' : 'Shown only to you'}
            </span>
          )}
          {hasText && (
            <span className="shrink-0 opacity-70">
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </span>
          )}
        </button>
        {open && hasText && (
          <pre className="border-t border-current/20 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-foreground/90">
            <HighlightedText text={item.text} />
          </pre>
        )}
      </div>
      <HoverTimestamp timestamp={item.timestamp} />
    </div>
  )
}
