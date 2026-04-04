import { ContextManagerShell } from './ContextManagerShell'

interface ContextManagerPageProps {
  selectedProjectId: string
  projectPath?: string | null
  projectName?: string
  onBack: () => void
}

export function ContextManagerPage({
  selectedProjectId,
  projectPath,
  projectName,
  onBack,
}: ContextManagerPageProps) {
  return (
    <ContextManagerShell
      selectedProjectId={selectedProjectId}
      projectPath={projectPath}
      projectName={projectName}
      onBack={onBack}
    />
  )
}
