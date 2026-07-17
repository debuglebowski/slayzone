import type { Express } from 'express'
import type { RestApiDeps } from './types'
import { registerNotifyRoute } from './notify'
import { registerAgentHookRoute } from './agent-hook'
import { registerAuthDeepLinkRoute } from './auth-deep-link'
import { registerProcessesListRoute } from './processes/list'
import { registerProcessesLogsRoute } from './processes/logs'
import { registerProcessesDeleteRoute } from './processes/delete'
import { registerProcessesFollowRoute } from './processes/follow'
import { registerOpenTaskRoute } from './tasks/open'
import { registerCloseTaskRoute } from './tasks/close'
import { registerArchiveTaskRoute } from './tasks/archive'
import { registerArchiveManyTaskRoute } from './tasks/archive-many'
import { registerCreateTaskRoute } from './tasks/create'
import { registerDeleteTaskRoute } from './tasks/delete'
import { registerUnarchiveTaskRoute } from './tasks/unarchive'
import { registerUpdateTaskRoute } from './tasks/update'
import { registerListTasksRoute } from './tasks/list'
import { registerSearchTasksRoute } from './tasks/search'
import { registerGetTaskRoute } from './tasks/get'
import { registerTaskSubtasksRoutes } from './tasks/subtasks'
import { registerTaskBlockersRoutes } from './tasks/blockers'
import { registerTaskBlockingRoute } from './tasks/blocking'
import { registerTaskBlockedRoutes } from './tasks/blocked'
import { registerTaskTagsRoutes } from './tasks/tags'
import { registerTaskResetConversationRoute } from './tasks/reset-conversation'
import { registerTaskProgressRoute } from './tasks/progress'
import { registerTagsCrudRoutes } from './tags/crud'
import { registerProjectsListRoute } from './projects/list'
import { registerProjectsResolveByPathRoute } from './projects/resolve-by-path'
import { registerProjectsCrudRoutes } from './projects/crud'
import { registerTemplatesCrudRoutes } from './templates/crud'
import { registerPanelsCrudRoutes } from './panels/crud'
import { registerAutomationsCrudRoutes } from './automations/crud'
import { registerArtifactsListRoute } from './artifacts/list'
import { registerArtifactsContentRoutes } from './artifacts/content'
import { registerArtifactsCrudRoutes } from './artifacts/crud'
import { registerOpenArtifactRoute } from './artifacts/open'
import { registerArtifactsExportPdfRoute } from './artifacts/export-pdf'
import { registerArtifactsExportPngRoute } from './artifacts/export-png'
import { registerArtifactsExportHtmlRoute } from './artifacts/export-html'
import { registerAutomationsRunRoute } from './automations/run'
import { registerPtyListRoute } from './pty/list'
import { registerPtyBufferRoute } from './pty/buffer'
import { registerPtyFollowRoute } from './pty/follow'
import { registerPtyWaitRoute } from './pty/wait'
import { registerPtyWriteRoute } from './pty/write'
import { registerPtySubmitRoute } from './pty/submit'
import { registerPtyKillRoute } from './pty/kill'
import { registerPtyRespawnRoute } from './pty/respawn'
import { registerPtyStartRoute } from './pty/start'
import { registerBrowserUrlRoute } from './browser/url'
import { registerBrowserNavigateRoute } from './browser/navigate'
import { registerBrowserClickRoute } from './browser/click'
import { registerBrowserTypeRoute } from './browser/type'
import { registerBrowserEvalRoute } from './browser/eval'
import { registerBrowserContentRoute } from './browser/content'
import { registerBrowserScreenshotRoute } from './browser/screenshot'
import { registerBrowserTabsRoute } from './browser/tabs'
import { registerBrowserNewTabRoute } from './browser/new-tab'
import { registerTabsCreateRoute } from './tabs/create'
import { registerTabsSplitRoute } from './tabs/split'
import { registerTabsRenameRoute } from './tabs/rename'
import { registerResolveSessionTaskRoute } from './sessions/resolve-task'
import { registerRunnersJoinTokenRoute } from './runners/join-token'

export type { RestApiDeps } from './types'

export function registerRestApi(app: Express, deps: RestApiDeps): void {
  // Notify
  registerNotifyRoute(app, deps)

  // Agent lifecycle hooks
  registerAgentHookRoute(app, deps)

  // OAuth deep-link (HTTP entry — Linux `.desktop` handler; mac uses the socket)
  registerAuthDeepLinkRoute(app, deps)

  // Processes
  registerProcessesListRoute(app, deps)
  registerProcessesLogsRoute(app, deps)
  registerProcessesDeleteRoute(app, deps)
  registerProcessesFollowRoute(app, deps)

  // Tasks
  registerOpenTaskRoute(app, deps)
  registerCloseTaskRoute(app, deps)
  registerCreateTaskRoute(app, deps)
  registerUpdateTaskRoute(app, deps)
  registerDeleteTaskRoute(app, deps)
  registerArchiveTaskRoute(app, deps)
  registerArchiveManyTaskRoute(app, deps)
  registerUnarchiveTaskRoute(app, deps)

  // Tasks — CLI-parity read/CRUD surface (hub/runner split wave 1; dark until
  // the slay CLI cuts over from direct sqlite reads). ORDER MATTERS: the fixed
  // /api/tasks/search path must register before the /api/tasks/:id matcher.
  registerListTasksRoute(app, deps)
  registerSearchTasksRoute(app, deps)
  registerGetTaskRoute(app, deps)
  registerTaskSubtasksRoutes(app, deps)
  registerTaskBlockersRoutes(app, deps)
  registerTaskBlockingRoute(app, deps)
  registerTaskBlockedRoutes(app, deps)
  registerTaskTagsRoutes(app, deps)
  registerTaskResetConversationRoute(app, deps)
  registerTaskProgressRoute(app, deps)

  // Tags
  registerTagsCrudRoutes(app, deps)

  // Projects
  registerProjectsListRoute(app, deps)
  registerProjectsResolveByPathRoute(app, deps)
  registerProjectsCrudRoutes(app, deps)

  // Templates
  registerTemplatesCrudRoutes(app, deps)

  // Panels
  registerPanelsCrudRoutes(app, deps)

  // Artifacts
  registerOpenArtifactRoute(app, deps)
  registerArtifactsListRoute(app, deps)
  registerArtifactsContentRoutes(app, deps)
  registerArtifactsCrudRoutes(app, deps)
  registerArtifactsExportPdfRoute(app, deps)
  registerArtifactsExportPngRoute(app, deps)
  registerArtifactsExportHtmlRoute(app, deps)

  // Automations
  registerAutomationsRunRoute(app, deps)
  registerAutomationsCrudRoutes(app, deps)

  // PTY
  registerPtyListRoute(app, deps)
  registerPtyBufferRoute(app, deps)
  registerPtyFollowRoute(app, deps)
  registerPtyWaitRoute(app, deps)
  registerPtyWriteRoute(app, deps)
  registerPtySubmitRoute(app, deps)
  registerPtyKillRoute(app, deps)
  registerPtyRespawnRoute(app, deps)
  registerPtyStartRoute(app, deps)

  // Terminal tabs
  registerTabsCreateRoute(app, deps)
  registerTabsSplitRoute(app, deps)
  registerTabsRenameRoute(app, deps)

  // Agent sessions (pool: session → bound task resolution for the slay CLI)
  registerResolveSessionTaskRoute(app, deps)

  // Runners (hub/runner split): loopback join-token mint for the MAIN process's
  // boot-time local-runner auto-enroll. 503 only if the runner init failed.
  registerRunnersJoinTokenRoute(app, deps)

  // Browser
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
