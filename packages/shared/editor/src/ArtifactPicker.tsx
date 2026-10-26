import { useState, useEffect, useRef, useCallback } from 'react'

export interface ArtifactPickerItem {
  id: string
  title: string
  type: string
}

interface ArtifactPickerProps {
  items: ArtifactPickerItem[]
  query: string
  coords: { top: number; left: number; bottom: number }
  onSelect: (item: ArtifactPickerItem) => void
  onClose: () => void
}

export function ArtifactPicker({ items, query, coords, onSelect, onClose }: ArtifactPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))

  // Reset the highlight when the query changes — adjusted during render.
  const [prevQuery, setPrevQuery] = useState(query)
  if (query !== prevQuery) {
    setPrevQuery(query)
    setSelectedIndex(0)
  }

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[selectedIndex]) onSelect(filtered[selectedIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [filtered, selectedIndex, onSelect, onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  if (filtered.length === 0) {
    return (
      <div
        ref={containerRef}
        className="fixed z-50 rounded-md border border-border bg-popover shadow-md p-2 text-xs text-muted-foreground"
        style={{ top: coords.bottom + 4, left: coords.left }}
      >
        No artifacts found
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md py-1 min-w-[180px] max-h-[200px] overflow-y-auto"
      style={{ top: coords.bottom + 4, left: coords.left }}
    >
      {filtered.map((item, i) => (
        <button
          key={item.id}
          type="button"
          className={`flex items-center gap-2 w-full px-2 py-1 text-xs text-left ${
            i === selectedIndex
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted/50'
          }`}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(item)
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="truncate flex-1">{item.title}</span>
          <span className="text-[10px] opacity-60">{item.type}</span>
        </button>
      ))}
    </div>
  )
}
