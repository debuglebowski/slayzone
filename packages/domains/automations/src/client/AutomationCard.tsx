import { useState, useEffect } from 'react'
import { Switch, Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@slayzone/ui'
import { MoreHorizontal, Play, Trash2, Copy, ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock } from 'lucide-react'
import type { Automation, AutomationRun } from '@slayzone/automations/shared'

function describeTrigger(automation: Automation): string {
  const t = automation.trigger_config
  switch (t.type) {
    case 'manual': return 'Manual trigger'
    case 'task_status_change': {
      const from = t.params.fromStatus as string | undefined
      const to = t.params.toStatus as string | undefined
      if (from && to) return `When task ${from} \u2192 ${to}`
      if (to) return `When task \u2192 ${to}`
      if (from) return `When task leaves ${from}`
      return 'When task status changes'
    }
    case 'task_created': return 'When task created'
    case 'task_archived': return 'When task archived'
    case 'task_tag_changed': return 'When tags changed'
    case 'cron': return `Cron: ${(t.params.expression as string) ?? '?'}`
    default: return t.type
  }
}

function describeActions(automation: Automation): string {
  return automation.actions.map(a => {
    if (a.type === 'run_command') return `run \`${a.params.command}\``
    if (a.type === 'change_task_status') return `set status \u2192 ${a.params.status}`
    return a.type
  }).join(', ')
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr + 'Z').getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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

export function AutomationCard({ automation, onToggle, onEdit, onDelete, onDuplicate, onRunManual, onLoadRuns }: AutomationCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)

  // Reset stale run history when run_count changes (new run completed)
  useEffect(() => {
    if (runsLoaded) {
      setRunsLoaded(false)
      if (expanded) {
        onLoadRuns(automation.id).then(setRuns)
      }
    }
  }, [automation.run_count]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleExpand = async () => {
    if (!expanded && !runsLoaded) {
      const data = await onLoadRuns(automation.id)
      setRuns(data)
      setRunsLoaded(true)
    }
    setExpanded(!expanded)
  }

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button onClick={handleExpand} className="text-muted-foreground hover:text-foreground shrink-0">
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => onEdit(automation)} className="font-medium text-sm truncate hover:underline text-left">
              {automation.name}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 ml-5.5 truncate">
            {describeTrigger(automation)} \u2192 {describeActions(automation)}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {automation.trigger_config.type === 'manual' && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => onRunManual(automation.id)}>
              <Play className="w-3 h-3" />
            </Button>
          )}
          <Switch
            checked={automation.enabled}
            onCheckedChange={(checked) => onToggle(automation.id, checked)}
            className="scale-75"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                <MoreHorizontal className="w-3.5 h-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(automation)}>Edit</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(automation)}>
                <Copy className="w-3.5 h-3.5 mr-2" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDelete(automation.id)} className="text-destructive">
                <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {automation.run_count > 0 && (
        <p className="text-[11px] text-muted-foreground ml-5.5">
          Ran {automation.run_count} time{automation.run_count !== 1 ? 's' : ''}
          {automation.last_run_at && <> &middot; Last: {timeAgo(automation.last_run_at)}</>}
        </p>
      )}

      {expanded && (
        <div className="ml-5.5 space-y-1 pt-1 border-t">
          {runs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No runs yet</p>
          ) : (
            runs.slice(0, 10).map((run: AutomationRun) => (
              <div key={run.id} className="flex items-center gap-2 text-[11px]">
                {run.status === 'success' && <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />}
                {run.status === 'error' && <XCircle className="w-3 h-3 text-red-500 shrink-0" />}
                {run.status === 'running' && <Clock className="w-3 h-3 text-yellow-500 shrink-0" />}
                {run.status === 'skipped' && <Clock className="w-3 h-3 text-muted-foreground shrink-0" />}
                <span className="text-muted-foreground">{timeAgo(run.started_at)}</span>
                {run.error && <span className="text-red-400 truncate">{run.error}</span>}
                {run.duration_ms != null && <span className="text-muted-foreground">{run.duration_ms}ms</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
