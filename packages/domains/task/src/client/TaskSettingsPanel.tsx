import type React from 'react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, safeClipboardWriteText } from '@slayzone/ui'
import { TaskHistoryPanel } from './TaskHistoryPanel'

interface TaskSettingsPanelProps {
  taskId: string
  renderDefaultContent: () => ReactNode
  renderHistoryContent?: () => ReactNode
}

export function TaskSettingsPanel({
  taskId,
  renderDefaultContent,
  renderHistoryContent
}: TaskSettingsPanelProps): React.JSX.Element {
  // The view belongs to the task it was chosen on: another task starts on 'default'.
  // Derived, not reset from an effect — task tabs hide this panel in <Activity>, and a
  // re-show re-runs effects, so a resetting effect re-rendered the whole panel on
  // every tab switch.
  const [chosen, setChosen] = useState<{ taskId: string; view: 'default' | 'history' }>({
    taskId,
    view: 'default'
  })
  const view = chosen.taskId === taskId ? chosen.view : 'default'
  const [copied, setCopied] = useState(false)

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
                void safeClipboardWriteText(taskId)
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
          onClick={() => setChosen({ taskId, view: view === 'history' ? 'default' : 'history' })}
        >
          {view === 'history' ? 'Back to settings' : 'View activity'}
        </button>
      </div>

      {view === 'history' ? (
        renderHistoryContent ? (
          renderHistoryContent()
        ) : (
          <TaskHistoryPanel taskId={taskId} />
        )
      ) : (
        renderDefaultContent()
      )}
    </>
  )
}
