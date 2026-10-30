import {
  ChevronDown,
  ChevronRight,
  CircleX,
  OctagonX,
  ShieldAlert,
  TimerOff,
  Webhook
} from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useRowUiState } from './row-ui-state'
import { HighlightedText } from './HighlightedText'
import { CHAT_CARD_INDENT, HoverTimestamp } from './tool-cards/card-shell'
import { HOOK_TONE, hookLabel } from './hook-labels'
import { useChatProvider } from './ChatViewContext'

type HookItem = Extract<TimelineItem, { kind: 'hook' }>

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
  const provider = useChatProvider()
  const hasText = item.text.trim().length > 0
  // Kept while scrolled away; "Collapse all" closes it.
  const [open, setOpen] = useRowUiState('hook', hasText && item.effect !== 'context', false)
  return (
    <div className={cn(CHAT_CARD_INDENT, 'pr-4 py-1 group flex items-start gap-2')}>
      <div
        data-testid="chat-hook-output"
        data-effect={item.effect}
        className={cn('w-fit max-w-full rounded-md border overflow-hidden', HOOK_TONE[item.effect])}
      >
        <button
          type="button"
          onClick={() => hasText && setOpen(!open)}
          disabled={!hasText}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 text-xs text-left max-w-full',
            hasText ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default'
          )}
        >
          <EffectIcon effect={item.effect} />
          <span className="font-medium min-w-0 truncate">{hookLabel(item, provider.agent)}</span>
          {item.effect !== 'context' && hasText && (
            <span className="shrink-0 rounded-sm border border-current/30 px-1 text-[10px] uppercase tracking-wide opacity-80">
              {item.audience === 'agent' ? `Sent to ${provider.agent}` : 'Shown only to you'}
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
