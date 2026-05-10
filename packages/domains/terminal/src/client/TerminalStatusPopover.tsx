import { useState, useEffect, useCallback, useRef } from 'react'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
import { Monitor, X } from 'lucide-react'
import { IconButton, getTerminalStateStyle, useStablePoll } from '@slayzone/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { PtyInfo } from '@slayzone/terminal/shared'

interface TaskRef {
  id: string
  title: string
}

interface TerminalStatusPopoverProps {
  tasks: TaskRef[]
  onTaskClick?: (taskId: string) => void
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function TerminalStatusPopover({ tasks, onTaskClick, side = 'right' }: TerminalStatusPopoverProps) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [ptys, setPtys] = useState<PtyInfo[]>([])
  const [stats, setStats] = useState<Record<string, { cpu: number; rss: number }>>({})
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)

  const lastHashRef = useRef<string>('')

  const refreshPtys = useCallback(async () => {
    const list = await trpcClient.pty.list.query()
    const hash = JSON.stringify(list.map((p) => ({ s: p.sessionId, st: p.state, c: p.createdAt })))
    if (hash !== lastHashRef.current) {
      lastHashRef.current = hash
      setPtys(list)
    }
    return hash
  }, [trpcClient])

  useStablePoll(refreshPtys, { enabled: open, baseDelayMs: 5000 })

  // Tick every second for live duration display while popover is open (cosmetic).
  useEffect(() => {
    if (!open) return
    const tickInterval = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(tickInterval)
  }, [open])

  // Refresh on state-change events
  useSubscription(
    trpc.pty.onStateChange.subscriptionOptions(undefined, {
      onData: () => refreshPtys(),
    }),
  )

  // Subscribe to stats
  useEffect(() => {
    const unsub = window.api.pty.onStats((s) => setStats(s))
    return unsub
  }, [])

  // Initial load
  useEffect(() => {
    refreshPtys()
  }, [refreshPtys])

  const handleTerminate = async (sessionId: string) => {
    await trpcClient.pty.kill.mutate({ sessionId })
    refreshPtys()
  }

  // Extract taskId from sessionId (format: taskId or taskId:tabId)
  const getTaskIdFromSession = (sessionId: string): string => {
    return sessionId.split(':')[0]
  }

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

  const formatMemory = (rss: number): string => {
    return rss >= 1024 ? `${(rss / 1024).toFixed(0)} MB` : `${rss} KB`
  }

  const count = ptys.length

  if (count === 0) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <IconButton
              aria-label="Active terminals"
              variant="ghost"
              size="icon-lg"
              className="rounded-lg text-muted-foreground relative"
            >
              <Monitor className="size-5" />
              <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                {count}
              </span>
            </IconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>Active Terminals</TooltipContent>
      </Tooltip>
      <PopoverContent side={side} align="end" className="w-fit max-w-[20vw] max-h-[80vh] flex flex-col">
        <div className="space-y-3 min-h-0 flex flex-col">
          <div className="flex items-center justify-between shrink-0">
            <h4 className="font-medium text-sm">Active Terminals</h4>
            <span className="text-xs text-muted-foreground">{count} running</span>
          </div>
          <div className="space-y-2 min-h-0 overflow-y-auto">
            {ptys.map((pty) => (
              <div
                key={pty.sessionId}
                className="flex items-center justify-between p-2 rounded-md bg-muted/50 hover:bg-muted transition-colors cursor-pointer"
                onClick={() => {
                  onTaskClick?.(getTaskIdFromSession(pty.sessionId))
                  setOpen(false)
                }}
              >
                <div className="flex-1 min-w-0 mr-2">
                  <p className="text-sm font-medium truncate">{getTaskName(pty.sessionId)}</p>
                  <div className="flex items-center gap-1 mt-2 flex-wrap">
                    {(() => {
                      const style = getTerminalStateStyle(pty.state)
                      return style && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${style.textColor} bg-current/10 w-16 text-center`}>
                          {style.label}
                        </span>
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
                  onClick={(e) => { e.stopPropagation(); handleTerminate(pty.sessionId) }}
                >
                  <X className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
