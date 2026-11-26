import { PRIMARY_INSTANCE_IDS } from '@slayzone/task-contracts'
import { BrowserPanel } from '../../task-detail/lazyPanels'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * A browser panel (`browser`, or another browser instance). Every instance shows its
 * own tabs of the task's one flat tab list (`browser_tabs.byPanel`), so tab ids stay
 * unique per task and `slay browser --tab` reaches a tab whichever panel shows it.
 */
export function BrowserKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, isActive, isResizing, panels, browser } = useTaskPageContext()
  const { panelVisibility, handlePanelToggle } = panels
  const {
    browserHandles,
    browserTabsFor,
    handleBrowserTabsChange,
    handleInsertElementSnippet,
    handleScreenshot
  } = browser
  return (
    <PanelFrame kind="browser" panelId={panelId} className="overflow-hidden">
      {/* NOT wrapped in Activity (keepAlive 'mounted'): useBrowserViewLifecycle's
          cleanup would destroy the WebContentsView on hide and recreate it on show,
          resetting video playback. BrowserPanel keeps the active WCV painting at
          off-screen bounds when the parent task tab is hidden (see
          useBrowserViewBounds offScreen). */}
      <BrowserPanel
        ref={browserHandles.ref(panelId)}
        className="h-full"
        tabs={browserTabsFor(panelId)}
        onTabsChange={(tabs) => handleBrowserTabsChange(panelId, tabs)}
        onRequestHide={() => handlePanelToggle(panelId, false)}
        taskId={task.id}
        projectId={task.project_id}
        isResizing={isResizing}
        isActive={isActive}
        onElementSnippet={handleInsertElementSnippet}
        onScreenshot={handleScreenshot}
        canUseDomPicker={panelVisibility.terminal}
        primaryInstance={panelId === PRIMARY_INSTANCE_IDS.browser}
      />
    </PanelFrame>
  )
}
