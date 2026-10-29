import { Info, TriangleAlert } from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { HighlightedText } from './HighlightedText'
import { CHAT_CARD_INDENT } from './tool-cards/card-shell'

/** A notice the CLI shows the user, e.g. a hook's `systemMessage`. */
export function NoticeRow({ item }: { item: Extract<TimelineItem, { kind: 'notice' }> }) {
  const warn = item.level === 'warning' || item.level === 'error'
  return (
    <div className={cn(CHAT_CARD_INDENT, 'pr-4 py-1')}>
      <div
        data-testid="chat-notice"
        data-level={item.level}
        className={cn(
          'w-fit max-w-full flex items-start gap-2 rounded-md border px-3 py-1.5 text-xs',
          warn
            ? 'border-warning/40 bg-warning/10 text-warning-foreground'
            : 'border-border/50 bg-muted/20 text-muted-foreground'
        )}
      >
        {warn ? (
          <TriangleAlert className="size-3 mt-0.5 shrink-0" />
        ) : (
          <Info className="size-3 mt-0.5 shrink-0" />
        )}
        <span className="whitespace-pre-wrap break-words">
          <HighlightedText text={item.text} />
        </span>
      </div>
    </div>
  )
}
