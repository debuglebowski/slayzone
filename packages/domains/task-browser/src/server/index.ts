// `app.browser` / `app.webview` tRPC routers + the host seam they read. Composed by
// `@slayzone/api` under `app`, which also wires the seam from its `AppDeps` registry.
export {
  appBrowserRouter,
  appWebviewRouter,
  type AppBrowserRouter,
  type AppBrowserMounts,
  type AppWebviewRouter,
  type AppWebviewMounts
} from './router'
export {
  setTaskBrowserRouterDeps,
  type TaskBrowserRouterDeps,
  type TaskBrowserHost,
  type BrowserViewHost,
  type WebviewHost
} from './router-deps'
