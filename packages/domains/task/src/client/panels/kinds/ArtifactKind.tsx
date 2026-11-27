import { artifactIdOf } from '@slayzone/task-contracts'
import { getTaskPanels } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * One task artifact on its own (`artifact:*`, docs/plans/panel-model.md step 12):
 * the artifacts panel's viewer pinned to `settings.artifactId` — no tree, the
 * file's own toolbar. Opened from ⋯ → Artifact, or a file's "Open in its own panel".
 */
export function ArtifactKind({ panelId, instance }: PanelKindProps): React.JSX.Element {
  const { task, isResizing, canEdit, openDevServerInBrowser } = useTaskPageContext()
  const { ArtifactsPanel } = getTaskPanels()
  const artifactId = artifactIdOf(instance)
  return (
    <PanelFrame
      kind="artifact"
      panelId={panelId}
      testId="artifact-panel"
      className="overflow-hidden flex flex-col"
    >
      {artifactId ? (
        <ArtifactsPanel
          // Another file is another panel's worth of state.
          key={artifactId}
          taskId={task.id}
          isResizing={isResizing}
          pinnedArtifactId={artifactId}
          onOpenUrl={openDevServerInBrowser}
          readOnly={!canEdit}
        />
      ) : (
        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
          No artifact chosen for this panel
        </div>
      )}
    </PanelFrame>
  )
}
