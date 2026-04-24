import type { Express } from 'express'
import type { RestApiDeps } from './types'
import { registerNotifyRoute } from './notify'
import { registerProcessesListRoute } from './processes/list'
import { registerProcessesLogsRoute } from './processes/logs'
import { registerProcessesDeleteRoute } from './processes/delete'
import { registerProcessesFollowRoute } from './processes/follow'
import { registerOpenTaskRoute } from './tasks/open'
import { registerCloseTaskRoute } from './tasks/close'
import { registerOpenAssetRoute } from './assets/open'
import { registerAssetsExportPdfRoute } from './assets/export-pdf'
import { registerAssetsExportPngRoute } from './assets/export-png'
import { registerAssetsExportHtmlRoute } from './assets/export-html'
import { registerAutomationsRunRoute } from './automations/run'
import { registerPtyListRoute } from './pty/list'
import { registerPtyBufferRoute } from './pty/buffer'
import { registerPtyFollowRoute } from './pty/follow'
import { registerPtyWaitRoute } from './pty/wait'
import { registerPtyWriteRoute } from './pty/write'
import { registerPtyKillRoute } from './pty/kill'
import { registerBrowserUrlRoute } from './browser/url'
import { registerBrowserNavigateRoute } from './browser/navigate'
import { registerBrowserClickRoute } from './browser/click'
import { registerBrowserTypeRoute } from './browser/type'
import { registerBrowserEvalRoute } from './browser/eval'
import { registerBrowserContentRoute } from './browser/content'
import { registerBrowserScreenshotRoute } from './browser/screenshot'

export type { RestApiDeps } from './types'

export function registerRestApi(app: Express, deps: RestApiDeps): void {
  // Notify
  registerNotifyRoute(app, deps)

  // Processes
  registerProcessesListRoute(app, deps)
  registerProcessesLogsRoute(app, deps)
  registerProcessesDeleteRoute(app, deps)
  registerProcessesFollowRoute(app, deps)

  // Tasks
  registerOpenTaskRoute(app, deps)
  registerCloseTaskRoute(app, deps)

  // Assets
  registerOpenAssetRoute(app, deps)
  registerAssetsExportPdfRoute(app, deps)
  registerAssetsExportPngRoute(app, deps)
  registerAssetsExportHtmlRoute(app, deps)

  // Automations
  registerAutomationsRunRoute(app, deps)

  // PTY
  registerPtyListRoute(app, deps)
  registerPtyBufferRoute(app, deps)
  registerPtyFollowRoute(app, deps)
  registerPtyWaitRoute(app, deps)
  registerPtyWriteRoute(app, deps)
  registerPtyKillRoute(app, deps)

  // Browser
  registerBrowserUrlRoute(app, deps)
  registerBrowserNavigateRoute(app, deps)
  registerBrowserClickRoute(app, deps)
  registerBrowserTypeRoute(app, deps)
  registerBrowserEvalRoute(app, deps)
  registerBrowserContentRoute(app, deps)
  registerBrowserScreenshotRoute(app, deps)
}
