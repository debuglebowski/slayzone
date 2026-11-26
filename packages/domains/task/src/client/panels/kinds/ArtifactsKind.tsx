import { ArtifactShareDialog } from '@slayzone/projects/client'
import { getTaskPanels } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/** The task's artifacts (`artifacts`); the panel itself is injected by the app. */
export function ArtifactsKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, isResizing, canEdit, openDevServerInBrowser, artifacts } = useTaskPageContext()
  const {
    artifactsPanelRef,
    artifactsPanelRefCallback,
    handleActiveArtifactIdChange,
    handleArtifactsSidebarChange,
    sharingEnabled,
    sharingArtifact,
    setSharingArtifact
  } = artifacts
  const { ArtifactsPanel } = getTaskPanels()
  return (
    <PanelFrame
      kind="artifacts"
      panelId={panelId}
      className="overflow-hidden flex flex-col"
      suspendedSiblings={
        sharingArtifact && (
          <ArtifactShareDialog
            artifactId={sharingArtifact.id}
            projectId={task.project_id}
            title={sharingArtifact.title}
            open
            onOpenChange={(open) => !open && setSharingArtifact(null)}
            onMoved={(newId) => {
              setSharingArtifact((a) => (a ? { ...a, id: newId } : a))
              artifactsPanelRef.current?.selectArtifact(newId)
            }}
          />
        )
      }
    >
      <ArtifactsPanel
        ref={artifactsPanelRefCallback}
        taskId={task.id}
        isResizing={isResizing}
        initialActiveArtifactId={task.active_artifact_id}
        // The open file and sidebar are saved on the task: a View member's
        // stay local (T-100).
        onActiveArtifactIdChange={canEdit ? handleActiveArtifactIdChange : undefined}
        initialSidebarState={task.artifacts_sidebar}
        onSidebarStateChange={canEdit ? handleArtifactsSidebarChange : undefined}
        onOpenUrl={openDevServerInBrowser}
        onShareArtifact={sharingEnabled ? setSharingArtifact : undefined}
        readOnly={!canEdit}
      />
    </PanelFrame>
  )
}
