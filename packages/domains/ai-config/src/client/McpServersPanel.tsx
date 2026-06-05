import { ComputerMcpPanel, ProjectMcpPanel } from './mcp-servers-panel'

interface McpServersPanelProps {
  mode: 'computer' | 'project'
  projectPath?: string
  projectId?: string
}

export function McpServersPanel({ mode, projectPath, projectId }: McpServersPanelProps) {
  if (mode === 'project' && projectPath && projectId) {
    return <ProjectMcpPanel projectPath={projectPath} projectId={projectId} />
  }
  return <ComputerMcpPanel />
}
