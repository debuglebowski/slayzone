import { ProjectContextFlat } from './ProjectContextFlat'
import { ProjectContextFilesView } from './ProjectContextFilesView'
import { LegacyContextManager } from './LegacyContextManager'
import type { ContextManagerSettingsProps } from './ContextManagerSettings.types'

export type { ContextManagerSection, ProjectContextManagerTab } from './ContextManagerSettings.types'

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ContextManagerSettings({
  scope,
  projectId,
  projectPath,
  projectName,
  projectTab,
  onOpenContextManager,
  initialSection
}: ContextManagerSettingsProps) {
  const isProject = scope === 'project' && !!projectId && !!projectPath
  const activeProjectTab = projectTab ?? 'config'

  if (isProject) {
    if (activeProjectTab === 'files') {
      return <ProjectContextFilesView projectId={projectId!} projectPath={projectPath!} />
    }

    return (
      <ProjectContextFlat
        projectId={projectId!}
        projectPath={projectPath!}
        projectName={projectName}
        onOpenContextManager={onOpenContextManager}
      />
    )
  }

  return <LegacyContextManager initialSection={initialSection ?? null} />
}
