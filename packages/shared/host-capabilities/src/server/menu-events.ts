// The hub's task/browser request bus — events a HUB raises about its own tasks for
// the clients signed in to it: a `slay tasks open` / `done --close`, an artifact to
// show, `slay browser` opening a panel or tab. The hub's REST/MCP routes emit here and
// the `menuRouter` subscriptions stream them (`HubTaskEvents` listens on every hub).
//
// NOT this device's native menu, accelerators, updater or zoom: those are client-local
// (`@slayzone/platform/client-host`) — Electron main hands them to its own renderers
// directly, and the hub's old subscriptions for them never fire (task 557ebb72).
import type { TypedEmitter } from '@slayzone/platform/events'

/** Auto-updater progress — defined by the client host contract; re-exported for the
 *  types that still name it here. */
export type { UpdateStatus } from '@slayzone/platform/client-host'

export type HubMenuEventMap = {
  /** `raise`: also bring the window forward (a foreground `slay tasks open`). The
   *  receiving renderer raises it: the hub that emits may not be this desktop's. */
  'open-task': [payload: { taskId: string; background?: boolean; raise?: boolean }]
  'close-task': [taskId: string]
  'open-artifact': [payload: { taskId: string; artifactId: string }]
  /** `origin`: where the `slay browser` caller runs as the hub sees it (task-browser
   *  `BrowserRequestOrigin`); the client decides what a URL from it may load.
   *  `principal`: the requesting user (null on a login-off hub) — only that user's
   *  clients receive it (`menuRouter`). Absent = not a user's request: everyone. */
  'browser-ensure-panel-open': [
    payload: {
      taskId: string
      url?: string
      tabId?: string
      origin?: 'hub-machine' | 'elsewhere'
      principal?: string | null
      /** Open a NEW isolated tab (an untrusted caller named no tab). */
      isolated?: boolean
    }
  ]
  'browser-create-tab': [
    payload: {
      taskId: string
      tabId: string
      url?: string
      background?: boolean
      origin?: 'hub-machine' | 'elsewhere'
      principal?: string | null
      /** Create it isolated: its own empty browser (any caller but the local agent). */
      isolated?: boolean
    }
  ]
  'browser-agent-touched': [payload: { taskId: string; tabId: string }]
}

let menuEvents: TypedEmitter<HubMenuEventMap> | null = null

export function setMenuEvents(ev: TypedEmitter<HubMenuEventMap>): void {
  menuEvents = ev
}

export function getMenuEvents(): TypedEmitter<HubMenuEventMap> {
  if (!menuEvents)
    throw new Error('menuEvents not initialized — call setMenuEvents() in main host first')
  return menuEvents
}
