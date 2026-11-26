import { WebPanelView } from '../../WebPanelView'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/** A configured web panel (`web:*`, custom or predefined). Null if it is not enabled. */
export function WebKind({ panelId }: PanelKindProps): React.JSX.Element | null {
  const { task, isActive, isResizing, web } = useTaskPageContext()
  const { enabledWebPanels, handleWebPanelUrlChange, handleWebPanelFaviconChange } = web
  const wp = enabledWebPanels.find((p) => p.id === panelId)
  if (!wp) return null
  return (
    <PanelFrame kind="web" panelId={wp.id} label={wp.name} className="overflow-hidden">
      {/* NOT wrapped in Activity (keepAlive 'mounted'): same reason as BrowserPanel —
          useBrowserViewLifecycle would destroy the WCV on hide. Off-screen park
          (offScreen prop on useBrowserView) keeps it painting while parent task tab
          is hidden. */}
      <WebPanelView
        taskId={task.id}
        panelId={wp.id}
        url={task.web_panel_urls?.[wp.id] || wp.baseUrl}
        baseUrl={wp.baseUrl}
        name={wp.name}
        blockDesktopHandoff={wp.blockDesktopHandoff === true}
        handoffProtocol={wp.handoffProtocol}
        handoffHostScope={wp.handoffHostScope}
        onUrlChange={handleWebPanelUrlChange}
        onFaviconChange={handleWebPanelFaviconChange}
        isResizing={isResizing}
        isActive={isActive}
      />
    </PanelFrame>
  )
}
