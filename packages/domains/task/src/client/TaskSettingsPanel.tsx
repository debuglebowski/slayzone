import type React from 'react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { TaskHistoryPanel } from './TaskHistoryPanel'

interface TaskSettingsPanelProps {
  taskId: string
  renderDefaultContent: () => ReactNode
  renderHistoryContent?: () => ReactNode
}

export function TaskSettingsPanel({
  taskId,
  renderDefaultContent,
  renderHistoryContent,
}: TaskSettingsPanelProps): React.JSX.Element {
  const [view, setView] = useState<'default' | 'history'>('default')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setView('default')
  }, [taskId])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <>
      <div className="shrink-0 h-10 px-4 -mx-3 -mt-3 border-b border-border bg-surface-1 flex items-center gap-2">
        <span className="text-sm font-medium">{view === 'history' ? 'Activity' : 'Settings'}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Copy task ID"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                navigator.clipboard.writeText(taskId)
                setCopied(true)
              }}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{copied ? 'Copied!' : 'Copy task ID'}</TooltipContent>
        </Tooltip>
        <button
          type="button"
          aria-label={view === 'history' ? 'Back to settings' : 'View activity'}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setView((current) => current === 'history' ? 'default' : 'history')}
        >
          {view === 'history' ? 'Back to settings' : 'View activity'}
        </button>
      </div>

      {view === 'history'
        ? (renderHistoryContent ? renderHistoryContent() : <TaskHistoryPanel taskId={taskId} />)
        : renderDefaultContent()}
    </>
  )
}
