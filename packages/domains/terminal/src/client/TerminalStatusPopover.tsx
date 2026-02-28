import { useState, useEffect, useCallback } from 'react'
import { Monitor, X } from 'lucide-react'
import { Button, getTerminalStateStyle } from '@slayzone/ui'
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
}

export function TerminalStatusPopover({ tasks, onTaskClick }: TerminalStatusPopoverProps) {
  const [ptys, setPtys] = useState<PtyInfo[]>([])
  const [open, setOpen] = useState(false)

  const refreshPtys = useCallback(async () => {
    const list = await window.api.pty.list()
    setPtys(list)
  }, [])

  // Refresh list when popover opens
  useEffect(() => {
    if (open) {
      refreshPtys()
      // Refresh every 5 seconds while open
      const interval = setInterval(refreshPtys, 5000)
      return () => clearInterval(interval)
    }
    return undefined
  }, [open, refreshPtys])

  // Also refresh on attention events
  useEffect(() => {
    const unsub = window.api.pty.onAttention(() => {
      refreshPtys()
    })
    return unsub
  }, [refreshPtys])

  // Initial load
  useEffect(() => {
    refreshPtys()
  }, [refreshPtys])

  const handleTerminate = async (sessionId: string) => {
    await window.api.pty.kill(sessionId)
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

  const formatIdleTime = (lastOutputTime: number): string => {
    const seconds = Math.floor((Date.now() - lastOutputTime) / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ago`
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
            <Button
              variant="ghost"
              size="icon-lg"
              className="rounded-lg text-muted-foreground relative"
              aria-label="Active terminals"
            >
              <Monitor className="size-5" />
              <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                {count}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Active Terminals</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="end" className="w-80">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">Active Terminals</h4>
            <span className="text-xs text-muted-foreground">{count} running</span>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
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
                  <p className="text-xs text-muted-foreground">
                    {(() => {
                      const style = getTerminalStateStyle(pty.state)
                      return style && <span className={style.textColor}>{style.label}</span>
                    })()}
                    {' · '}
                    {formatIdleTime(pty.lastOutputTime)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  aria-label="Terminate terminal"
                  onClick={(e) => { e.stopPropagation(); handleTerminate(pty.sessionId) }}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
