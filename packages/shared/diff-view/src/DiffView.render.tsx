import { memo } from 'react'
import { cn } from '@slayzone/ui'
import type { DiffLine as DiffLineType, InlineHighlight } from './parse-diff'
import type { HlSpan } from './highlight'
import type { FlatLine } from './DiffView.types'

export function renderContent(
  content: string,
  type: DiffLineType['type'],
  wrap: boolean,
  spans?: HlSpan[],
  highlights?: InlineHighlight[]
) {
  const ws = wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
  const hasSpans = !!spans && spans.length > 0
  const hasHl = !!highlights && highlights.length > 0

  if (!hasSpans && !hasHl) return <span className={ws}>{content}</span>

  const highlightClass = type === 'add' ? 'bg-green-500/40 rounded-sm' : 'bg-red-500/40 rounded-sm'

  // Build sorted unique boundaries
  const b = new Set<number>([0, content.length])
  if (hasSpans)
    for (const s of spans!) {
      b.add(s.from)
      b.add(s.to)
    }
  if (hasHl)
    for (const h of highlights!) {
      b.add(h.start)
      b.add(h.end)
    }
  const points = [...b].sort((a, z) => a - z)

  // First pass: compute [from, to, className] segments. Second pass coalesces
  // adjacent segments with identical classes into one span, which slashes
  // React element count on syntax-heavy lines (e.g. a line with four adjacent
  // token boundaries that all resolve to the same class produces ONE span
  // after this, down from four). Pure optimisation — output text is identical.
  //
  // Span lookup uses a 2-pointer walk instead of `spans.find` per segment.
  // Spans arrive in position order from the tokenize worker (highlightTree
  // traverses in document order, non-overlapping at leaves) and segments are
  // walked in ascending `from`, so advancing a pointer past any span that
  // ends at or before the current segment's start is safe. Amortized O(1)
  // per segment instead of O(M) — saves real time on long minified lines
  // with hundreds of tokens. Preserves `find`'s first-match semantic: within
  // a set of candidates whose `from ≤ segFrom`, we pick the earliest array
  // index whose `to ≥ segTo`, matching the prior behavior byte-for-byte.
  type Seg = { from: number; to: number; cls: string }
  const rawSegs: Seg[] = []
  const spanArr = hasSpans ? spans! : undefined
  let sp = 0
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]
    const to = points[i + 1]
    if (to <= from) continue
    let tokenSpan: HlSpan | undefined
    if (spanArr) {
      // Retire spans that end at or before this segment starts — they cannot
      // match this or any later segment (segments only move forward).
      while (sp < spanArr.length && spanArr[sp].to <= from) sp++
      // Scan forward from sp for the first span covering [from, to]. Spans
      // starting after `from` cannot cover it, so this loop terminates quickly.
      for (let k = sp; k < spanArr.length; k++) {
        const s = spanArr[k]
        if (s.from > from) break
        if (s.to >= to) {
          tokenSpan = s
          break
        }
      }
    }
    const highlighted = hasHl ? highlights!.some((h) => h.start <= from && h.end >= to) : false
    const cls = cn(ws, tokenSpan?.classes, highlighted && highlightClass)
    rawSegs.push({ from, to, cls })
  }

  const parts: React.JSX.Element[] = []
  let i = 0
  while (i < rawSegs.length) {
    const start = i
    const cls = rawSegs[i].cls
    let end = i + 1
    while (end < rawSegs.length && rawSegs[end].cls === cls) end++
    const from = rawSegs[start].from
    const to = rawSegs[end - 1].to
    parts.push(
      <span key={start} className={cls}>
        {content.slice(from, to)}
      </span>
    )
    i = end
  }
  return <>{parts}</>
}

export const UnifiedLine = memo(function UnifiedLine({
  item,
  wrap
}: {
  item: FlatLine
  wrap: boolean
}) {
  const { line, spans } = item
  const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
  return (
    <div
      className={cn(
        'flex w-full border-l-[3px] border-l-transparent',
        line.type === 'add' && 'bg-green-500/10 border-l-green-500',
        line.type === 'delete' && 'bg-red-500/10 border-l-red-500'
      )}
    >
      <span className="w-10 shrink-0 text-right pr-1.5 text-muted-foreground/50 select-none border-r border-border/30 tabular-nums">
        {line.oldLineNo ?? ''}
      </span>
      <span className="w-10 shrink-0 text-right pr-1.5 text-muted-foreground/50 select-none border-r border-border/30 tabular-nums">
        {line.newLineNo ?? ''}
      </span>
      <span className="w-5 shrink-0 text-center select-none text-muted-foreground/60">
        {prefix}
      </span>
      <span
        className={cn(
          wrap ? 'min-w-0 flex-1' : 'shrink-0',
          line.type === 'add' && 'text-green-700 dark:text-green-400',
          line.type === 'delete' && 'text-red-700 dark:text-red-400'
        )}
      >
        {renderContent(line.content, line.type, wrap, spans, line.highlights)}
      </span>
    </div>
  )
})

export const SbsHalf = memo(function SbsHalf({
  item,
  side,
  wrap
}: {
  item: FlatLine | null
  side: 'left' | 'right'
  wrap: boolean
}) {
  if (!item) {
    return (
      <div className="flex w-full bg-muted/20 border-l-[3px] border-l-transparent">
        <span className="w-10 shrink-0 border-r border-border/30" />
        <span className="w-5 shrink-0" />
        <span className={cn(wrap ? 'min-w-0 flex-1' : 'shrink-0')}>&nbsp;</span>
      </div>
    )
  }
  const { line, spans } = item
  const isAdd = line.type === 'add'
  const isDel = line.type === 'delete'
  const prefix = isAdd ? '+' : isDel ? '-' : ' '
  const lineNo = side === 'left' ? line.oldLineNo : line.newLineNo
  return (
    <div
      className={cn(
        'flex w-full border-l-[3px] border-l-transparent',
        isAdd && 'bg-green-500/10 border-l-green-500',
        isDel && 'bg-red-500/10 border-l-red-500'
      )}
    >
      <span className="w-10 shrink-0 text-right pr-1.5 text-muted-foreground/50 select-none border-r border-border/30 tabular-nums">
        {lineNo ?? ''}
      </span>
      <span className="w-5 shrink-0 text-center select-none text-muted-foreground/60">
        {prefix}
      </span>
      <span
        className={cn(
          wrap ? 'min-w-0 flex-1' : 'shrink-0',
          isAdd && 'text-green-700 dark:text-green-400',
          isDel && 'text-red-700 dark:text-red-400'
        )}
      >
        {renderContent(line.content, line.type, wrap, spans, line.highlights)}
      </span>
    </div>
  )
})

export function GapDivider({ count }: { count: number }) {
  return (
    <div className="px-2 py-1.5 bg-card w-full">
      <div className="rounded-md bg-muted text-muted-foreground px-3 py-1 text-[11px] font-medium tracking-wide">
        {count} unmodified line{count === 1 ? '' : 's'}
      </div>
    </div>
  )
}
