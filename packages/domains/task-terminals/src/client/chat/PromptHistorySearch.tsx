import { useState } from 'react'
import { cn } from '@slayzone/ui'
import { searchPrompts } from './prompt-history'

/**
 * Ctrl+R prompt-history search above the composer. Type to filter (newest
 * first); Ctrl+R / ↓ older match, ↑ newer; Enter puts the match into the
 * composer, Esc closes. Keys stop at this input so the panel's Esc (stop the
 * turn) doesn't fire.
 */
export function PromptHistorySearch({
  entries,
  onPick,
  onClose
}: {
  entries: string[]
  onPick: (text: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const matches = searchPrompts(entries, query)
  const selected = Math.min(index, Math.max(0, matches.length - 1))

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const older = e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'r')
    if (older || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setIndex(older ? Math.min(selected + 1, matches.length - 1) : Math.max(selected - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (matches[selected] !== undefined) onPick(matches[selected])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      data-testid="chat-prompt-history-search"
      className="absolute bottom-full left-0 right-0 mb-2 z-20 rounded-md border border-border bg-popover text-popover-foreground shadow-md overflow-hidden"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={onKeyDown}
          onBlur={onClose}
          placeholder="Search prompt history…"
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
        />
        <span className="shrink-0 text-[10px] text-muted-foreground">↵ use · esc close</span>
      </div>
      {matches.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No matching prompts</div>
      ) : (
        <ul role="listbox" className="max-h-60 overflow-y-auto py-1">
          {matches.map((text, i) => (
            <li
              key={`${i}:${text}`}
              role="option"
              aria-selected={i === selected}
              // Keep focus in the input so blur doesn't close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(text)}
              onMouseEnter={() => setIndex(i)}
              className={cn(
                'cursor-pointer truncate px-3 py-1 text-xs',
                i === selected && 'bg-accent text-accent-foreground'
              )}
            >
              <Highlighted text={text} query={query} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-primary/25 text-foreground rounded-sm">
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  )
}
