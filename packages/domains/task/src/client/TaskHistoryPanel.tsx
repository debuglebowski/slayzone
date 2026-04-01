import type React from 'react'
import { useEffect, useState } from 'react'
import { formatDistanceToNowStrict, parseISO } from 'date-fns'
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
  XCircle,
} from 'lucide-react'
import type { ActivityEvent, ActivityEventCursor, AutomationActionRun } from '@slayzone/history/shared'
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
        testId: 'history-marker-task-created',
      }
    case 'task.title_changed':
    case 'task.description_changed':
      return {
        icon: <Pencil className="size-3.5" />,
        wrapperClassName: 'text-violet-400',
        testId: `history-marker-${event.kind.replace(/\./g, '-')}`,
      }
    case 'task.status_changed':
      return {
        icon: <CheckCircle2 className="size-3.5" />,
        wrapperClassName: 'text-emerald-500',
        testId: 'history-marker-task-status-changed',
      }
    case 'task.priority_changed':
      return {
        icon: <Flag className="size-3.5" />,
        wrapperClassName: 'text-amber-400',
        testId: 'history-marker-task-priority-changed',
      }
    case 'task.assignee_changed':
      return {
        icon: <User className="size-3.5" />,
        wrapperClassName: 'text-cyan-400',
        testId: 'history-marker-task-assignee-changed',
      }
    case 'task.due_date_changed':
      return {
        icon: <Calendar className="size-3.5" />,
        wrapperClassName: 'text-orange-400',
        testId: 'history-marker-task-due-date-changed',
      }
    case 'task.tags_changed':
      return {
        icon: <Tags className="size-3.5" />,
        wrapperClassName: 'text-pink-400',
        testId: 'history-marker-task-tags-changed',
      }
    case 'task.archived':
      return {
        icon: <Archive className="size-3.5" />,
        wrapperClassName: 'text-muted-foreground',
        testId: 'history-marker-task-archived',
      }
    case 'task.unarchived':
    case 'task.restored':
      return {
        icon: <RotateCcw className="size-3.5" />,
        wrapperClassName: 'text-lime-400',
        testId: `history-marker-${event.kind.replace(/\./g, '-')}`,
      }
    case 'task.deleted':
      return {
        icon: <Trash2 className="size-3.5" />,
        wrapperClassName: 'text-destructive',
        testId: 'history-marker-task-deleted',
      }
    case 'automation.run_failed':
      return {
        icon: <XCircle className="size-3.5" />,
        wrapperClassName: 'text-destructive',
        testId: 'history-marker-automation-run-failed',
      }
    case 'automation.run_succeeded':
      return {
        icon: <CheckCircle2 className="size-3.5" />,
        wrapperClassName: 'text-emerald-500',
        testId: 'history-marker-automation-run-succeeded',
      }
  }

  assertNever(event.kind)
}

export function TaskHistoryPanel({ taskId }: TaskHistoryPanelProps): React.JSX.Element {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<ActivityEventCursor | null>(null)
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({})
  const [actionRunsByRunId, setActionRunsByRunId] = useState<Record<string, AutomationActionRun[]>>({})
  const [, setTimestampTick] = useState(0)

  useEffect(() => {
    const interval = window.setInterval(() => {
      setTimestampTick((current) => current + 1)
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadingMore(false)
    setNextCursor(null)
    setExpandedRunIds({})
    setActionRunsByRunId({})
    window.api.history.listForTask(taskId, { limit: TASK_HISTORY_PAGE_SIZE }).then((result) => {
      if (!active) return
      setEvents(result.events)
      setNextCursor(result.nextCursor)
      setLoading(false)
    })
    return () => { active = false }
  }, [taskId])

  async function toggleAutomationDetails(runId: string): Promise<void> {
    setExpandedRunIds((prev) => ({ ...prev, [runId]: !prev[runId] }))
    if (actionRunsByRunId[runId]) return
    const runs = await window.api.history.getAutomationActionRuns(runId)
    setActionRunsByRunId((prev) => ({ ...prev, [runId]: runs }))
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return

    setLoadingMore(true)
    try {
      const result = await window.api.history.listForTask(taskId, {
        limit: TASK_HISTORY_PAGE_SIZE,
        before: nextCursor,
      })
      setEvents((prev) => [...prev, ...result.events])
      setNextCursor(result.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) {
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
        const actionRuns = actionRunsByRunId[event.entityId] ?? []
        const marker = getEventMarkerMeta(event)

        return (
          <div key={event.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-4">
            <div className="relative flex justify-center">
              {index < events.length - 1 && (
                <div className="absolute bottom-[-20px] left-1/2 top-6 w-px -translate-x-1/2 bg-border" aria-hidden="true" />
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
                <div className="min-w-0 flex-1 text-sm font-medium leading-6 text-foreground">{event.summary}</div>
                <div className="flex shrink-0 items-center gap-3">
                  {isAutomation && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={isExpanded ? 'Hide automation run details' : 'Show automation run details'}
                      className="h-auto px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
                      onClick={() => void toggleAutomationDetails(event.entityId)}
                    >
                      {isExpanded ? 'Hide details' : 'Show details'}
                    </Button>
                  )}
                  <div className="shrink-0 text-xs text-muted-foreground">{formatHistoryTimestamp(event.createdAt)}</div>
                </div>
              </div>
              {isAutomation && isExpanded && (
                <div className="mt-3 rounded-lg border border-border bg-muted/20">
                  {actionRuns.map((run, actionIndex) => (
                    <div key={run.id} className="border-b border-border px-3 py-3 last:border-b-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <div className="text-xs font-medium text-foreground">{run.command}</div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{run.status}</div>
                        {run.durationMs !== null && (
                          <div className="text-[11px] text-muted-foreground">{run.durationMs} ms</div>
                        )}
                      </div>
                      {run.outputTail && (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background/70 p-2 text-[11px] leading-5 text-foreground">
                          {run.outputTail}
                        </pre>
                      )}
                      {run.error && <div className="mt-2 text-xs text-destructive">{run.error}</div>}
                      {!run.outputTail && !run.error && actionIndex === actionRuns.length - 1 && run.status === 'success' && (
                        <div className="mt-2 text-xs text-muted-foreground">Completed without saved output.</div>
                      )}
                    </div>
                  ))}
                  {actionRuns.length === 0 && <div className="px-3 py-3 text-xs text-muted-foreground">No action details.</div>}
                </div>
              )}
            </div>
          </div>
        )
      })}
      {nextCursor && (
        <Button type="button" variant="outline" size="sm" className="ml-10" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading more...' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
