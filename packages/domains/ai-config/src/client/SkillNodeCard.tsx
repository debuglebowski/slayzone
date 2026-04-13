import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { AiConfigItem, AiConfigScope, SkillValidationStatus, SyncHealth } from '../shared'
import { useContextManagerStore } from './useContextManagerStore'

const CHAR_WIDTH = 8.4 // monospace text-sm approx
const PADDING = 24     // px-3 * 2
const MIN_WIDTH = 140
const MAX_WIDTH = 320

// Approximate widths of the bottom badge-row pills at text-[9px]
const SCOPE_PILL_WIDTH = 46      // "Project" is the longest scope label
const LINE_COUNT_PILL_WIDTH = 34 // up to ~5 digits + L
const STALE_PILL_WIDTH = 52      // icon + "Stale"
const PILL_GAP = 4

export interface SkillNodeWidthOpts {
  hasStaleBadge?: boolean
  hasLineCount?: boolean
}

export function computeSkillNodeWidth(slug: string, opts: SkillNodeWidthOpts = {}): number {
  const slugBased = Math.ceil(slug.length * CHAR_WIDTH + PADDING + 8)
  let rowWidth = SCOPE_PILL_WIDTH
  if (opts.hasLineCount) rowWidth += PILL_GAP + LINE_COUNT_PILL_WIDTH
  if (opts.hasStaleBadge) rowWidth += PILL_GAP + STALE_PILL_WIDTH
  const rowBased = rowWidth + PADDING
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, slugBased, rowBased))
}

export interface SkillNodeData {
  item: AiConfigItem
  scope: AiConfigScope
  validationStatus: SkillValidationStatus | null
  description: string
  selected: boolean
  width: number
  syncHealth?: SyncHealth
  [key: string]: unknown
}

export const SkillNodeCard = memo(function SkillNodeCard({ data }: NodeProps) {
  const { item, scope, validationStatus, description, selected, width, syncHealth } = data as SkillNodeData
  const showLineCount = useContextManagerStore((s) => s.showLineCount)
  const isStale = syncHealth === 'stale'

  return (
    <div
      style={{ width }}
      className={cn(
        'rounded-lg border bg-surface-3 px-3 py-2.5 shadow-sm transition-shadow',
        selected
          ? 'ring-2 ring-primary border-primary shadow-md'
          : isStale
            ? 'ring-1 ring-amber-500/50 border-amber-500/40 hover:shadow-md'
            : 'hover:shadow-md'
      )}
    >
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-transparent !border-none !opacity-0" />

      <div className="flex items-start gap-1.5">
        <p className="truncate font-mono text-sm font-medium leading-tight">{item.slug}</p>
        {validationStatus && validationStatus !== 'valid' && (
          <AlertTriangle className={cn(
            'shrink-0 size-3.5',
            validationStatus === 'invalid' ? 'text-destructive' : 'text-amber-500'
          )} />
        )}
      </div>

      {description && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-tight text-muted-foreground">
          {description}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-1 whitespace-nowrap">
        <span className={cn(
          'rounded-full px-1.5 py-0.5 text-[9px] font-medium leading-none',
          scope === 'library'
            ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
            : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        )}>
          {scope === 'library' ? 'Library' : 'Project'}
        </span>
        {showLineCount && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
            {item.content.split('\n').length}L
          </span>
        )}
        {isStale && (
          <span
            title="Stale"
            className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium leading-none text-amber-700 dark:text-amber-300"
          >
            <AlertCircle className="size-2.5" />
            Stale
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-transparent !border-none !opacity-0" />
    </div>
  )
})
