import { useState, useEffect, useRef, useCallback } from 'react'
import type { SearchAddon } from '@xterm/addon-search'
import { Search, ChevronUp, ChevronDown, ALargeSmall, X } from 'lucide-react'

interface TerminalSearchBarProps {
  searchAddon: SearchAddon
  onClose: () => void
}

const decorations = {
  matchBackground: '#854d0e',
  matchBorder: '#a16207',
  matchOverviewRuler: '#854d0e',
  activeMatchBackground: '#ca8a04',
  activeMatchBorder: '#eab308',
  activeMatchColorOverviewRuler: '#ca8a04'
}

export function TerminalSearchBar({ searchAddon, onClose }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [resultIndex, setResultIndex] = useState(-1)
  const [resultCount, setResultCount] = useState(0)

  // Subscribe to result changes
  useEffect(() => {
    let disposable: { dispose: () => void } | undefined
    try {
      disposable = searchAddon.onDidChangeResults((results) => {
        if (results) {
          setResultIndex(results.resultIndex)
          setResultCount(results.resultCount)
        } else {
          setResultIndex(-1)
          setResultCount(0)
        }
      })
    } catch {
      // Addon may not be ready
    }
    return () => disposable?.dispose()
  }, [searchAddon])

  // Incremental search on query/caseSensitive change
  useEffect(() => {
    try {
      if (query) {
        searchAddon.findNext(query, { caseSensitive, incremental: true, decorations })
      } else {
        searchAddon.clearDecorations()
        setResultIndex(-1)
        setResultCount(0)
      }
    } catch {
      // Addon may be disposed
    }
  }, [query, caseSensitive, searchAddon])

  const findNext = useCallback(() => {
    try {
      if (query) searchAddon.findNext(query, { caseSensitive, decorations })
    } catch { /* */ }
  }, [query, caseSensitive, searchAddon])

  const findPrevious = useCallback(() => {
    try {
      if (query) searchAddon.findPrevious(query, { caseSensitive, decorations })
    } catch { /* */ }
  }, [query, caseSensitive, searchAddon])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      findPrevious()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      findNext()
    }
  }, [onClose, findNext, findPrevious])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const countDisplay = query
    ? resultCount > 0
      ? `${resultIndex + 1}/${resultCount}`
      : '0/0'
    : ''

  return (
    // Stop propagation so container onClick doesn't steal focus from search input
    <div
      className="absolute top-2 right-4 z-50 flex items-center gap-1 bg-neutral-100 border border-neutral-300 dark:bg-neutral-800 dark:border-neutral-700 rounded-md px-2 py-1 shadow-lg"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Search className="size-3.5 text-neutral-500 dark:text-neutral-400 shrink-0" />
      <input
        ref={inputRef}
        className="bg-transparent text-sm text-neutral-800 placeholder:text-neutral-400 dark:text-neutral-200 dark:placeholder:text-neutral-500 outline-none w-40"
        placeholder="Find..."
        aria-label="Search terminal"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums shrink-0 min-w-[3ch] text-right">
        {countDisplay}
      </span>
      <button onClick={findPrevious} title="Previous (Shift+Enter)" className="p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded">
        <ChevronUp className="size-4 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200" />
      </button>
      <button onClick={findNext} title="Next (Enter)" className="p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded">
        <ChevronDown className="size-4 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200" />
      </button>
      <button
        onClick={() => setCaseSensitive(!caseSensitive)}
        title="Case Sensitive"
        className={`p-0.5 rounded ${caseSensitive ? 'bg-neutral-300 text-amber-600 dark:bg-neutral-600 dark:text-amber-400' : 'hover:bg-neutral-200 text-neutral-500 dark:hover:bg-neutral-700 dark:text-neutral-400'}`}
      >
        <ALargeSmall className="size-4" />
      </button>
      <button onClick={onClose} title="Close (Escape)" className="p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded">
        <X className="size-3.5 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200" />
      </button>
    </div>
  )
}
