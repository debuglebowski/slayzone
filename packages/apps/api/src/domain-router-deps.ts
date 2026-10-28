/**
 * Wires the host seams of domain-owned routers from api's own registries, at load
 * (imported by `router.ts`, like `procedure-policy`). A domain router never imports
 * `@slayzone/api`; the registries below stay api's (exactly one copy each, shared
 * with routers still in api), and each seam reads them live on every call, so a
 * registry set later by a composition root is seen.
 *
 * @module api/domain-router-deps
 */
import { setDiagnosticsRouterDeps } from '@slayzone/diagnostics/server'
import { getWorkspaceDeps, setFileEditorRouterDeps } from '@slayzone/file-editor/server'
import { setProjectsRouterDeps } from '@slayzone/projects/server'
import { setArtifactsRouterDeps } from '@slayzone/task-artifacts/server'
import { setWorktreesRouterDeps } from '@slayzone/worktrees/server'
import { setHostCapabilitiesDeps } from '@slayzone/host-capabilities/server'
import { setUsageRouterDeps } from '@slayzone/terminal/server'
import { setTaskBrowserRouterDeps } from '@slayzone/task-browser/server'
import { setAgentPanelsRouterDeps } from '@slayzone/agent-panels/server'
import { setUsageAnalyticsRouterDeps } from '@slayzone/usage-analytics/server'
import { createAccessScope } from './access'
import { getAppDeps, getComputersDepsOrNull } from './app-deps'
import { accessRequestOf, ownedProjectIds } from './owner-gate'

setDiagnosticsRouterDeps({
  accessScopeFor: (ctx) => createAccessScope(ctx.db, accessRequestOf(ctx))
})

setFileEditorRouterDeps({
  shellShowItemInFolder: (absPath) => getAppDeps().shellShowItemInFolder(absPath)
})

setProjectsRouterDeps({
  countUsableComputers: () => {
    const gateway = getComputersDepsOrNull()?.getGateway()
    return gateway ? gateway.listUsableComputers().length : null
  }
})

// The workspace registry is file-editor's, not api's; api only bridges it to the
// `worktrees` seam, since worktrees does not otherwise reach into file-editor's state.
setWorktreesRouterDeps({
  getWorkspace: () => getWorkspaceDeps(),
  shellOpenPath: (absPath) => getAppDeps().shellOpenPath(absPath)
})

setArtifactsRouterDeps({
  getDownloadHost: () => {
    const deps = getAppDeps()
    return {
      showSaveDialog: deps.dialogShowSaveDialog,
      showOpenDialog: deps.dialogShowOpenDialog,
      getDownloadsDir: deps.appGetDownloadsDir,
      showItemInFolder: deps.shellShowItemInFolder,
      buildExportHtml: deps.artifactBuildExportHtml,
      renderPdfToFile: deps.artifactRenderPdfToFile,
      renderPngToFile: deps.artifactRenderPngToFile
    }
  }
})

// The `app.*` routers that moved out of api read `AppDeps` (built from their types)
// through these seams. Each getter reads the registry on every call: unset, it throws
// exactly as `getAppDeps()` did inside the router.
setHostCapabilitiesDeps({ getHost: () => getAppDeps() })
setUsageRouterDeps({ getHost: () => getAppDeps() })
setTaskBrowserRouterDeps({ getHost: () => getAppDeps() })
setAgentPanelsRouterDeps({ getHost: () => getAppDeps() })

// `app.leaderboard` sums over the caller's projects only (T-17): api's owner gate.
setUsageAnalyticsRouterDeps({ ownedProjectIds })
