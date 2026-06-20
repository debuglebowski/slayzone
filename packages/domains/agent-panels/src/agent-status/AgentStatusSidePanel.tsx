import type { ColumnConfig } from '@slayzone/projects/shared'
import { AgentStatusPanel } from './AgentStatusPanel'
import type { IdleTask } from './useIdleTasks'

interface AgentStatusSidePanelProps {
  width: number
  idleTasks: IdleTask[]
  filterCurrentProject: boolean
  onFilterToggle: () => void
  onNavigate: (taskId: string) => void
  onDismiss: (sessionId: string) => void
  columnsByProjectId: Map<string, ColumnConfig[] | null>
  selectedProjectId: string
  currentProjectName?: string
}

export function AgentStatusSidePanel({
  width,
  idleTasks,
  filterCurrentProject,
  onFilterToggle,
  onNavigate,
  onDismiss,
  columnsByProjectId,
  selectedProjectId,
  currentProjectName
}: AgentStatusSidePanelProps) {
  return (
    <div
      className="relative h-full rounded-md bg-surface-1 border border-border overflow-hidden flex flex-col"
      style={{ width }}
    >
      <div className="flex items-center shrink-0 h-10 px-2 gap-1 border-b border-border bg-surface-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Agent Status
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <AgentStatusPanel
          idleTasks={idleTasks}
          filterCurrentProject={filterCurrentProject}
          onFilterToggle={onFilterToggle}
          onNavigate={onNavigate}
          onDismiss={onDismiss}
          columnsByProjectId={columnsByProjectId}
          selectedProjectId={selectedProjectId}
          currentProjectName={currentProjectName}
        />
      </div>
    </div>
  )
}
