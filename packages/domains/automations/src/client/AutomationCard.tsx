import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatDistanceToNowStrict, parseISO } from 'date-fns'
import { cn, Switch, Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@slayzone/ui'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  MoreHorizontal,
  Pencil,
  Play,
  TimerReset,
  Trash2,
  XCircle,
} from 'lucide-react'
import type { Automation, AutomationRun } from '@slayzone/automations/shared'
import type { AutomationActionRun } from '@slayzone/history/shared'

interface RunDetailEntry {
  key: string
  title?: string
  body?: string
  meta?: string
  markerClassName: string
  markerIcon: React.ReactNode
  testId: string
}

function isCatchupRun(run: AutomationRun): boolean {
  const ev = run.trigger_event as { catchup?: boolean } | null | undefined
  return ev?.catchup === true
}

function formatRelativeTime(value: string | null): string | null {
  if (!value) return null
  try {
    return formatDistanceToNowStrict(parseISO(value), { addSuffix: true })
  } catch {
    const maybeIso = value.endsWith('Z') ? value : `${value}Z`
    try {
      return formatDistanceToNowStrict(parseISO(maybeIso), { addSuffix: true })
    } catch {
      return value
    }
  }
}


function getStatusMeta(
  status: AutomationRun['status'] | AutomationActionRun['status'],
  testIdPrefix: 'automation-run-marker' | 'automation-step-marker',
): {
  label: string
  icon: React.ReactNode
  badgeClassName: string
  markerClassName: string
  labelClassName: string
  testId: string
} {
  switch (status) {
    case 'success':
      return {
        label: 'Succeeded',
        icon: <CheckCircle2 className="size-5" />,
        badgeClassName: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
        markerClassName: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
        labelClassName: 'text-emerald-500',
        testId: `${testIdPrefix}-success`,
      }
    case 'error':
      return {
        label: 'Failed',
        icon: <XCircle className="size-5" />,
        badgeClassName: 'text-destructive bg-destructive/10 border-destructive/20',
        markerClassName: 'text-destructive bg-destructive/10 border-destructive/20',
        labelClassName: 'text-destructive',
        testId: `${testIdPrefix}-error`,
      }
    case 'running':
      return {
        label: 'Running',
        icon: <Clock3 className="size-5" />,
        badgeClassName: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
        markerClassName: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
        labelClassName: 'text-amber-400',
        testId: `${testIdPrefix}-running`,
      }
    case 'skipped':
      return {
        label: 'Skipped',
        icon: <TimerReset className="size-5" />,
        badgeClassName: 'text-muted-foreground bg-muted/60 border-border',
        markerClassName: 'text-muted-foreground bg-muted/60 border-border',
        labelClassName: 'text-muted-foreground',
        testId: `${testIdPrefix}-skipped`,
      }
  }
}

function getOutputMarkerMeta(): Pick<RunDetailEntry, 'markerClassName' | 'markerIcon' | 'testId'> {
  return {
    markerClassName: 'text-muted-foreground bg-muted/40 border-border',
    markerIcon: <div className="size-1.5 rounded-full bg-current" />,
    testId: 'automation-step-marker-output',
  }
}

function buildRunDetailEntries(run: AutomationRun, actionRuns: AutomationActionRun[]): RunDetailEntry[] {
  const entries: RunDetailEntry[] = []

  for (const actionRun of actionRuns) {
    const statusMeta = getStatusMeta(actionRun.status, 'automation-step-marker')
    const metaParts = [statusMeta.label]
    if (actionRun.durationMs !== null) metaParts.push(`${actionRun.durationMs} ms`)

    entries.push({
      key: `${actionRun.id}-command`,
      title: actionRun.command || actionRun.actionType,
      meta: metaParts.join(' · '),
      markerClassName: statusMeta.markerClassName,
      markerIcon: statusMeta.icon,
      testId: statusMeta.testId,
    })

    if (actionRun.outputTail) {
      const outputMeta = getOutputMarkerMeta()
      entries.push({
        key: `${actionRun.id}-output`,
        body: actionRun.outputTail,
        markerClassName: outputMeta.markerClassName,
        markerIcon: outputMeta.markerIcon,
        testId: outputMeta.testId,
      })
    }

    if (actionRun.error) {
      entries.push({
        key: `${actionRun.id}-error`,
        body: actionRun.error,
        markerClassName: 'text-destructive bg-destructive/10 border-destructive/20',
        markerIcon: <XCircle className="size-3" />,
        testId: 'automation-step-marker-error',
      })
    }
  }

  if (run.error) {
    entries.push({
      key: `${run.id}-error`,
      body: run.error,
      markerClassName: 'text-destructive bg-destructive/10 border-destructive/20',
      markerIcon: <XCircle className="size-3" />,
      testId: 'automation-step-marker-error',
    })
  }

  return entries
}


function RunTimeline({ children }: { children: React.ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    const line = lineRef.current
    if (!wrapper || !line) return
    const start = wrapper.querySelector('[data-timeline-start]') as HTMLElement | null
    const dots = wrapper.querySelectorAll('[data-timeline-dot]')
    const last = dots.length > 0 ? dots[dots.length - 1] as HTMLElement : null
    if (!start || !last) { line.style.display = 'none'; return }
    const base = wrapper.getBoundingClientRect().top
    const top = start.getBoundingClientRect().top + start.offsetHeight / 2 - base
    const end = last.getBoundingClientRect().top + last.offsetHeight / 2 - base
    line.style.display = ''
    line.style.top = `${top}px`
    line.style.height = `${end - top}px`
  })

  return (
    <div ref={wrapperRef} className="relative">
      <div ref={lineRef} className="absolute w-px bg-border" style={{ left: 12, transform: 'translateX(-50%)', display: 'none' }} />
      {children}
    </div>
  )
}

interface AutomationCardProps {
  automation: Automation
  onToggle: (id: string, enabled: boolean) => void
  onEdit: (automation: Automation) => void
  onDelete: (id: string) => void
  onDuplicate: (automation: Automation) => void
  onRunManual: (id: string) => void
  onLoadRuns: (automationId: string) => Promise<AutomationRun[]>
}

export function AutomationCard({
  automation,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
  onRunManual,
  onLoadRuns,
}: AutomationCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [actionRunsByRunId, setActionRunsByRunId] = useState<Record<string, AutomationActionRun[]>>({})
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({})
  const [loadingRunIds, setLoadingRunIds] = useState<Record<string, boolean>>({})


  useEffect(() => {
    if (runsLoaded) {
      setRunsLoaded(false)
      setActionRunsByRunId({})
      setExpandedRunIds({})
      if (expanded) {
        onLoadRuns(automation.id).then(setRuns)
      }
    }
  }, [automation.run_count]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleExpand(): Promise<void> {
    if (!expanded && !runsLoaded) {
      const data = await onLoadRuns(automation.id)
      setRuns(data)
      setRunsLoaded(true)
    }
    setExpanded((current) => !current)
  }

  async function toggleRunDetails(runId: string): Promise<void> {
    setExpandedRunIds((prev) => ({ ...prev, [runId]: !prev[runId] }))

    if (actionRunsByRunId[runId] || loadingRunIds[runId]) return

    setLoadingRunIds((prev) => ({ ...prev, [runId]: true }))
    try {
      const actionRuns = await window.api.history.getAutomationActionRuns(runId)
      setActionRunsByRunId((prev) => ({ ...prev, [runId]: actionRuns }))
    } finally {
      setLoadingRunIds((prev) => ({ ...prev, [runId]: false }))
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface-3 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-label={expanded ? 'Collapse automation details' : 'Expand automation details'}
          onClick={() => void handleExpand()}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <button type="button" onClick={() => onEdit(automation)} className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline">
          {automation.name}
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {automation.trigger_config.type === 'manual' && (
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => onRunManual(automation.id)}>
              <Play className="size-3.5" />
            </Button>
          )}
          <Switch
            checked={automation.enabled}
            onCheckedChange={(checked) => onToggle(automation.id, checked)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(automation)}>
                <Pencil className="mr-2 size-3.5" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(automation)}>
                <Copy className="mr-2 size-3.5" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDelete(automation.id)} className="text-destructive">
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-background/40 px-4 py-4 space-y-4">
          {runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background/50 px-3 py-4 text-sm text-muted-foreground">
              No runs yet.
            </div>
          ) : runs.slice(0, 10).map((run) => {
            const runStatus = getStatusMeta(run.status, 'automation-run-marker')
            const isRunExpanded = expandedRunIds[run.id] === true
            const actionRuns = actionRunsByRunId[run.id] ?? []
            const loadingActions = loadingRunIds[run.id] === true
            const detailEntries = buildRunDetailEntries(run, actionRuns)

            return (
              <RunTimeline key={run.id}>
                {/* Run row */}
                <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-4">
                  <div className="flex justify-center">
                    <div
                      data-testid={runStatus.testId}
                      data-timeline-start
                      className={cn('relative z-10', runStatus.labelClassName)}
                    >
                      {runStatus.icon}
                    </div>
                  </div>
                  <div className="flex items-baseline gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <div className={cn('text-sm font-medium', runStatus.labelClassName)}>{runStatus.label}</div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>{formatRelativeTime(run.started_at) ?? run.started_at}</span>
                          {run.duration_ms !== null && (
                            <>
                              <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                              <span>{run.duration_ms} ms</span>
                            </>
                          )}
                          {isCatchupRun(run) && (
                            <>
                              <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                              <span title="Coalesced replay of one or more missed cron fires">catchup</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={isRunExpanded ? 'Hide run action details' : 'Show run action details'}
                      className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => void toggleRunDetails(run.id)}
                    >
                      {isRunExpanded ? 'Hide details' : 'Show details'}
                    </button>
                  </div>
                </div>

                {/* Detail rows */}
                {isRunExpanded && (
                  loadingActions ? (
                    <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-4 mt-3">
                      <div />
                      <div className="text-xs text-muted-foreground">Loading action details...</div>
                    </div>
                  ) : detailEntries.length === 0 ? (
                    <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-4 mt-3">
                      <div />
                      <div className="text-xs text-muted-foreground">No action details.</div>
                    </div>
                  ) : detailEntries.map((entry, entryIndex) => (
                    <div key={entry.key} className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-4" style={{ marginTop: entryIndex === 0 ? 8 : 16 }}>
                      <div className="flex justify-center">
                        <div data-testid={entry.testId} data-timeline-dot className="relative z-10 size-2 shrink-0 rounded-full bg-foreground" />
                      </div>
                      <div className="min-w-0">
                        {entry.title && (
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/25 px-3 py-2 text-[11px] leading-5 text-foreground">
                            <div>{entry.title}</div>
                            {entry.meta && <div className="text-muted-foreground">{entry.meta}</div>}
                          </pre>
                        )}
                        {!entry.title && entry.body && entry.testId === 'automation-step-marker-output' && (
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/25 px-3 py-2 text-[11px] leading-5 text-foreground">
                            {entry.body}
                          </pre>
                        )}
                        {!entry.title && entry.body && entry.testId === 'automation-step-marker-error' && (
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/25 px-3 py-2 text-[11px] leading-5 text-destructive">
                            {entry.body}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </RunTimeline>
            )
          })}
        </div>
      )}
    </div>
  )
}
