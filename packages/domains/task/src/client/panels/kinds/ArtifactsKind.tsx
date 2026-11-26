import type { ArtifactsSidebarState } from '@slayzone/task-contracts'
import { PRIMARY_INSTANCE_IDS } from '@slayzone/task-contracts'
import { ArtifactShareDialog } from '@slayzone/projects/client'
import { getTaskPanels } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * The task's artifacts (`artifacts`, or another artifacts instance, whose open file
 * and sidebar live in `panel_instance_state`); the panel itself is injected by the app.
 */
export function ArtifactsKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, isResizing, canEdit, openDevServerInBrowser, panels, artifacts } =
    useTaskPageContext()
  const {
    artifactsHandles,
    handleActiveArtifactIdChange,
    handleArtifactsSidebarChange,
    sharingEnabled,
    sharingArtifact,
    setSharingArtifact
  } = artifacts
  const { ArtifactsPanel } = getTaskPanels()
  const primary = panelId === PRIMARY_INSTANCE_IDS.artifacts
  const own = panels.instanceState.get(panelId)
  const patch = (p: Record<string, unknown>): void => panels.instanceState.patch(panelId, p)
  return (
    <PanelFrame
      kind="artifacts"
      panelId={panelId}
      className="overflow-hidden flex flex-col"
      suspendedSiblings={
        primary &&
        sharingArtifact && (
          <ArtifactShareDialog
            artifactId={sharingArtifact.id}
            projectId={task.project_id}
            title={sharingArtifact.title}
            open
            onOpenChange={(open) => !open && setSharingArtifact(null)}
            onMoved={(newId) => {
              setSharingArtifact((a) => (a ? { ...a, id: newId } : a))
              artifactsHandles.get(panelId)?.selectArtifact(newId)
            }}
          />
        )
      }
    >
      <ArtifactsPanel
        ref={artifactsHandles.ref(panelId)}
        taskId={task.id}
        isResizing={isResizing}
        initialActiveArtifactId={
          primary
            ? task.active_artifact_id
            : typeof own.activeArtifactId === 'string'
              ? own.activeArtifactId
              : null
        }
        // The open file and sidebar are saved on the task: a View member's
        // stay local (T-100).
        onActiveArtifactIdChange={
          canEdit
            ? primary
              ? handleActiveArtifactIdChange
              : (id) => patch({ activeArtifactId: id ?? undefined })
            : undefined
        }
        initialSidebarState={
          primary
            ? task.artifacts_sidebar
            : ((own.artifactsSidebar as ArtifactsSidebarState | undefined) ?? null)
        }
        onSidebarStateChange={
          canEdit
            ? primary
              ? handleArtifactsSidebarChange
              : (state) => patch({ artifactsSidebar: state })
            : undefined
        }
        onOpenUrl={openDevServerInBrowser}
        onShareArtifact={sharingEnabled ? setSharingArtifact : undefined}
        readOnly={!canEdit}
      />
    </PanelFrame>
  )
}
