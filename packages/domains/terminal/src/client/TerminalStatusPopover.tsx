import { useState, useEffect, useCallback, useRef } from 'react'
import { Monitor, X } from 'lucide-react'
import {
  IconButton,
  getTerminalStateStyle,
  useStablePoll,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@slayzone/ui'
import { useDialogStore } from '@slayzone/settings'
import type { PtyInfo } from '@slayzone/terminal/shared'

interface TaskRef {
  id: string
  title: string
}

interface TerminalStatusButtonProps {
  side?: 'top' | 'right' | 'bottom' | 'left'
}

interface TerminalStatusDialogProps {
  tasks: TaskRef[]
  onTaskClick?: (taskId: string) => void
}

/** Trigger button — shows running PTY count, opens shared dialog. */
export function TerminalStatusButton({ side = 'right' }: TerminalStatusButtonProps) {
  const [count, setCount] = useState(0)
  const lastHashRef = useRef<string>('')

  const refreshPtys = useCallback(async () => {
    const list = await window.api.pty.list()
    const hash = JSON.stringify(list.map((p) => ({ s: p.sessionId, st: p.state })))
    if (hash !== lastHashRef.current) {
      lastHashRef.current = hash
      setCount(list.length)
    }
    return hash
  }, [])

  useStablePoll(refreshPtys, { enabled: true, baseDelayMs: 5000 })

  useEffect(() => {
    const unsub = window.api.pty.onStateChange(() => refreshPtys())
    return unsub
  }, [refreshPtys])

  useEffect(() => {
    refreshPtys()
  }, [refreshPtys])

  if (count === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          aria-label="Active terminals"
          variant="ghost"
          size="icon-lg"
          className="rounded-lg text-muted-foreground relative"
          onClick={() => useDialogStore.getState().openTerminals()}
        >
          <Monitor className="size-5" />
          <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {count}
          </span>
        </IconButton>
      </TooltipTrigger>
      <TooltipContent side={side}>Active Terminals</TooltipContent>
    </Tooltip>
  )
}

/** Shared dialog — render once at app root. Controlled via useDialogStore.terminalsOpen. */
export function TerminalStatusDialog({ tasks, onTaskClick }: TerminalStatusDialogProps) {
  const open = useDialogStore((s) => s.terminalsOpen)
  const closeTerminals = useDialogStore((s) => s.closeTerminals)

  const [ptys, setPtys] = useState<PtyInfo[]>([])
  const [stats, setStats] = useState<Record<string, { cpu: number; rss: number }>>({})
  const [, tick] = useState(0)
  const lastHashRef = useRef<string>('')

  const refreshPtys = useCallback(async () => {
    const list = await window.api.pty.list()
    const hash = JSON.stringify(list.map((p) => ({ s: p.sessionId, st: p.state, c: p.createdAt })))
    if (hash !== lastHashRef.current) {
      lastHashRef.current = hash
      setPtys(list)
    }
    return hash
  }, [])

  useStablePoll(refreshPtys, { enabled: open, baseDelayMs: 5000 })

  useEffect(() => {
    if (!open) return
    const tickInterval = setInterval(() => tick((t) => t + 1), 1000)
    return () => clearInterval(tickInterval)
  }, [open])

  useEffect(() => {
    const unsub = window.api.pty.onStateChange(() => refreshPtys())
    return unsub
  }, [refreshPtys])

  useEffect(() => {
    const unsub = window.api.pty.onStats((s) => setStats(s))
    return unsub
  }, [])

  useEffect(() => {
    if (open) refreshPtys()
  }, [open, refreshPtys])

  const handleTerminate = async (sessionId: string) => {
    await window.api.pty.kill(sessionId)
    refreshPtys()
  }

  const getTaskIdFromSession = (sessionId: string): string => sessionId.split(':')[0]

  const getTaskName = (sessionId: string): string => {
    const taskId = getTaskIdFromSession(sessionId)
    const task = tasks.find((t) => t.id === taskId)
    return task?.title || 'Unknown Task'
  }

  const formatDuration = (createdAt: number): string => {
    const s = Math.floor((Date.now() - createdAt) / 1000)
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }

  const formatMemory = (rss: number): string => (rss >= 1024 ? `${(rss / 1024).toFixed(0)} MB` : `${rss} KB`)

  const count = ptys.length

  return (
    <Dialog open={open} onOpenChange={(v) => !v && closeTerminals()}>
      <DialogContent className="max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Active Terminals</DialogTitle>
          <DialogDescription className="sr-only">List of active terminal sessions</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 min-h-0 overflow-y-auto">
          {count === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No active terminals.</p>
          ) : (
            ptys.map((pty) => (
              <div
                key={pty.sessionId}
                className="flex items-center justify-between p-2 rounded-md bg-muted/50 hover:bg-muted transition-colors cursor-pointer"
                onClick={() => {
                  onTaskClick?.(getTaskIdFromSession(pty.sessionId))
                  closeTerminals()
                }}
              >
                <div className="flex-1 min-w-0 mr-2">
                  <p className="text-sm font-medium truncate">{getTaskName(pty.sessionId)}</p>
                  <div className="flex items-center gap-1 mt-2 flex-wrap">
                    {(() => {
                      const style = getTerminalStateStyle(pty.state)
                      return (
                        style && (
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${style.textColor} bg-current/10 w-16 text-center`}
                          >
                            {style.label}
                          </span>
                        )
                      )
                    })()}
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-muted-foreground bg-muted w-16 text-center">
                      {formatDuration(pty.createdAt)}
                    </span>
                    {stats[pty.sessionId] && (
                      <>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-muted-foreground bg-muted w-14 text-center">
                          {stats[pty.sessionId].cpu.toFixed(1)}%
                        </span>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-muted-foreground bg-muted w-14 text-center">
                          {formatMemory(stats[pty.sessionId].rss)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <IconButton
                  aria-label="Terminate terminal"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleTerminate(pty.sessionId)
                  }}
                >
                  <X className="size-4" />
                </IconButton>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** @deprecated use TerminalStatusButton + render TerminalStatusDialog once at app root. */
export function TerminalStatusPopover(props: TerminalStatusButtonProps & TerminalStatusDialogProps) {
  return <TerminalStatusButton side={props.side} />
}
