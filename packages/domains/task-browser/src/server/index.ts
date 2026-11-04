// The hub's side of the browser panel: `app.browserRelay` (which client owns a task's
// live tabs, and the request/reply channel `slay browser` rides to reach it). The web
// views themselves are client-local — see `../shared/browser-host.ts`.
export { BrowserRelay } from './browser-relay'
export {
  appBrowserRelayRouter,
  setBrowserRelayRouterDeps,
  type AppBrowserRelayMounts
} from './relay-router'
