import { WebPanelView } from '../../WebPanelView'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * A configured web panel (`web:*`, custom or predefined). The primary instance's id
 * is the web panel's own id; another instance of the same web panel carries it in
 * `settings.panelId` and keeps its own URL (`web_panel_urls` is keyed by instance id)
 * and its own view. Null if the web panel is not enabled.
 */
export function WebKind({ panelId, instance }: PanelKindProps): React.JSX.Element | null {
  const { task, isActive, isResizing, web } = useTaskPageContext()
  const { enabledWebPanels, handleWebPanelUrlChange, handleWebPanelFaviconChange } = web
  const webPanelId =
    typeof instance.settings.panelId === 'string' ? instance.settings.panelId : panelId
  const wp = enabledWebPanels.find((p) => p.id === webPanelId)
  if (!wp) return null
  return (
    <PanelFrame kind="web" panelId={panelId} label={wp.name} className="overflow-hidden">
      {/* NOT wrapped in Activity (keepAlive 'mounted'): same reason as BrowserPanel —
          useBrowserViewLifecycle would destroy the WCV on hide. Off-screen park
          (offScreen prop on useBrowserView) keeps it painting while parent task tab
          is hidden. */}
      <WebPanelView
        taskId={task.id}
        panelId={panelId}
        url={task.web_panel_urls?.[panelId] || wp.baseUrl}
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
