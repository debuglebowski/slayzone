import { McpServersPanel } from './McpServersPanel'
import { ComputerMcpView } from './ComputerMcpView'
import type { ConfigLevel } from '../shared'

interface McpSectionProps {
  level: ConfigLevel
  projectId: string | null
  projectPath?: string | null
}

export function McpSection({ level, projectId, projectPath }: McpSectionProps) {
  if (level === 'computer') {
    return <ComputerMcpView />
  }

  if (level === 'project') {
    return (
      <McpServersPanel
        mode="project"
        projectPath={projectPath ?? undefined}
        projectId={projectId ?? undefined}
      />
    )
  }

  // Library = favorites from curated catalog
  return (
    <McpServersPanel
      mode="computer"
    />
  )
}
