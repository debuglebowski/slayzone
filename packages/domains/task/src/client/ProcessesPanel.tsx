import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Play, Square, RotateCcw, Plus, Trash2, Cpu, Pencil, FileText, MoreHorizontal, CornerDownLeft, Info, Loader2, Globe } from 'lucide-react'
import { cn, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { ProcessDialog } from './ProcessDialog'
type ProcessStatus = 'running' | 'stopped' | 'completed' | 'error'

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export interface ProcessEntry {
  id: string
  taskId: string | null
  projectId: string | null
  label: string
  command: string
  cwd: string
  autoRestart: boolean
  status: ProcessStatus
  pid: number | null
  exitCode: number | null
  logBuffer: string[]
  startedAt: string
  restartCount: number
  spawnedAt: string | null
  processTitle: string | null
  serverUrl?: string | null
}

const STATUS_CONFIG: Record<ProcessStatus, { label: string; dot: string; badge: string }> = {
  running:   { label: 'Running',   dot: 'bg-green-500',              badge: 'text-green-500 bg-green-500/10 border-green-500/20' },
  stopped:   { label: 'Idle',      dot: 'bg-muted-foreground/30',    badge: 'text-muted-foreground bg-muted/60 border-border' },
  completed: { label: 'Completed', dot: 'bg-blue-400',               badge: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  error:     { label: 'Failed',    dot: 'bg-red-500',                badge: 'text-red-500 bg-red-500/10 border-red-500/20' },
}

const ANSI_RX = /\x1b\[[0-9;]*m/g
const URL_RX = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d+\.\d+\.\d+\.\d+)(?::\d+)?(?:\/[^\s"')]*)?)/i

function extractUrlFromLine(line: string): string | null {
  const m = line.replace(ANSI_RX, '').match(URL_RX)
  return m ? m[1] : null
}

function StatusBadge({ status }: { status: ProcessStatus }) {
  const { label, dot, badge } = STATUS_CONFIG[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0', badge)}>
      <span className="relative flex size-1.5">
        {status === 'running' && (
          <span className={cn('animate-ping absolute inline-flex h-full w-full rounded-full opacity-60', dot)} />
        )}
        <span className={cn('relative inline-flex rounded-full size-1.5', dot)} />
      </span>
      {label}
    </span>
  )
}

function ProcessRow({
  proc,
  expanded,
  stats,
  onToggleLog,
  onRestart,
  onStop,
  onKill,
  onEdit,
  onInject,
  logEndRef,
}: {
  proc: ProcessEntry
  expanded: boolean
  stats?: { cpu: number; rss: number }
  onToggleLog: () => void
  onRestart: () => void
  onStop: () => void
  onKill: () => void
  onEdit: () => void
  onInject: () => void
  logEndRef: (el: HTMLDivElement | null) => void
}) {
  const serverUrl = proc.status === 'running' ? proc.serverUrl ?? null : null
  return (
    <div className="rounded-lg border border-border bg-surface-3 overflow-hidden group/row">
      <div className="flex items-center gap-3 px-3.5 py-3">
        {/* Label + command */}
        <div className="flex flex-col min-w-0 flex-1 gap-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium leading-tight truncate">{proc.label}</span>
            {proc.autoRestart && (
              <span className="text-[10px] text-muted-foreground/40 shrink-0" title="Auto-restart enabled">↺</span>
            )}
          </div>
          <span className="text-[11px] font-mono text-muted-foreground/55 truncate">{proc.command}</span>
        </div>

        {/* Stop + Restart — visible when running */}
        {proc.status === 'running' && (
          <>
            <Tip label="Stop">
              <button
                onClick={onStop}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <Square className="size-3.5" />
              </button>
            </Tip>
            <Tip label="Restart">
              <button
                onClick={onRestart}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </Tip>
          </>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          {proc.status !== 'running' && (
            <Tip label="Start">
              <button
                onClick={onRestart}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <Play className="size-3.5" />
              </button>
            </Tip>
          )}
          <Tip label="Logs">
            <button
              onClick={onToggleLog}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                expanded ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <FileText className="size-3.5" />
            </button>
          </Tip>
          <Tip label="Send output to terminal">
            <button
              onClick={onInject}
              disabled={proc.logBuffer.length === 0}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <CornerDownLeft className="size-3.5" />
            </button>
          </Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button title="More" className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-3.5 mr-2" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onKill} className="text-red-500 focus:text-red-500">
                <Trash2 className="size-3.5 mr-2 text-red-500" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Pills row */}
      <div className="flex items-center gap-1.5 flex-wrap px-3.5 pb-2.5 -mt-1">
        <StatusBadge status={proc.status} />
        {serverUrl && (
          <a
            href={serverUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => { e.preventDefault(); void window.api.shell.openExternal(serverUrl) }}
            className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 text-sky-400 bg-sky-400/10 border-sky-400/20 hover:bg-sky-400/20 transition-colors"
            title={`Open ${serverUrl}`}
          >
            <Globe className="size-2.5" />
            {serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
          </a>
        )}
        {proc.processTitle && (
          <span className="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 text-muted-foreground bg-muted/60 border-border">
            {proc.processTitle}
          </span>
        )}
        {proc.status === 'error' && proc.exitCode !== null && (
          <span className="text-[10px] text-red-400/70 font-mono">exit {proc.exitCode}</span>
        )}
        {proc.status === 'running' && (stats || proc.restartCount > 0) && (
          <span className="text-[10px] text-muted-foreground/40 font-mono flex items-center gap-1.5 ml-auto">
            {stats && (
              <>
                <span>{stats.cpu.toFixed(1)}%</span>
                <span className="text-muted-foreground/15">·</span>
                <span>{stats.rss >= 1024 ? `${(stats.rss / 1024).toFixed(0)} MB` : `${stats.rss} KB`}</span>
              </>
            )}
            {proc.restartCount > 0 && (
              <><span className="text-muted-foreground/15">·</span><span>↺{proc.restartCount}</span></>
            )}
          </span>
        )}
      </div>

      {/* Log panel */}
      {expanded && (
        <div className="bg-neutral-950 dark:bg-black border-t border-neutral-900">
          <div className="flex items-center px-4 py-1.5 border-b border-neutral-900/80">
            <span className="text-[10px] text-neutral-600 font-mono">
              {proc.logBuffer.length === 0 ? 'no output' : `${proc.logBuffer.length} lines`}
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto">
            <pre className="text-[10px] font-mono text-neutral-300 px-4 py-3 whitespace-pre-wrap break-all leading-relaxed">
              {proc.logBuffer.length === 0
                ? <span className="text-neutral-600 italic">Waiting for output…</span>
                : proc.logBuffer.join('\n')}
            </pre>
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 px-1 pt-1 pb-0.5">
      {label}
    </p>
  )
}

export function ProcessesPanel({ taskId, projectId, cwd, terminalSessionId }: { taskId: string | null; projectId: string | null; cwd?: string | null; terminalSessionId?: string }) {
  const [processes, setProcesses] = useState<ProcessEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProcess, setEditingProcess] = useState<ProcessEntry | null>(null)
  const [stats, setStats] = useState<Record<string, { cpu: number; rss: number }>>({})
  const logEndRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    setLoading(true)
    window.api.processes.listForTask(taskId, projectId).then((list) => {
      const entries = (list as ProcessEntry[]).map(p => {
        if (p.serverUrl || p.status !== 'running') return p
        for (let i = p.logBuffer.length - 1; i >= 0; i--) {
          const url = extractUrlFromLine(p.logBuffer[i])
          if (url) return { ...p, serverUrl: url }
        }
        return p
      })
      setProcesses(entries)
      setLoading(false)
    })
  }, [taskId, projectId])

  useEffect(() => {
    const unsub = window.api.processes.onLog((processId, line) => {
      const url = extractUrlFromLine(line)
      setProcesses(prev =>
        prev.map(p => p.id === processId
          ? { ...p, logBuffer: [...p.logBuffer.slice(-499), line], serverUrl: url ?? p.serverUrl }
          : p)
      )
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.processes.onStatus((processId, status) => {
      setProcesses(prev => prev.map(p => p.id === processId
        ? { ...p, status, serverUrl: status === 'running' ? p.serverUrl : null }
        : p))
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.processes.onStats((s) => setStats(s))
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.processes.onTitle((processId, title) => {
      setProcesses(prev => prev.map(p => p.id === processId ? { ...p, processTitle: title } : p))
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.app.onCloseTask((closedTaskId) => {
      if (taskId && closedTaskId === taskId) window.api.processes.killTask(taskId)
    })
    return unsub
  }, [taskId])

  useEffect(() => {
    for (const id of expandedLogs) {
      logEndRefs.current[id]?.scrollIntoView({ block: 'nearest' })
    }
  }, [processes, expandedLogs])

  const refreshList = useCallback(async () => {
    const list = await window.api.processes.listForTask(taskId, projectId)
    setProcesses(list as ProcessEntry[])
  }, [taskId, projectId])

  const toggleLog = useCallback((id: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleKill = useCallback(async (id: string) => {
    await window.api.processes.kill(id)
    setProcesses(prev => prev.filter(p => p.id !== id))
    setExpandedLogs(prev => { const next = new Set(prev); next.delete(id); return next })
  }, [])

  const handleStop = useCallback(async (id: string) => {
    await window.api.processes.stop(id)
  }, [])

  const handleRestart = useCallback(async (id: string) => {
    await window.api.processes.restart(id)
  }, [])

  const handleInject = useCallback((proc: ProcessEntry) => {
    if (proc.logBuffer.length === 0) return
    const output = `\r\n--- ${proc.label} output ---\r\n${proc.logBuffer.join('\r\n')}\r\n---\r\n`
    void window.api.pty.write(terminalSessionId ?? `${taskId}:${taskId}`, output)
  }, [taskId, terminalSessionId])

  const openNewDialog = useCallback(() => {
    setEditingProcess(null)
    setDialogOpen(true)
  }, [])

  const openEditDialog = useCallback((proc: ProcessEntry) => {
    setEditingProcess(proc)
    setDialogOpen(true)
  }, [])

  const handleDialogSaved = useCallback(() => {
    void refreshList()
  }, [refreshList])

  const handleDialogSpawned = useCallback((id: string) => {
    void refreshList()
    setExpandedLogs(prev => new Set(prev).add(id))
  }, [refreshList])

  const projectProcesses = useMemo(() => processes.filter(p => p.taskId === null), [processes])
  const taskProcesses = useMemo(() => taskId ? processes.filter(p => p.taskId === taskId) : [], [processes, taskId])

  const isEmpty = processes.length === 0

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-1">
      {/* Header */}
      <div className="shrink-0 h-10 px-4 border-b border-border bg-surface-1 flex items-center gap-2">
        <span className="text-sm font-medium">Processes</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="size-3 text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-default shrink-0" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64">
            Background processes (dev servers, watchers, etc.) that run alongside your task. Task-scoped processes stop with the task; project processes are shared across all tasks in the project.
          </TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <button
          onClick={openNewDialog}
          className="flex items-center gap-1 h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Plus className="size-3.5" />
          New process
        </button>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center gap-5 p-8">
            <div className="flex flex-col items-center gap-3">
              <div className="size-12 rounded-xl bg-muted/50 flex items-center justify-center">
                <Cpu className="size-6 text-muted-foreground" />
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <p className="text-sm font-semibold">No processes</p>
                <p className="text-xs text-foreground/60 text-center leading-relaxed max-w-72" style={{ textWrap: 'balance' }}>
                  Run dev servers, watchers, or any background command alongside your task
                </p>
              </div>
            </div>
            <button
              onClick={openNewDialog}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="size-3.5" />
              New process
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {projectProcesses.length > 0 && (
              <>
                <SectionHeader label="Project" />
                {projectProcesses.map(proc => (
                  <ProcessRow
                    key={proc.id}
                    proc={proc}
                    expanded={expandedLogs.has(proc.id)}
                    stats={stats[proc.id]}
                    onToggleLog={() => toggleLog(proc.id)}
                    onRestart={() => void handleRestart(proc.id)}
                    onStop={() => void handleStop(proc.id)}
                    onKill={() => void handleKill(proc.id)}
                    onEdit={() => openEditDialog(proc)}
                    onInject={() => handleInject(proc)}
                    logEndRef={el => { logEndRefs.current[proc.id] = el }}
                  />
                ))}
              </>
            )}
            {taskProcesses.length > 0 && (
              <>
                <SectionHeader label="This task" />
                {taskProcesses.map(proc => (
                  <ProcessRow
                    key={proc.id}
                    proc={proc}
                    expanded={expandedLogs.has(proc.id)}
                    stats={stats[proc.id]}
                    onToggleLog={() => toggleLog(proc.id)}
                    onRestart={() => void handleRestart(proc.id)}
                    onStop={() => void handleStop(proc.id)}
                    onKill={() => void handleKill(proc.id)}
                    onEdit={() => openEditDialog(proc)}
                    onInject={() => handleInject(proc)}
                    logEndRef={el => { logEndRefs.current[proc.id] = el }}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <ProcessDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        process={editingProcess}
        taskId={taskId}
        projectId={projectId}
        cwd={cwd ?? null}
        onSaved={handleDialogSaved}
        onSpawned={handleDialogSpawned}
      />
    </div>
  )
}
