import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Play, Square, RotateCcw, Plus, Trash2, ArrowLeft, Cpu, Pencil, FileText, MoreHorizontal, CornerDownLeft, Info } from 'lucide-react'
import { cn, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
type ProcessStatus = 'running' | 'stopped' | 'completed' | 'error'

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

interface ProcessEntry {
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
}

function Duration({ since }: { since: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.floor((Date.now() - new Date(since).getTime()) / 1000)
  if (s < 60) return <>{s}s</>
  if (s < 3600) return <>{Math.floor(s / 60)}m {s % 60}s</>
  return <>{Math.floor(s / 3600)}h {Math.floor((s % 3600) / 60)}m</>
}

interface AddFormState {
  label: string
  command: string
  autoRestart: boolean
  scope: 'task' | 'project'
}

interface SuggestionItem {
  name: string
  command: string
}

interface SuggestionGroup {
  category: string
  items: SuggestionItem[]
}

const STATIC_SUGGESTIONS: SuggestionGroup[] = [
  {
    category: 'Dev servers',
    items: [
      { name: 'Vite', command: 'vite' },
      { name: 'Next.js', command: 'next dev' },
      { name: 'Rails', command: 'rails server' },
      { name: 'Django', command: 'python manage.py runserver' },
      { name: 'Laravel', command: 'php artisan serve' },
      { name: 'Express', command: 'node server.js' },
    ]
  },
  {
    category: 'Watchers',
    items: [
      { name: 'TypeScript', command: 'tsc --watch' },
      { name: 'Vitest', command: 'vitest --watch' },
      { name: 'Jest', command: 'jest --watch' },
    ]
  },
  {
    category: 'Services',
    items: [
      { name: 'Redis', command: 'redis-server' },
      { name: 'Docker Compose', command: 'docker compose up' },
      { name: 'PostgreSQL', command: 'pg_ctl start' },
    ]
  },
  {
    category: 'Tunnels & tools',
    items: [
      { name: 'ngrok', command: 'ngrok http 3000' },
      { name: 'Stripe CLI', command: 'stripe listen --forward-to localhost:3000' },
      { name: 'Cloudflare Tunnel', command: 'cloudflared tunnel run' },
    ]
  },
]

const STATUS_CONFIG: Record<ProcessStatus, { label: string; dot: string; badge: string }> = {
  running:   { label: 'Running',   dot: 'bg-green-500',              badge: 'text-green-500 bg-green-500/10 border-green-500/20' },
  stopped:   { label: 'Idle',      dot: 'bg-muted-foreground/30',    badge: 'text-muted-foreground bg-muted/60 border-border' },
  completed: { label: 'Completed', dot: 'bg-blue-400',               badge: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  error:     { label: 'Failed',    dot: 'bg-red-500',                badge: 'text-red-500 bg-red-500/10 border-red-500/20' },
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

const EMPTY_FORM: AddFormState = { label: '', command: '', autoRestart: false, scope: 'project' }

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
  return (
    <div className="rounded-lg border border-border bg-surface-2 overflow-hidden group/row">
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

        {/* Status + metadata */}
        <div className="flex items-center gap-2 shrink-0">
          {proc.status === 'error' && proc.exitCode !== null && (
            <span className="text-[10px] text-red-400/70 font-mono">exit {proc.exitCode}</span>
          )}
          {proc.status === 'running' && (
            <span className="text-[10px] text-muted-foreground/30 font-mono flex items-center gap-1.5">
              {proc.pid && <span>pid {proc.pid}</span>}
              {proc.spawnedAt && <><span className="text-muted-foreground/15">·</span><Duration since={proc.spawnedAt} /></>}
              {stats && (
                <>
                  <span className="text-muted-foreground/15">·</span>
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
          {proc.processTitle && (
            <span className="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 text-muted-foreground bg-muted/60 border-border">
              {proc.processTitle}
            </span>
          )}
          <StatusBadge status={proc.status} />
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
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'list' | 'new'>('list')
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pkgScripts, setPkgScripts] = useState<SuggestionItem[]>([])
  const [stats, setStats] = useState<Record<string, { cpu: number; rss: number }>>({})
  const logEndRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const labelRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.api.processes.listForTask(taskId, projectId).then((list) => setProcesses(list as ProcessEntry[]))
  }, [taskId, projectId])

  useEffect(() => {
    if (!cwd) return
    window.api.fs.readFile(cwd, 'package.json').then(async (result) => {
      if (!result.content) return
      try {
        const pkg = JSON.parse(result.content) as { scripts?: Record<string, string>; packageManager?: string }

        // Detect package manager: packageManager field → lock file → npm
        let pm = 'npm'
        if (pkg.packageManager) {
          if (pkg.packageManager.startsWith('pnpm')) pm = 'pnpm'
          else if (pkg.packageManager.startsWith('yarn')) pm = 'yarn'
          else if (pkg.packageManager.startsWith('bun')) pm = 'bun'
        } else {
          const hasPnpm = await window.api.fs.readFile(cwd, 'pnpm-lock.yaml').then(r => !!r.content).catch(() => false)
          if (hasPnpm) pm = 'pnpm'
          else {
            const hasYarn = await window.api.fs.readFile(cwd, 'yarn.lock').then(r => !!r.content).catch(() => false)
            if (hasYarn) pm = 'yarn'
            else {
              const hasBun = await window.api.fs.readFile(cwd, 'bun.lockb').then(r => !!r.content).catch(() => false)
              if (hasBun) pm = 'bun'
            }
          }
        }

        const prefix = pm === 'yarn' ? 'yarn' : `${pm} run`
        setPkgScripts(Object.entries(pkg.scripts ?? {}).map(([name]) => ({ name, command: `${prefix} ${name}` })))
      } catch { /* no-op */ }
    }).catch(() => { /* no package.json */ })
  }, [cwd])

  useEffect(() => {
    const unsub = window.api.processes.onLog((processId, line) => {
      setProcesses(prev =>
        prev.map(p => p.id === processId ? { ...p, logBuffer: [...p.logBuffer.slice(-499), line] } : p)
      )
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.processes.onStatus((processId, status) => {
      setProcesses(prev => prev.map(p => p.id === processId ? { ...p, status } : p))
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

  useEffect(() => {
    if (view === 'new') setTimeout(() => labelRef.current?.focus(), 50)
  }, [view])

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

  const handleCreate = useCallback(async () => {
    if (!form.label.trim() || !form.command.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      const isProject = form.scope === 'project'
      const tid = isProject ? null : taskId
      const pid = isProject ? projectId : null
      if (editingId) {
        await window.api.processes.update(editingId, { label: form.label.trim(), command: form.command.trim(), autoRestart: form.autoRestart, taskId: tid, projectId: pid })
      } else {
        await window.api.processes.create(pid, tid, form.label.trim(), form.command.trim(), cwd ?? '', form.autoRestart)
      }
      await refreshList()
      setEditingId(null)
      setView('list')
      setForm(EMPTY_FORM)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [taskId, projectId, cwd, form, editingId, refreshList])

  const handleSpawn = useCallback(async () => {
    if (!form.label.trim() || !form.command.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      const isProject = form.scope === 'project'
      const tid = isProject ? null : taskId
      const pid = isProject ? projectId : null
      if (editingId) {
        await window.api.processes.update(editingId, { label: form.label.trim(), command: form.command.trim(), autoRestart: form.autoRestart, taskId: tid, projectId: pid })
        await window.api.processes.restart(editingId)
        await refreshList()
        setExpandedLogs(prev => new Set(prev).add(editingId))
      } else {
        const id = await window.api.processes.spawn(pid, tid, form.label.trim(), form.command.trim(), cwd ?? '', form.autoRestart)
        await refreshList()
        setExpandedLogs(prev => new Set(prev).add(id))
      }
      setEditingId(null)
      setView('list')
      setForm(EMPTY_FORM)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [taskId, projectId, cwd, form, editingId, refreshList])

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

  const applySuggestion = useCallback((item: SuggestionItem) => {
    setForm(f => ({ ...f, label: f.label || item.name, command: item.command }))
    labelRef.current?.focus()
  }, [])

  const goToNew = useCallback(() => { setEditingId(null); setForm(EMPTY_FORM); setView('new') }, [])
  const goToEdit = useCallback((proc: ProcessEntry) => {
    setEditingId(proc.id)
    setForm({ label: proc.label, command: proc.command, autoRestart: proc.autoRestart, scope: proc.taskId === null ? 'project' : 'task' })
    setView('new')
  }, [])
  const goToList = useCallback(() => { setView('list'); setEditingId(null); setForm(EMPTY_FORM) }, [])

  const projectProcesses = useMemo(() => processes.filter(p => p.taskId === null), [processes])
  const taskProcesses = useMemo(() => taskId ? processes.filter(p => p.taskId === taskId) : [], [processes, taskId])

  const allSuggestions: SuggestionGroup[] = [
    ...(pkgScripts.length > 0 ? [{ category: 'package.json', items: pkgScripts }] : []),
    ...STATIC_SUGGESTIONS,
  ]

  const isEmpty = processes.length === 0

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-1">
      {/* Header */}
      <div className="shrink-0 h-10 px-2 border-b border-border bg-surface-1 flex items-center gap-1">
        {view === 'list' ? (
          <>
            <span className="text-xs font-medium text-muted-foreground px-1">Processes</span>
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
              onClick={goToNew}
              className="flex items-center gap-1 h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Plus className="size-3.5" />
              New process
            </button>
          </>
        ) : (
          <button
            onClick={goToList}
            className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            {editingId ? 'Edit process' : 'New process'}
          </button>
        )}
      </div>

      {/* List view */}
      {view === 'list' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {isEmpty ? (
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
                onClick={goToNew}
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
                      onEdit={() => goToEdit(proc)}
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
                      onEdit={() => goToEdit(proc)}
                      onInject={() => handleInject(proc)}
                      logEndRef={el => { logEndRefs.current[proc.id] = el }}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* New process view */}
      {view === 'new' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-4 pt-5 pb-5 flex flex-col gap-4">

            {/* Scope toggle */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Scope
              </label>
              <div className="flex gap-1 p-0.5 rounded-lg bg-muted/50 border border-border w-fit">
                {(['project', 'task'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setForm(f => ({ ...f, scope: s }))}
                    className={cn(
                      'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                      form.scope === s
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {s === 'task' ? 'This task' : 'Project'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                {form.scope === 'task'
                  ? 'Stopped when this task is closed or deleted.'
                  : 'Shared across all tasks in this project.'}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Label
              </label>
              <input
                ref={labelRef}
                placeholder="e.g. Frontend"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                className="w-full rounded-md border border-input bg-surface-2 px-3 py-2 text-sm outline-none focus:border-ring transition-colors"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Command
              </label>
              <input
                placeholder="e.g. npm run dev"
                value={form.command}
                onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') void handleSpawn() }}
                className="w-full rounded-md border border-input bg-surface-2 px-3 py-2 text-sm font-mono outline-none focus:border-ring transition-colors"
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <label className="flex items-center gap-2.5 text-xs text-muted-foreground cursor-pointer select-none w-fit">
                  <input
                    type="checkbox"
                    checked={form.autoRestart}
                    onChange={e => setForm(f => ({ ...f, autoRestart: e.target.checked }))}
                    className="size-3.5 rounded"
                  />
                  Auto-restart on crash
                </label>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-64">
                Automatically restarts the process if it exits with a non-zero code. Won't restart if you stop it manually.
              </TooltipContent>
            </Tooltip>
            {saveError && (
              <p className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{saveError}</p>
            )}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => void handleCreate()}
                disabled={saving || !form.label.trim() || !form.command.trim()}
                className="flex-1 py-2 rounded-md border border-border bg-surface-2 text-sm font-medium text-foreground disabled:opacity-40 hover:bg-muted/50 transition-colors"
              >
                {saving ? '…' : editingId ? 'Update' : 'Save'}
              </button>
              <button
                onClick={() => void handleSpawn()}
                disabled={saving || !form.label.trim() || !form.command.trim()}
                className="flex-1 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                {saving ? '…' : editingId ? 'Update & run' : 'Run'}
              </button>
            </div>
          </div>

          {/* Suggestions */}
          {!editingId && <div className="border-t border-border px-4 pt-4 pb-6 flex flex-col gap-5">
            {allSuggestions.map(group => (
              <div key={group.category} className="flex flex-col gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
                  {group.category}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {group.items.map(item => (
                    <button
                      key={item.command}
                      onClick={() => applySuggestion(item)}
                      title={item.command}
                      className="px-2.5 py-1 rounded border border-border bg-surface-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>}
        </div>
      )}

    </div>
  )
}
