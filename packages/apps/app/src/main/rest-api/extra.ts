// Electron-only REST routes. Pure subset (notify, automations, tasks/*,
// artifacts/{open}, tabs/*) lives in @slayzone/server and is registered via
// registerCoreRest. This file holds routes that need BrowserWindow,
// @slayzone/terminal/electron PTY manager, the in-app process manager, or
// @slayzone/task/electron renderer — none reachable from the standalone server.

import type { Express } from 'express'
import type { RestApiDeps } from '@slayzone/server'
import { registerArtifactsExportPdfRoute } from './artifacts/export-pdf'
import { registerArtifactsExportPngRoute } from './artifacts/export-png'
import { registerArtifactsExportHtmlRoute } from './artifacts/export-html'
import { registerBrowserUrlRoute } from './browser/url'
import { registerBrowserNavigateRoute } from './browser/navigate'
import { registerBrowserClickRoute } from './browser/click'
import { registerBrowserTypeRoute } from './browser/type'
import { registerBrowserEvalRoute } from './browser/eval'
import { registerBrowserContentRoute } from './browser/content'
import { registerBrowserScreenshotRoute } from './browser/screenshot'
import { registerBrowserTabsRoute } from './browser/tabs'
import { registerBrowserNewTabRoute } from './browser/new-tab'
import { registerPtyListRoute } from './pty/list'
import { registerPtyBufferRoute } from './pty/buffer'
import { registerPtyFollowRoute } from './pty/follow'
import { registerPtyWaitRoute } from './pty/wait'
import { registerPtyWriteRoute } from './pty/write'
import { registerPtySubmitRoute } from './pty/submit'
import { registerPtyKillRoute } from './pty/kill'
import { registerPtyRespawnRoute } from './pty/respawn'
import { registerProcessesListRoute } from './processes/list'
import { registerProcessesLogsRoute } from './processes/logs'
import { registerProcessesDeleteRoute } from './processes/delete'
import { registerProcessesFollowRoute } from './processes/follow'

export function registerExtraRest(app: Express, deps: RestApiDeps): void {
  // Process manager routes (uses BrowserWindow + in-app process manager)
  registerProcessesListRoute(app, deps)
  registerProcessesLogsRoute(app, deps)
  registerProcessesDeleteRoute(app, deps)
  registerProcessesFollowRoute(app, deps)

  // Artifact PDF/PNG/HTML rendering (BrowserWindow renderer)
  registerArtifactsExportPdfRoute(app, deps)
  registerArtifactsExportPngRoute(app, deps)
  registerArtifactsExportHtmlRoute(app, deps)

  // PTY routes (use @slayzone/terminal/electron — BrowserWindow + nativeTheme + ipcMain coupling)
  registerPtyListRoute(app, deps)
  registerPtyBufferRoute(app, deps)
  registerPtyFollowRoute(app, deps)
  registerPtyWaitRoute(app, deps)
  registerPtyWriteRoute(app, deps)
  registerPtySubmitRoute(app, deps)
  registerPtyKillRoute(app, deps)
  registerPtyRespawnRoute(app, deps)

  // Browser panel control (WebContentsView)
  registerBrowserUrlRoute(app, deps)
  registerBrowserNavigateRoute(app, deps)
  registerBrowserClickRoute(app, deps)
  registerBrowserTypeRoute(app, deps)
  registerBrowserEvalRoute(app, deps)
  registerBrowserContentRoute(app, deps)
  registerBrowserScreenshotRoute(app, deps)
  registerBrowserTabsRoute(app, deps)
  registerBrowserNewTabRoute(app, deps)
}
