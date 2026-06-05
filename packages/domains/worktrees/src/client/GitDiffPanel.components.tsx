import { memo, useCallback, useRef } from 'react'
import { Plus, Minus, Undo2 } from 'lucide-react'
import { cn, fileTreeIndent } from '@slayzone/ui'
import type { FileEntry } from './GitDiffPanel.types'
import { STATUS_COLORS } from './GitDiffPanel.utils'

export function HorizontalResizeHandle({ onDrag }: { onDrag: (deltaX: number) => void }) {
  const isDragging = useRef(false)
  const startX = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startX.current = e.clientX

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return
        const delta = e.clientX - startX.current
        startX.current = e.clientX
        onDrag(delta)
      }

      const handleMouseUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [onDrag]
  )

  return (
    <div
      className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
      onMouseDown={handleMouseDown}
    />
  )
}

export const FileListItem = memo(function FileListItem({
  entry,
  displayName,
  selected,
  additions,
  deletions,
  onClick,
  onAction,
  onDiscard,
  itemRef,
  depth = 0
}: {
  entry: FileEntry
  displayName?: string
  selected: boolean
  additions?: number
  deletions?: number
  onClick: () => void
  onAction: () => void
  onDiscard?: () => void
  itemRef?: React.Ref<HTMLDivElement>
  depth?: number
}) {
  const hasCounts = additions != null || deletions != null

  return (
    <div
      ref={itemRef}
      className={cn(
        'group w-full text-left py-2 pr-3 flex items-center gap-1.5 text-xs font-mono hover:bg-muted/50 transition-colors cursor-pointer rounded',
        selected && 'bg-primary/10'
      )}
      style={{ paddingLeft: fileTreeIndent(depth) }}
      onClick={onClick}
    >
      <span className={cn('font-bold shrink-0 w-3 text-center', STATUS_COLORS[entry.status])}>
        {entry.status}
      </span>
      <span className="truncate min-w-0 flex-1">{displayName ?? entry.path}</span>
      {hasCounts && (
        <span className="shrink-0 text-[10px] tabular-nums space-x-1">
          {additions != null && additions > 0 && (
            <span className="text-green-600 dark:text-green-400">+{additions}</span>
          )}
          {deletions != null && deletions > 0 && (
            <span className="text-red-600 dark:text-red-400">-{deletions}</span>
          )}
        </span>
      )}
      {onDiscard && (
        <button
          className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation()
            onDiscard()
          }}
          title="Discard changes"
        >
          <Undo2 className="size-3.5" />
        </button>
      )}
      <button
        className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-foreground text-muted-foreground transition-opacity p-0.5 rounded hover:bg-accent"
        onClick={(e) => {
          e.stopPropagation()
          onAction()
        }}
        title={entry.source === 'unstaged' ? 'Stage file' : 'Unstage file'}
      >
        {entry.source === 'unstaged' ? (
          <Plus className="size-3.5" />
        ) : (
          <Minus className="size-3.5" />
        )}
      </button>
    </div>
  )
})
