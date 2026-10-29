import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import { Plus, Cpu, Info, Loader2 } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, toast, useDepsChanged } from '@slayzone/ui'
import { ProcessDialog } from './ProcessDialog'
import type { ProcessEntry, ProcessStatus } from './ProcessesPanel.types'
import { extractUrlFromLine } from './ProcessesPanel.utils'
import { ProcessRow } from './ProcessRow'

export type { ProcessEntry } from './ProcessesPanel.types'

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40 px-1 pt-1 pb-0.5">
      {label}
    </p>
  )
}

export function ProcessesPanel({
  taskId,
  projectId,
  cwd,
  terminalSessionId,
  onOpenUrl
}: {
  taskId: string | null
  projectId: string | null
  cwd?: string | null
  terminalSessionId?: string
  onOpenUrl?: (url: string) => void
}) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const { mutateAsync: killProcess } = useMutation(trpc.processes.kill.mutationOptions())
  const { mutateAsync: stopProcess } = useMutation(trpc.processes.stop.mutationOptions())
  const { mutateAsync: restartProcess } = useMutation(trpc.processes.restart.mutationOptions())
  const [processes, setProcesses] = useState<ProcessEntry[]>([])
  // 'failed' only while there is no list to show: a failed reload of a loaded list
  // (tab re-show) keeps that list on screen.
  const [listLoad, setListLoad] = useState<'loading' | 'failed' | 'loaded'>('loading')
  // Bumped by Retry and by a dialog save/spawn: re-runs the list load.
  const [listLoadAttempt, setListLoadAttempt] = useState(0)
  // The reload after a dialog save/spawn, so the list shows that change: 'pending'
  // until a load lands, 'failed' if it failed. Shown only on a loaded list (that list
  // misses the change); every later successful load (a re-show's, a new task's) clears it.
  const [refresh, setRefresh] = useState<'idle' | 'pending' | 'failed'>('idle')
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProcess, setEditingProcess] = useState<ProcessEntry | null>(null)
  const [stats, setStats] = useState<Record<string, { cpu: number; rss: number }>>({})
  const logEndRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // The spinner is for a list we don't have yet: the first load and a task/project
  // change, adjusted while rendering. A tab re-show (<Activity>) re-runs the load
  // effect below too, but keeps the current list on screen while it reloads.
  if (useDepsChanged([taskId, projectId, trpcClient])) setListLoad('loading')

  useEffect(() => {
    // A response (or failure) for a previous task/project must not land on the newer one.
    let cancelled = false
    trpcClient.processes.listForTask
      .query({ taskId, projectId })
      .then((list) => {
        if (cancelled) return
        const entries = (list as ProcessEntry[]).map((p) => {
          if (p.serverUrl || p.status !== 'running') return p
          for (let i = p.logBuffer.length - 1; i >= 0; i--) {
            const url = extractUrlFromLine(p.logBuffer[i])
            if (url) return { ...p, serverUrl: url }
          }
          return p
        })
        setProcesses(entries)
        setListLoad('loaded')
        setRefresh('idle')
      })
      .catch(() => {
        if (cancelled) return
        setListLoad((prev) => (prev === 'loaded' ? prev : 'failed'))
        setRefresh((prev) => (prev === 'pending' ? 'failed' : prev))
      })
    return () => {
      cancelled = true
    }
  }, [taskId, projectId, trpcClient, listLoadAttempt])

  const retryListLoad = useCallback(() => {
    setListLoad('loading')
    setListLoadAttempt((n) => n + 1)
  }, [])

  useSubscription(
    trpc.processes.onLog.subscriptionOptions(undefined, {
      onData: ({ id: processId, line }) => {
        const url = extractUrlFromLine(line)
        setProcesses((prev) =>
          prev.map((p) =>
            p.id === processId
              ? {
                  ...p,
                  logBuffer: [...p.logBuffer.slice(-499), line],
                  serverUrl: url ?? p.serverUrl
                }
              : p
          )
        )
      }
    })
  )

  useSubscription(
    trpc.processes.onStatus.subscriptionOptions(undefined, {
      onData: ({ id: processId, status }) => {
        const procStatus = status as ProcessStatus
        setProcesses((prev) =>
          prev.map((p) =>
            p.id === processId
              ? {
                  ...p,
                  status: procStatus,
                  serverUrl: procStatus === 'running' ? p.serverUrl : null
                }
              : p
          )
        )
      }
    })
  )

  useSubscription(
    trpc.processes.onStats.subscriptionOptions(undefined, {
      onData: (s) => setStats(s)
    })
  )

  useSubscription(
    trpc.processes.onTitle.subscriptionOptions(undefined, {
      onData: ({ id: processId, title }) => {
        setProcesses((prev) =>
          prev.map((p) => (p.id === processId ? { ...p, processTitle: title } : p))
        )
      }
    })
  )

  useEffect(() => {
    for (const id of expandedLogs) {
      logEndRefs.current[id]?.scrollIntoView({ block: 'nearest' })
    }
  }, [processes, expandedLogs])

  // Re-runs the list load (its stale guard, failure handling and URL derivation),
  // keeping the current list on screen meanwhile. A load already in flight was asked
  // before the change: re-running drops its answer.
  const refreshList = useCallback(() => {
    setRefresh('pending')
    setListLoadAttempt((n) => n + 1)
  }, [])

  const toggleLog = useCallback((id: string) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // A failed action (computer offline, process already gone) leaves the list as it
  // was and says so; the status subscription keeps reporting the real state.
  const reportActionError = useCallback((verb: string, proc: ProcessEntry, err: unknown) => {
    toast.error(
      `Couldn't ${verb} ${proc.label}: ${err instanceof Error ? err.message : String(err)}`
    )
  }, [])

  const handleKill = useCallback(
    (proc: ProcessEntry) =>
      killProcess({ processId: proc.id }).then(
        () => {
          setProcesses((prev) => prev.filter((p) => p.id !== proc.id))
          setExpandedLogs((prev) => {
            const next = new Set(prev)
            next.delete(proc.id)
            return next
          })
        },
        (err: unknown) => reportActionError('kill', proc, err)
      ),
    [killProcess, reportActionError]
  )

  const handleStop = useCallback(
    (proc: ProcessEntry) =>
      stopProcess({ processId: proc.id }).then(
        () => {},
        (err: unknown) => reportActionError('stop', proc, err)
      ),
    [stopProcess, reportActionError]
  )

  const handleRestart = useCallback(
    (proc: ProcessEntry) =>
      restartProcess({ processId: proc.id }).then(
        () => {},
        (err: unknown) => reportActionError('restart', proc, err)
      ),
    [restartProcess, reportActionError]
  )

  const handleInject = useCallback(
    (proc: ProcessEntry) => {
      if (proc.logBuffer.length === 0) return
      const output = `\r\n--- ${proc.label} output ---\r\n${proc.logBuffer.join('\r\n')}\r\n---\r\n`
      void trpcClient.pty.write.mutate({
        sessionId: terminalSessionId ?? `${taskId}:${taskId}`,
        data: output
      })
    },
    [taskId, terminalSessionId, trpcClient]
  )

  const openNewDialog = useCallback(() => {
    setEditingProcess(null)
    setDialogOpen(true)
  }, [])

  const openEditDialog = useCallback((proc: ProcessEntry) => {
    setEditingProcess(proc)
    setDialogOpen(true)
  }, [])

  const handleDialogSpawned = useCallback(
    (id: string) => {
      refreshList()
      setExpandedLogs((prev) => new Set(prev).add(id))
    },
    [refreshList]
  )

  const projectProcesses = useMemo(() => processes.filter((p) => p.taskId === null), [processes])
  const taskProcesses = useMemo(
    () => (taskId ? processes.filter((p) => p.taskId === taskId) : []),
    [processes, taskId]
  )

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
            Background processes (dev servers, watchers, etc.) that run alongside your task.
            Task-scoped processes stop with the task; project processes are shared across all tasks
            in the project.
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

      {/* A failed reload after a dialog save/spawn: the list below misses that change. */}
      {refresh === 'failed' && listLoad === 'loaded' && (
        <div
          data-testid="processes-refresh-error"
          className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span className="text-destructive">Couldn't refresh processes.</span>
          <button type="button" className="underline hover:text-foreground" onClick={refreshList}>
            Retry
          </button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {listLoad === 'loading' ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : listLoad === 'failed' ? (
          <div
            data-testid="processes-load-error"
            className="h-full flex items-center justify-center gap-2 text-xs text-muted-foreground"
          >
            <span className="text-destructive">Couldn't load processes.</span>
            <button
              type="button"
              className="underline hover:text-foreground"
              onClick={retryListLoad}
            >
              Retry
            </button>
          </div>
        ) : isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center gap-5 p-8">
            <div className="flex flex-col items-center gap-3">
              <div className="size-12 rounded-xl bg-muted/50 flex items-center justify-center">
                <Cpu className="size-6 text-muted-foreground" />
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <p className="text-sm font-semibold">No processes</p>
                <p
                  className="text-xs text-foreground/60 text-center leading-relaxed max-w-72"
                  style={{ textWrap: 'balance' }}
                >
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
                {projectProcesses.map((proc) => (
                  <ProcessRow
                    key={proc.id}
                    proc={proc}
                    expanded={expandedLogs.has(proc.id)}
                    stats={stats[proc.id]}
                    onToggleLog={() => toggleLog(proc.id)}
                    onRestart={() => void handleRestart(proc)}
                    onStop={() => void handleStop(proc)}
                    onKill={() => void handleKill(proc)}
                    onEdit={() => openEditDialog(proc)}
                    onInject={() => handleInject(proc)}
                    onOpenUrl={onOpenUrl}
                    logEndRef={(el) => {
                      logEndRefs.current[proc.id] = el
                    }}
                  />
                ))}
              </>
            )}
            {taskProcesses.length > 0 && (
              <>
                <SectionHeader label="This task" />
                {taskProcesses.map((proc) => (
                  <ProcessRow
                    key={proc.id}
                    proc={proc}
                    expanded={expandedLogs.has(proc.id)}
                    stats={stats[proc.id]}
                    onToggleLog={() => toggleLog(proc.id)}
                    onRestart={() => void handleRestart(proc)}
                    onStop={() => void handleStop(proc)}
                    onKill={() => void handleKill(proc)}
                    onEdit={() => openEditDialog(proc)}
                    onInject={() => handleInject(proc)}
                    onOpenUrl={onOpenUrl}
                    logEndRef={(el) => {
                      logEndRefs.current[proc.id] = el
                    }}
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
        onSaved={refreshList}
        onSpawned={handleDialogSpawned}
      />
    </div>
  )
}
