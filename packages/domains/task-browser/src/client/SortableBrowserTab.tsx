import { useState, useRef, useEffect } from 'react'
import { X, Lock } from 'lucide-react'
import { cn } from '@slayzone/ui'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { SortableBrowserTabProps } from './BrowserPanel.types'

export function SortableBrowserTab({
  tab,
  isActive,
  isPickingElement,
  isLocked,
  onSwitch,
  onClose,
  onRename
}: SortableBrowserTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id
  })
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.5 : 1
  }
  const displayName = tab.customName || (tab.url === 'about:blank' ? 'New Tab' : tab.url)

  const startEdit = (): void => {
    setDraft(tab.customName || '')
    setIsEditing(true)
  }
  const commit = (): void => {
    const trimmed = draft.trim()
    onRename(tab.id, trimmed)
    setIsEditing(false)
  }
  const cancel = (): void => {
    setIsEditing(false)
  }

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const dragProps = isEditing ? {} : { ...attributes, ...listeners }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...dragProps}
      onClick={() => {
        if (!isEditing) onSwitch(tab.id)
      }}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        startEdit()
      }}
      onKeyDown={(e) => {
        if (isEditing) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSwitch(tab.id)
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose(tab.id)
        }
      }}
      className={cn(
        'group flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0',
        'bg-surface-2 dark:bg-surface-2/50 hover:bg-accent/80 dark:hover:bg-accent/50',
        'max-w-[300px]',
        isActive
          ? 'bg-tab-active border border-border'
          : 'text-muted-foreground dark:text-muted-foreground',
        isActive && isPickingElement && 'ring-2 ring-amber-500/70 border-amber-500/70',
        isLocked && 'ring-1 ring-amber-500/60'
      )}
    >
      {isLocked && (
        <Lock aria-label="Browser controlled by agent" className="size-3 shrink-0 text-amber-500" />
      )}
      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          placeholder={tab.url === 'about:blank' ? 'New Tab' : tab.url}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-foreground"
        />
      ) : (
        <span className="truncate text-sm" title="Double-click to rename">
          {displayName}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose(tab.id)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="h-4 w-4 rounded hover:bg-muted-foreground/20 flex items-center justify-center"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
