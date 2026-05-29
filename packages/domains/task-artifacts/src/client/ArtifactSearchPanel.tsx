import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, ALargeSmall, Regex, Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import type { TaskArtifact } from '@slayzone/task/shared'
import { getEffectiveRenderMode, isBinaryRenderMode } from '@slayzone/task/shared'

interface ArtifactSearchPanelProps {
  artifacts: TaskArtifact[]
  readContent: (id: string) => Promise<string | null>
  getArtifactPath: (artifact: TaskArtifact) => string
  onSelectResult: (
    artifactId: string,
    payload: {
      query: string
      matchCase: boolean
      useRegex: boolean
      matchIndex: number
    }
  ) => void
}

interface SearchMatch {
  line: number
  lineText: string
  /** 0-based index of this line's first match within the file's full match list. */
  matchIndex: number
}

interface ArtifactResult {
  artifact: TaskArtifact
  path: string
  matches: SearchMatch[]
}

export function ArtifactSearchPanel({
  artifacts,
  readContent,
  getArtifactPath,
  onSelectResult
}: ArtifactSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [results, setResults] = useState<ArtifactResult[]>([])
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const contentCache = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Invalidate cache when artifacts change
  const artifactIds = useMemo(
    () =>
      artifacts
        .map((a) => a.id)
        .sort()
        .join(','),
    [artifacts]
  )
  useEffect(() => {
    const current = new Set(artifacts.map((a) => a.id))
    for (const key of contentCache.current.keys()) {
      if (!current.has(key)) contentCache.current.delete(key)
    }
  }, [artifactIds, artifacts])

  // Text artifacts only
  const textArtifacts = useMemo(
    () =>
      artifacts.filter((a) => !isBinaryRenderMode(getEffectiveRenderMode(a.title, a.render_mode))),
    [artifacts]
  )

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
        const flags = matchCase ? 'g' : 'gi'
        const escaped = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // Validate once so malformed user regex short-circuits via the outer
        // try/catch before we read every file.
        void new RegExp(escaped, flags)

        // Load content for all text artifacts (cached)
        await Promise.all(
          textArtifacts.map(async (a) => {
            if (!contentCache.current.has(a.id)) {
              const c = await readContent(a.id)
              if (c != null) contentCache.current.set(a.id, c)
            }
          })
        )

        const res: ArtifactResult[] = []
        for (const artifact of textArtifacts) {
          const content = contentCache.current.get(artifact.id)
          if (!content) continue
          const lines = content.split('\n')
          const matches: SearchMatch[] = []
          let globalCount = 0
          for (let i = 0; i < lines.length; i++) {
            // Count matches in this line with a fresh regex so `g` flag state
            // is isolated per line.
            const lineRe = new RegExp(escaped, flags)
            let n = 0
            let m: RegExpExecArray | null
            while ((m = lineRe.exec(lines[i])) !== null) {
              if (m[0].length === 0) {
                lineRe.lastIndex++
                continue
              }
              n++
            }
            if (n > 0) {
              matches.push({ line: i + 1, lineText: lines[i], matchIndex: globalCount })
              globalCount += n
            }
          }
          if (matches.length > 0) {
            res.push({ artifact, path: getArtifactPath(artifact), matches })
          }
        }
        setResults(res)
        setCollapsed(new Set())
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, matchCase, useRegex, textArtifacts, readContent, getArtifactPath])

  const totalMatches = results.reduce((n, r) => n + r.matches.length, 0)

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="h-full flex flex-col">
      {/* Search input */}
      <div className="px-2 py-2 border-b border-border space-y-1.5">
        <div className="flex items-center gap-1 bg-background border border-border rounded px-2 py-1">
          <Search className="size-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            className="bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none flex-1 min-w-0"
            placeholder="Search artifacts..."
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
          <div className="text-[10px] text-muted-foreground px-0.5">
            {searching ? (
              <span className="flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> Searching...
              </span>
            ) : (
              `${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${results.length} file${results.length !== 1 ? 's' : ''}`
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto py-1 text-sm select-none">
        {results.map((file) => {
          const isCollapsed = collapsed.has(file.artifact.id)
          return (
            <div key={file.artifact.id}>
              <button
                className="flex items-center gap-1.5 w-full px-2 py-0.5 hover:bg-muted/50 text-left"
                onClick={() => toggleCollapse(file.artifact.id)}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="truncate text-xs text-foreground">{file.path}</span>
                <span className="text-[10px] text-muted-foreground ml-auto shrink-0 tabular-nums">
                  {file.matches.length}
                </span>
              </button>

              {!isCollapsed &&
                file.matches.map((match, i) => (
                  <button
                    key={i}
                    className="flex items-center gap-2 w-full pl-7 pr-2 py-0.5 hover:bg-muted/50 text-left"
                    onClick={() =>
                      onSelectResult(file.artifact.id, {
                        query,
                        matchCase,
                        useRegex,
                        matchIndex: match.matchIndex
                      })
                    }
                  >
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-6 text-right">
                      {match.line}
                    </span>
                    <HighlightedLine
                      text={match.lineText}
                      query={query}
                      matchCase={matchCase}
                      useRegex={useRegex}
                    />
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HighlightedLine({
  text,
  query,
  matchCase,
  useRegex
}: {
  text: string
  query: string
  matchCase: boolean
  useRegex: boolean
}) {
  const trimmed = text.trimStart()
  const parts: { text: string; highlight: boolean }[] = []

  try {
    const flags = matchCase ? 'g' : 'gi'
    const escaped = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, flags)

    let lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(trimmed)) !== null) {
      if (m.index > lastIndex)
        parts.push({ text: trimmed.slice(lastIndex, m.index), highlight: false })
      parts.push({ text: m[0], highlight: true })
      lastIndex = re.lastIndex
      if (m[0].length === 0) {
        re.lastIndex++
        break
      }
    }
    if (lastIndex < trimmed.length) parts.push({ text: trimmed.slice(lastIndex), highlight: false })
  } catch {
    parts.push({ text: trimmed, highlight: false })
  }

  return (
    <span className="truncate text-[10px] text-muted-foreground">
      {parts.map((p, i) =>
        p.highlight ? (
          <span key={i} className="text-foreground bg-amber-500/30 rounded-sm">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </span>
  )
}
