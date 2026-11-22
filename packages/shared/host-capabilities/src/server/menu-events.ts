// Menu / app-shortcut event bus — the one-way main→renderer `app:*` / `browser:*`
// broadcasts driven by native menus, the `before-input-event` accelerator handler,
// the auto-updater, and the REST/MCP task-open routes. The emitter is owned by the
// Electron-main host (`menu-events.ts`, which is dual-emitted alongside the legacy
// `webContents.send` broadcasts), injected here so the `menuRouter` and the still-live
// IPC broadcasts share one instance (coexistence until the renderer drops IPC in
// slice 5). The host conforms to `MenuEventMap`; `@slayzone/api` re-exports the
// registry for its composition roots.
import type { TypedEmitter } from '@slayzone/platform/events'

/** Auto-updater progress: the `update-status` payload the Electron host's updater
 *  emits and `menu.onUpdateStatus` streams to the renderer. */
export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'not-available' }
  | { type: 'error'; message: string }

export type MenuEventMap = {
  'go-home': []
  'toggle-global-agent-panel': []
  'toggle-agent-status-panel': []
  'open-settings': []
  'open-project-settings': []
  'new-temporary-task': []
  /** `raise`: also bring the window forward (a foreground `slay tasks open`). The
   *  receiving renderer raises it: the hub that emits may not be this desktop's. */
  'open-task': [payload: { taskId: string; background?: boolean; raise?: boolean }]
  'close-task': [taskId: string]
  'open-artifact': [payload: { taskId: string; artifactId: string }]
  'screenshot-trigger': []
  'close-current-focus': []
  'close-active-task': []
  'sync-session-id': []
  'reload-browser': []
  'reload-app': []
  'zoom-factor-changed': [factor: number]
  'update-status': [status: UpdateStatus]
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

let menuEvents: TypedEmitter<MenuEventMap> | null = null

export function setMenuEvents(ev: TypedEmitter<MenuEventMap>): void {
  menuEvents = ev
}

export function getMenuEvents(): TypedEmitter<MenuEventMap> {
  if (!menuEvents)
    throw new Error('menuEvents not initialized — call setMenuEvents() in main host first')
  return menuEvents
}
