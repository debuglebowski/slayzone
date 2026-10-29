import { TriangleAlert } from 'lucide-react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { formatTokens } from './usage-format'

/** Divider where the CLI compacted the conversation, or the reason a compaction failed. */
export function CompactionRow({ item }: { item: Extract<TimelineItem, { kind: 'compaction' }> }) {
  if (item.outcome === 'failed') {
    return (
      <div
        role="alert"
        className="mx-4 my-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        <span>Compaction failed{item.error ? `: ${item.error}` : ''}</span>
      </div>
    )
  }
  return (
    <div
      role="separator"
      className="mx-4 my-3 flex items-center gap-3 text-[11px] text-muted-foreground"
    >
      <div className="h-px flex-1 bg-border" />
      <span>
        Conversation compacted{item.trigger === 'auto' ? ' automatically' : ''}
        {item.preTokens ? ` · was ${formatTokens(item.preTokens)} tokens` : ''}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
