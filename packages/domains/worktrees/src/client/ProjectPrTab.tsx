import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  ExternalLink,
  GitPullRequest,
  GitMerge,
  CircleDot,
  CircleX,
  Loader2
} from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import type { GhPullRequest } from '../shared/types'

interface ProjectPrTabProps {
  projectPath: string | null
  visible: boolean
  tasks: Task[]
  onTaskClick?: (task: Task) => void
}

interface PrFilterState {
  sortBy: 'newest' | 'oldest' | 'title'
  filterAuthor: string
  filterReview: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
}

const DEFAULT_FILTER: PrFilterState = {
  sortBy: 'newest',
  filterAuthor: '',
  filterReview: ''
}

function usePrFilterState(projectId: string | null) {
  const [filter, setFilter] = useState<PrFilterState>(DEFAULT_FILTER)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const key = projectId ? `pr-filter:${projectId}` : null

  useEffect(() => {
    if (!key) return
    ;(async () => {
      try {
        const value = await window.api.settings.get(key)
        if (value) setFilter({ ...DEFAULT_FILTER, ...JSON.parse(value) })
      } catch { /* ignore */ }
    })()
  }, [key])

  const updateFilter = useCallback((next: Partial<PrFilterState>) => {
    setFilter(prev => {
      const updated = { ...prev, ...next }
      if (key) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
          window.api.settings.set(key, JSON.stringify(updated))
        }, 500)
      }
      return updated
    })
  }, [key])

  return { filter, updateFilter }
}

export function ProjectPrTab({ projectPath, visible, tasks, onTaskClick }: ProjectPrTabProps) {
  const [prs, setPrs] = useState<GhPullRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Extract projectId from path for persistence key
  const projectId = projectPath
  const { filter, updateFilter } = usePrFilterState(projectId)

  useEffect(() => {
    if (!visible || !projectPath) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const list = await window.api.git.listOpenPrs(projectPath)
        if (!cancelled) setPrs(list)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [visible, projectPath])

  // Build map of PR URL → task
  const prTaskMap = new Map<string, Task>()
  for (const task of tasks) {
    if (task.pr_url) prTaskMap.set(task.pr_url, task)
  }

  // Unique authors for filter
  const authors = useMemo(() => {
    const set = new Set(prs.map(p => p.author))
    return Array.from(set).sort()
  }, [prs])

  // Filter + sort
  const filteredPrs = useMemo(() => {
    let result = [...prs]
    if (filter.filterAuthor) {
      result = result.filter(p => p.author === filter.filterAuthor)
    }
    if (filter.filterReview) {
      result = result.filter(p => p.reviewDecision === filter.filterReview)
    }
    switch (filter.sortBy) {
      case 'oldest':
        result.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        break
      case 'title':
        result.sort((a, b) => a.title.localeCompare(b.title))
        break
      case 'newest':
      default:
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    return result
  }, [prs, filter])

  if (!projectPath) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Set a project path to view pull requests</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-xs text-destructive">{error}</div>
    )
  }

  if (prs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-2">
          <GitPullRequest className="h-6 w-6 text-muted-foreground mx-auto" />
          <p className="text-xs text-muted-foreground">No open pull requests</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Filter toolbar */}
      <div className="shrink-0 px-3 py-2 border-b flex items-center gap-2 flex-wrap">
        {/* Sort */}
        <select
          value={filter.sortBy}
          onChange={e => updateFilter({ sortBy: e.target.value as PrFilterState['sortBy'] })}
          className="h-6 px-2 text-[11px] rounded border bg-transparent text-foreground"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="title">Title</option>
        </select>
        {/* Author filter */}
        {authors.length > 1 && (
          <select
            value={filter.filterAuthor}
            onChange={e => updateFilter({ filterAuthor: e.target.value })}
            className="h-6 px-2 text-[11px] rounded border bg-transparent text-foreground"
          >
            <option value="">All authors</option>
            {authors.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        {/* Review filter */}
        <select
          value={filter.filterReview}
          onChange={e => updateFilter({ filterReview: e.target.value as PrFilterState['filterReview'] })}
          className="h-6 px-2 text-[11px] rounded border bg-transparent text-foreground"
        >
          <option value="">All reviews</option>
          <option value="APPROVED">Approved</option>
          <option value="CHANGES_REQUESTED">Changes requested</option>
          <option value="REVIEW_REQUIRED">Review required</option>
        </select>
        {filteredPrs.length !== prs.length && (
          <span className="text-[10px] text-muted-foreground ml-auto">{filteredPrs.length}/{prs.length}</span>
        )}
      </div>

      {/* PR list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filteredPrs.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">No PRs match filters</div>
        ) : (
          <div className="py-1">
            {filteredPrs.map((pr) => {
              const linkedTask = prTaskMap.get(pr.url)
              const age = getAge(pr.createdAt)
              return (
                <div
                  key={pr.number}
                  className="flex items-start gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors"
                >
                  <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium truncate">{pr.title}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">#{pr.number}</span>
                      <AgeBadge age={age} />
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {pr.headRefName} → {pr.baseRefName} · {pr.author}
                    </div>
                    {linkedTask && (
                      <button
                        className="text-[10px] text-primary hover:underline mt-0.5"
                        onClick={() => onTaskClick?.(linkedTask)}
                      >
                        {linkedTask.title}
                      </button>
                    )}
                  </div>
                  <button
                    className="shrink-0 p-1 hover:bg-accent rounded"
                    onClick={() => window.api.shell.openExternal(pr.url)}
                    title="Open in browser"
                  >
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Age helpers ---

function getAge(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}

function AgeBadge({ age }: { age: number }) {
  if (age < 7) return null
  let className: string
  if (age < 14) className = 'text-yellow-500 bg-yellow-500/10'
  else if (age < 30) className = 'text-orange-500 bg-orange-500/10'
  else className = 'text-red-500 bg-red-500/10'

  return (
    <span className={cn('px-1.5 py-px rounded text-[9px] font-medium shrink-0', className)}>
      {age}d
    </span>
  )
}

function PrStateIcon({ state, isDraft }: { state: GhPullRequest['state']; isDraft: boolean }) {
  if (isDraft) return <GitPullRequest className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
  if (state === 'MERGED') return <GitMerge className="h-4 w-4 text-purple-500 shrink-0 mt-0.5" />
  if (state === 'CLOSED') return <CircleX className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
  return <CircleDot className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
}
