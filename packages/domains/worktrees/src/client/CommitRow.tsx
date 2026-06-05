// --- Single commit row renderer ---

import { cn } from '@slayzone/ui'
import { Copy, Check } from 'lucide-react'
import { ROW_HEIGHT } from './CommitGraph.constants'

export function CommitRow({
  shortHash,
  message,
  author,
  relativeDate,
  refs,
  mergedFrom,
  color,
  gutterWidth,
  copiedHash,
  onCopy,
  dimmed
}: {
  shortHash: string
  message: string
  author: string
  relativeDate: string
  refs?: string[]
  mergedFrom?: string
  color: string
  gutterWidth: number
  copiedHash: string | null
  onCopy: (hash: string) => void
  dimmed?: boolean
}) {
  return (
    <div
      className={cn('flex items-center cursor-pointer', dimmed && 'opacity-20')}
      style={{ height: ROW_HEIGHT, paddingLeft: gutterWidth, paddingTop: 3, paddingBottom: 3 }}
      onClick={() => onCopy(shortHash)}
    >
      <div
        className="flex-1 min-w-0 flex items-center gap-2 pr-3 h-full rounded group transition-colors px-2"
        style={{ backgroundColor: `${color}12` }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-xs truncate">{message}</div>
          <div className="text-[10px] text-muted-foreground">
            <span className="font-mono">{shortHash}</span>
            {' · '}
            {author}
            {' · '}
            {relativeDate}
          </div>
        </div>
        {refs &&
          refs.map((ref) => (
            <span
              key={ref}
              className="shrink-0 px-1.5 py-0 rounded text-[10px] font-medium"
              style={{ backgroundColor: `${color}20`, color }}
            >
              {ref}
            </span>
          ))}
        {mergedFrom && (
          <span
            className="shrink-0 px-1.5 py-0 rounded text-[10px] font-medium opacity-60 border border-current"
            style={{ color: 'var(--color-muted-foreground)' }}
          >
            {mergedFrom}
          </span>
        )}
        {copiedHash === shortHash ? (
          <Check className="h-3 w-3 text-green-500 shrink-0" />
        ) : (
          <Copy className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
      </div>
    </div>
  )
}
