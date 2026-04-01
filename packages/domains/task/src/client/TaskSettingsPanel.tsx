import type React from 'react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
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

  useEffect(() => {
    setView('default')
  }, [taskId])

  return (
    <>
      <div className="shrink-0 h-10 px-4 -mx-3 -mt-3 border-b border-border bg-surface-1 flex items-center gap-2">
        <span className="text-sm font-medium">{view === 'history' ? 'Activity' : 'Settings'}</span>
        <button
          type="button"
          aria-label={view === 'history' ? 'Back to settings' : 'View activity'}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setView((current) => current === 'history' ? 'default' : 'history')}
        >
          <span>{view === 'history' ? 'Back to settings' : 'View activity'}</span>
        </button>
      </div>

      {view === 'history'
        ? (renderHistoryContent ? renderHistoryContent() : <TaskHistoryPanel taskId={taskId} />)
        : renderDefaultContent()}
    </>
  )
}
