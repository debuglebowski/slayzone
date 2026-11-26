import { BrowserPanel } from '../../task-detail/lazyPanels'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/** The task's in-app browser (`browser`). */
export function BrowserKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, isActive, isResizing, panels, browser } = useTaskPageContext()
  const { panelVisibility, handlePanelToggle } = panels
  const {
    browserPanelRef,
    browserTabs,
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
        ref={browserPanelRef}
        className="h-full"
        tabs={browserTabs}
        onTabsChange={handleBrowserTabsChange}
        onRequestHide={() => handlePanelToggle('browser', false)}
        taskId={task.id}
        projectId={task.project_id}
        isResizing={isResizing}
        isActive={isActive}
        onElementSnippet={handleInsertElementSnippet}
        onScreenshot={handleScreenshot}
        canUseDomPicker={panelVisibility.terminal}
      />
    </PanelFrame>
  )
}
