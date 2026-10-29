import type React from 'react'
import { useEffect, useState } from 'react'
import { useTRPCClient } from './trpc'
import { formatDistanceToNowStrict, parseISO } from 'date-fns'
import { useDepsChanged, useVisibleInterval } from '@slayzone/ui'
import {
  Archive,
  Calendar,
  CheckCircle2,
  Clock3,
  Flag,
  Pencil,
  Plus,
  RotateCcw,
  Tags,
  Trash2,
  User,
  XCircle
} from 'lucide-react'
import type {
  ActivityEvent,
  ActivityEventCursor,
  AutomationActionRun
} from '@slayzone/history/shared'
import { Button } from '@slayzone/ui'

interface TaskHistoryPanelProps {
  taskId: string
}

const TASK_HISTORY_PAGE_SIZE = 50

function assertNever(value: never): never {
  throw new Error(`Unhandled history event kind: ${value}`)
}

function formatHistoryTimestamp(value: string): string {
  try {
    return formatDistanceToNowStrict(parseISO(value), { addSuffix: true })
  } catch {
    return value
  }
}

function getEventMarkerMeta(event: ActivityEvent): {
  icon: React.JSX.Element
  wrapperClassName: string
  testId: string
} {
  switch (event.kind) {
    case 'task.created':
      return {
        icon: <Plus className="size-3.5" />,
        wrapperClassName: 'text-sky-400',
        testId: 'history-marker-task-created'
      }
    case 'task.title_changed':
    case 'task.description_changed':
      return {
        icon: <Pencil className="size-3.5" />,
        wrapperClassName: 'text-violet-400',
        testId: `history-marker-${event.kind.replace(/\./g, '-')}`
      }
    case 'task.status_changed':
      return {
        icon: <CheckCircle2 className="size-3.5" />,
        wrapperClassName: 'text-emerald-500',
        testId: 'history-marker-task-status-changed'
      }
    case 'task.priority_changed':
      return {
        icon: <Flag className="size-3.5" />,
        wrapperClassName: 'text-amber-400',
        testId: 'history-marker-task-priority-changed'
      }
    case 'task.assignee_changed':
      return {
        icon: <User className="size-3.5" />,
        wrapperClassName: 'text-cyan-400',
        testId: 'history-marker-task-assignee-changed'
      }
    case 'task.due_date_changed':
      return {
        icon: <Calendar className="size-3.5" />,
        wrapperClassName: 'text-orange-400',
        testId: 'history-marker-task-due-date-changed'
      }
    case 'task.tags_changed':
      return {
        icon: <Tags className="size-3.5" />,
        wrapperClassName: 'text-pink-400',
        testId: 'history-marker-task-tags-changed'
      }
    case 'task.archived':
      return {
        icon: <Archive className="size-3.5" />,
        wrapperClassName: 'text-muted-foreground',
        testId: 'history-marker-task-archived'
      }
    case 'task.unarchived':
    case 'task.restored':
      return {
        icon: <RotateCcw className="size-3.5" />,
        wrapperClassName: 'text-lime-400',
        testId: `history-marker-${event.kind.replace(/\./g, '-')}`
      }
    case 'task.deleted':
      return {
        icon: <Trash2 className="size-3.5" />,
        wrapperClassName: 'text-destructive',
        testId: 'history-marker-task-deleted'
      }
    case 'automation.run_failed':
      return {
        icon: <XCircle className="size-3.5" />,
        wrapperClassName: 'text-destructive',
        testId: 'history-marker-automation-run-failed'
      }
    case 'automation.run_succeeded':
      return {
        icon: <CheckCircle2 className="size-3.5" />,
        wrapperClassName: 'text-emerald-500',
        testId: 'history-marker-automation-run-succeeded'
      }
  }

  assertNever(event.kind)
}

function sameCursor(a: ActivityEventCursor | null, b: ActivityEventCursor): boolean {
  return a !== null && a.createdAt === b.createdAt && a.id === b.id
}

interface HistoryList {
  events: ActivityEvent[]
  /** Where the next "Load more" page starts; null = no more pages. */
  nextCursor: ActivityEventCursor | null
  /** The page at `nextCursor` failed to load. Belongs to this list: replacing it clears it. */
  nextPageFailed: boolean
}

/** One automation run's action steps: in flight, failed, or loaded. */
type RunDetails = 'loading' | 'failed' | AutomationActionRun[]

interface RunDetailsState {
  /** Bumped on every task (or hub client) change: a fetch lands only on its own. */
  generation: number
  byRunId: Record<string, RunDetails>
}

export function TaskHistoryPanel({ taskId }: TaskHistoryPanelProps): React.JSX.Element {
  const trpcClient = useTRPCClient()
  // One state: a "Load more" page appends only onto the list it continues.
  const [list, setList] = useState<HistoryList>({
    events: [],
    nextCursor: null,
    nextPageFailed: false
  })
  const { events, nextCursor, nextPageFailed } = list
  // Page 1 of this task's history. 'failed' only while there is no list to show:
  // a failed refresh of a loaded list (tab re-show) keeps that list on screen.
  const [firstPage, setFirstPage] = useState<'loading' | 'failed' | 'loaded'>('loading')
  // Bumped by Retry: re-runs the page-1 load.
  const [firstPageAttempt, setFirstPageAttempt] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({})
  const [runDetails, setRunDetails] = useState<RunDetailsState>({ generation: 0, byRunId: {} })
  const [, setTimestampTick] = useState(0)

  useVisibleInterval(() => setTimestampTick((current) => current + 1), 60_000, {
    runOnVisible: true
  })

  // Another task's history (or hub client): start over — spinner, no expanded runs.
  // Adjusted while rendering, so no commit shows the previous task's state.
  if (useDepsChanged([taskId, trpcClient])) {
    setFirstPage('loading')
    setLoadingMore(false)
    setList((prev) => ({ events: prev.events, nextCursor: null, nextPageFailed: false }))
    setExpandedRunIds({})
    setRunDetails((prev) => ({ generation: prev.generation + 1, byRunId: {} }))
  }

  // Page 1 on mount, task change, Retry, AND every tab re-show (<Activity> re-runs
  // this): the panel has no live updates, so the re-show reload is its only
  // refresh. It replaces the list in place: no spinner, expanded runs kept.
  useEffect(() => {
    let active = true
    trpcClient.history.listForTask
      .query({ taskId, options: { limit: TASK_HISTORY_PAGE_SIZE } })
      .then((result) => {
        if (!active) return
        setList({ events: result.events, nextCursor: result.nextCursor, nextPageFailed: false })
        setFirstPage('loaded')
      })
      .catch(() => {
        if (!active) return
        setFirstPage((prev) => (prev === 'loaded' ? prev : 'failed'))
      })
    return () => {
      active = false
    }
  }, [taskId, trpcClient, firstPageAttempt])

  function retryFirstPage(): void {
    setFirstPage('loading')
    setFirstPageAttempt((n) => n + 1)
  }

  function loadRunDetails(runId: string): void {
    const { generation } = runDetails
    const land = (details: RunDetails): void =>
      setRunDetails((prev) =>
        prev.generation === generation
          ? { generation, byRunId: { ...prev.byRunId, [runId]: details } }
          : prev
      )
    land('loading')
    trpcClient.history.getAutomationActionRuns
      .query({ runId })
      .then(land)
      .catch(() => land('failed'))
  }

  function toggleAutomationDetails(runId: string): void {
    const expanding = expandedRunIds[runId] !== true
    setExpandedRunIds((prev) => ({ ...prev, [runId]: expanding }))
    // Fetched once per task; expanding a run whose fetch failed tries again.
    const details = runDetails.byRunId[runId]
    if (expanding && (details === undefined || details === 'failed')) loadRunDetails(runId)
  }

  async function loadMore(): Promise<void> {
    const before = nextCursor
    if (!before || loadingMore) return

    setLoadingMore(true)
    try {
      const result = await trpcClient.history.listForTask
        .query({
          taskId,
          options: {
            limit: TASK_HISTORY_PAGE_SIZE,
            before
          }
        })
        .catch(() => null)
      // Append (or mark the page failed) only if the list still ends where this page
      // starts. A page-1 reload (tab re-show) or a task change that landed meanwhile
      // replaced it: appending would leave a gap, or another task's events.
      setList((prev) => {
        if (!sameCursor(prev.nextCursor, before)) return prev
        if (!result) return { ...prev, nextPageFailed: true }
        return {
          events: [...prev.events, ...result.events],
          nextCursor: result.nextCursor,
          nextPageFailed: false
        }
      })
    } finally {
      setLoadingMore(false)
    }
  }

  if (firstPage === 'failed') {
    return (
      <div
        data-testid="task-history-load-error"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <span className="text-destructive">Couldn't load history.</span>
        <button type="button" className="underline hover:text-foreground" onClick={retryFirstPage}>
          Retry
        </button>
      </div>
    )
  }

  if (firstPage === 'loading') {
    return <div className="text-sm text-muted-foreground">Loading history...</div>
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground">
            <Clock3 className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">No history yet</div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Task changes and automation activity will appear here once this task starts changing.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {events.map((event, index) => {
        const isAutomation = event.entityType === 'automation_run'
        const isExpanded = expandedRunIds[event.entityId] === true
        const details = runDetails.byRunId[event.entityId] ?? 'loading'
        const actionRuns = Array.isArray(details) ? details : null
        const marker = getEventMarkerMeta(event)

        return (
          <div key={event.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-4">
            <div className="relative flex justify-center">
              {index < events.length - 1 && (
                <div
                  className="absolute bottom-[-20px] left-1/2 top-6 w-px -translate-x-1/2 bg-border"
                  aria-hidden="true"
                />
              )}
              <div
                data-testid={marker.testId}
                className={`mt-px flex size-6 items-center justify-center rounded-full border border-border bg-background shadow-sm ${marker.wrapperClassName}`}
              >
                {marker.icon}
              </div>
            </div>

            <div className="min-w-0">
              <div className="flex min-h-6 items-baseline gap-3">
                <div className="min-w-0 flex-1 text-sm font-medium leading-6 text-foreground">
                  {event.summary}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {isAutomation && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={
                        isExpanded ? 'Hide automation run details' : 'Show automation run details'
                      }
                      className="h-auto px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
                      onClick={() => toggleAutomationDetails(event.entityId)}
                    >
                      {isExpanded ? 'Hide details' : 'Show details'}
                    </Button>
                  )}
                  <div className="shrink-0 text-xs text-muted-foreground">
                    {formatHistoryTimestamp(event.createdAt)}
                  </div>
                </div>
              </div>
              {isAutomation && isExpanded && (
                <div className="mt-3 rounded-lg border border-border bg-muted/20">
                  {details === 'loading' && (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      Loading details...
                    </div>
                  )}
                  {details === 'failed' && (
                    <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                      <span className="text-destructive">Couldn't load details.</span>
                      <button
                        type="button"
                        className="underline hover:text-foreground"
                        onClick={() => loadRunDetails(event.entityId)}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {actionRuns?.map((run, actionIndex) => (
                    <div key={run.id} className="border-b border-border px-3 py-3 last:border-b-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <div className="text-xs font-medium text-foreground">{run.command}</div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {run.status}
                        </div>
                        {run.durationMs !== null && (
                          <div className="text-[11px] text-muted-foreground">
                            {run.durationMs} ms
                          </div>
                        )}
                      </div>
                      {run.outputTail && (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background/70 p-2 text-[11px] leading-5 text-foreground">
                          {run.outputTail}
                        </pre>
                      )}
                      {run.error && (
                        <div className="mt-2 text-xs text-destructive">{run.error}</div>
                      )}
                      {!run.outputTail &&
                        !run.error &&
                        actionIndex === actionRuns.length - 1 &&
                        run.status === 'success' && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            Completed without saved output.
                          </div>
                        )}
                    </div>
                  ))}
                  {actionRuns?.length === 0 && (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      No action details.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
      {nextCursor && (
        <div className="ml-10 flex items-center gap-2">
          {nextPageFailed && !loadingMore && (
            <span className="text-sm text-destructive">Couldn't load more history.</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading more...' : nextPageFailed ? 'Retry' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
