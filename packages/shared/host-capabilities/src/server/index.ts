/**
 * The `app.*` routers over host (main-process) capabilities — clipboard, screenshot,
 * files, shell, meta, window, shortcuts, auth, dialog, task windows — and the seam
 * they read the host through. Composed by `@slayzone/api` under `app`; a domain's
 * client types against the `App*Mounts` it calls (README "Typed views" in
 * `@slayzone/transport`).
 */
export {
  appClipboardRouter,
  appScreenshotRouter,
  appFilesRouter,
  appShellRouter,
  appMetaRouter,
  appWindowRouter,
  appShortcutsRouter,
  appAuthRouter,
  appDialogRouter,
  appTaskWindowsRouter,
  type AppClipboardRouter,
  type AppClipboardMounts,
  type AppScreenshotRouter,
  type AppScreenshotMounts,
  type AppFilesRouter,
  type AppFilesMounts,
  type AppShellRouter,
  type AppShellMounts,
  type AppMetaRouter,
  type AppMetaMounts,
  type AppWindowRouter,
  type AppWindowMounts,
  type AppShortcutsRouter,
  type AppShortcutsMounts,
  type AppAuthRouter,
  type AppAuthMounts,
  type AppDialogRouter,
  type AppDialogMounts,
  type AppTaskWindowsRouter,
  type AppTaskWindowsMounts
} from './routers'
export {
  setHostCapabilitiesDeps,
  getHost,
  setAuthEvents,
  getAuthEvents,
  type AuthEventMap,
  type HostCapabilities,
  type HostCapabilitiesDeps,
  type ClipboardHost,
  type ScreenshotHost,
  type FilesHost,
  type ShellHost,
  type MetaHost,
  type WindowHost,
  type ShortcutsHost,
  type DialogHost,
  type AuthHost,
  type TaskWindowsHost
} from './host'
export { hubGithubSignInConvexUrl } from './github-sign-in-url'
// The `menu` router (top-level key `menu`) and the menu/app-shortcut bus it streams.
export { menuRouter, type MenuRouter, type MenuMounts } from './menu-router'
export { setMenuEvents, getMenuEvents, type MenuEventMap } from './menu-events'
