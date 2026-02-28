import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, ALargeSmall, Regex, Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import type { FileSearchResult } from '../shared'
import { FileIcon } from './FileIcon'

interface SearchPanelProps {
  projectPath: string
  onOpenFile: (path: string) => void
}

export function SearchPanel({ projectPath, onOpenFile }: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [results, setResults] = useState<FileSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await window.api.fs.searchFiles(projectPath, query, { matchCase, regex: useRegex })
        setResults(res)
        setCollapsed(new Set())
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, matchCase, useRegex, projectPath])

  const totalMatches = results.reduce((n, r) => n + r.matches.length, 0)

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  return (
    <div className="h-full flex flex-col bg-surface-1">
      {/* Search input */}
      <div className="px-2 py-2 border-b border-border space-y-1.5">
        <div className="flex items-center gap-1 bg-background border border-border rounded px-2 py-1">
          <Search className="size-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none flex-1 min-w-0"
            placeholder="Search files..."
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            onClick={() => setMatchCase(!matchCase)}
            title="Match Case"
            className={`p-0.5 rounded shrink-0 ${matchCase ? 'bg-muted text-amber-600 dark:text-amber-400' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            <ALargeSmall className="size-3.5" />
          </button>
          <button
            onClick={() => setUseRegex(!useRegex)}
            title="Use Regex"
            className={`p-0.5 rounded shrink-0 ${useRegex ? 'bg-muted text-amber-600 dark:text-amber-400' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            <Regex className="size-3.5" />
          </button>
        </div>
        {query.trim() && (
          <div className="text-xs text-muted-foreground px-0.5">
            {searching ? (
              <span className="flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Searching...</span>
            ) : (
              `${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${results.length} file${results.length !== 1 ? 's' : ''}`
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto py-1 text-sm select-none">
        {results.map((file) => {
          const fileName = file.path.split('/').pop() ?? file.path
          const isCollapsed = collapsed.has(file.path)
          return (
            <div key={file.path}>
              {/* File header */}
              <button
                className="flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-muted/50 text-left"
                onClick={() => toggleCollapse(file.path)}
              >
                {isCollapsed
                  ? <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                  : <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                }
                <FileIcon fileName={fileName} className="size-4 shrink-0 [&_svg]:size-4" />
                <span className="truncate text-foreground">{fileName}</span>
                <span className="text-xs text-muted-foreground ml-auto shrink-0 tabular-nums">{file.matches.length}</span>
              </button>

              {/* Match lines */}
              {!isCollapsed && file.matches.map((match, i) => (
                <button
                  key={i}
                  className="flex items-center gap-2 w-full pl-8 pr-2 py-0.5 hover:bg-muted/50 text-left"
                  onClick={() => onOpenFile(file.path)}
                >
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0 w-8 text-right">{match.line}</span>
                  <HighlightedLine text={match.lineText} query={query} matchCase={matchCase} useRegex={useRegex} />
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HighlightedLine({ text, query, matchCase, useRegex }: { text: string; query: string; matchCase: boolean; useRegex: boolean }) {
  const trimmed = text.trimStart()
  const parts: { text: string; highlight: boolean }[] = []

  try {
    const flags = matchCase ? 'g' : 'gi'
    const escaped = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, flags)

    let lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(trimmed)) !== null) {
      if (m.index > lastIndex) parts.push({ text: trimmed.slice(lastIndex, m.index), highlight: false })
      parts.push({ text: m[0], highlight: true })
      lastIndex = re.lastIndex
      if (m[0].length === 0) { re.lastIndex++; break }
    }
    if (lastIndex < trimmed.length) parts.push({ text: trimmed.slice(lastIndex), highlight: false })
  } catch {
    parts.push({ text: trimmed, highlight: false })
  }

  return (
    <span className="truncate text-xs text-muted-foreground">
      {parts.map((p, i) =>
        p.highlight
          ? <span key={i} className="text-foreground bg-amber-500/30 rounded-sm">{p.text}</span>
          : <span key={i}>{p.text}</span>
      )}
    </span>
  )
}
