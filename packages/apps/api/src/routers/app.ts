import { router } from '@slayzone/trpc-server'
import {
  appClipboardRouter,
  appScreenshotRouter,
  appFilesRouter,
  appShellRouter,
  appMetaRouter,
  appWindowRouter,
  appShortcutsRouter,
  appAuthRouter,
  appDialogRouter,
  appTaskWindowsRouter
} from '@slayzone/host-capabilities/server'
import { appBackupRouter, appExportImportRouter } from '@slayzone/settings/server'
import { appLeaderboardRouter } from '@slayzone/usage-analytics/server'
import { appUsageRouter } from '@slayzone/terminal/server'
import { appFeedbackRouter } from '@slayzone/feedback/server'
import { appBrowserRouter, appWebviewRouter } from '@slayzone/task-browser/server'
import { appFloatingAgentRouter } from '@slayzone/agent-panels/server'

// App-level router — main-process capabilities grouped by concern, mounted at `app`.
// Each sub-router lives with the package that owns it (host capabilities in
// `@slayzone/host-capabilities`, the rest in their domain), so a domain's client can
// type against just the `app.*` routers it calls (`{ app: { meta: AppMetaRouter } }`,
// asserted in `../router.ts`). The keys below ARE the wire paths
// (`app.meta.getVersion`) and the policy keys: never rename or move one, a client and
// a hub of different versions must agree. `app.exportImport` (in `@slayzone/settings`)
// reads ops api builds per request with its access scope (`../domain-router-deps`).

export const appLevelRouter = router({
  backup: appBackupRouter,
  clipboard: appClipboardRouter,
  screenshot: appScreenshotRouter,
  leaderboard: appLeaderboardRouter,
  exportImport: appExportImportRouter,
  usage: appUsageRouter,
  files: appFilesRouter,
  shell: appShellRouter,
  feedback: appFeedbackRouter,
  meta: appMetaRouter,
  window: appWindowRouter,
  shortcuts: appShortcutsRouter,
  auth: appAuthRouter,
  dialog: appDialogRouter,
  browser: appBrowserRouter,
  floatingAgent: appFloatingAgentRouter,
  webview: appWebviewRouter,
  taskWindows: appTaskWindowsRouter
})
