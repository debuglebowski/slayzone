import { useState } from 'react'
import { isWebPageInstance, webPageLabel, webPageUrlOf } from '@slayzone/task-contracts'
import { WebPanelView } from '../../WebPanelView'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'
import { WebPageUrlDialog, WebPageUrlPrompt } from './WebPageUrl'

/**
 * A `web` panel: a configured web panel (`web:*` in panel_config, custom or
 * predefined), or a Web page — one static URL kept in `settings.url`.
 */
export function WebKind(props: PanelKindProps): React.JSX.Element | null {
  return isWebPageInstance(props.instance) ? (
    <WebPageKind {...props} />
  ) : (
    <WebPanelKind {...props} />
  )
}

/**
 * A configured web panel. The primary instance's id is the web panel's own id;
 * another instance of the same web panel carries it in `settings.panelId` and keeps
 * its own URL (`web_panel_urls` is keyed by instance id) and its own view. Null if
 * the web panel is not enabled.
 */
function WebPanelKind({ panelId, instance }: PanelKindProps): React.JSX.Element | null {
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

/** Navigation inside a web page is not kept: it always opens its URL. */
const ignoreUrlChange = (): void => {
  // Nothing to keep: the page reopens at its URL.
}

/**
 * A Web page (docs/plans/panel-model.md step 12): one static URL, no address bar —
 * the Browser is the panel for going places. Asks for its URL when it first shows;
 * "Edit URL…" (header or tab menu) changes it.
 */
function WebPageKind({ panelId, instance }: PanelKindProps): React.JSX.Element {
  const { task, isActive, isResizing, canEdit, panels } = useTaskPageContext()
  const [editing, setEditing] = useState(false)
  const url = webPageUrlOf(instance)
  const label = instance.name ?? (url ? webPageLabel(url) : 'Web page')
  const setUrl = (next: string): void => panels.updateInstanceSettings(panelId, { url: next })
  return (
    <PanelFrame
      kind="web"
      panelId={panelId}
      label={label}
      testId="web-page-panel"
      className="overflow-hidden"
    >
      {url ? (
        <WebPanelView
          // A new URL is a new page: the view starts over on it.
          key={url}
          taskId={task.id}
          panelId={panelId}
          url={url}
          baseUrl={url}
          name={label}
          onUrlChange={ignoreUrlChange}
          onEditUrl={canEdit ? () => setEditing(true) : undefined}
          isResizing={isResizing}
          isActive={isActive}
        />
      ) : (
        <WebPageUrlPrompt canEdit={canEdit} onSubmit={setUrl} />
      )}
      <WebPageUrlDialog
        open={editing}
        url={url ?? ''}
        onOpenChange={setEditing}
        onSubmit={setUrl}
      />
    </PanelFrame>
  )
}
