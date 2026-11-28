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
import { getWorkspaceDeps, setFileEditorRouterDeps } from '@slayzone/file-editor/hub'
import { setProjectsRouterDeps, setSharingRouterDeps } from '@slayzone/projects/server'
import { setArtifactsRouterDeps } from '@slayzone/task-artifacts/server'
import { setTagsRouterDeps } from '@slayzone/tags/server'
import { detectChildRepos, setWorktreesRouterDeps } from '@slayzone/worktrees/hub'
import { setMainAgentDeps, setTaskSearchScope } from '@slayzone/task/server'
import { setHostCapabilitiesDeps } from '@slayzone/host-capabilities/server'
import { setUsageRouterDeps } from '@slayzone/terminal/hub'
import { setAgentPanelsRouterDeps } from '@slayzone/agent-panels/server'
import { setUsageAnalyticsRouterDeps } from '@slayzone/usage-analytics/server'
import { setComputersRouterDeps } from '@slayzone/computers/server'
import { setExportImportOpsFactory } from '@slayzone/settings/server'
import { createAccessScope, invalidateAccessCache } from './access'
import { filterManagedComputers, mayManageComputer } from './computer-access'
import { buildExportImportOps } from './export-import'
import { emitTasksChanged, getAppDeps, getComputersDepsOrNull } from './app-deps'
import { accessRequestOf, ownedProjectIds } from './owner-gate'

setDiagnosticsRouterDeps({
  // Diagnostics events are runtime records (agents, ptys, computers): their task's or
  // project's OWNER only, never a member of a shared one (T-100).
  accessScopeFor: (ctx) => {
    const scope = createAccessScope(ctx.db, accessRequestOf(ctx))
    return {
      enforcing: scope.enforcing,
      allowsAll: (resources) =>
        scope.allowsAll(
          resources.map((r) =>
            r.kind === 'task'
              ? { kind: 'taskOwner', id: r.id }
              : r.kind === 'project'
                ? { kind: 'projectOwner', id: r.id }
                : r
          )
        )
    }
  }
})

// Sharing (T-100): the decision is api's one access function; the hub adds moving a
// computer-held artifact to the hub (`setSharingRouterDeps` in its composition).
setSharingRouterDeps({
  roleOf: (ctx, r) => Promise.resolve(createAccessScope(ctx.db, accessRequestOf(ctx)).roleOf(r)),
  invalidate: invalidateAccessCache,
  tasksChanged: (taskIds) => emitTasksChanged({ taskIds })
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

// Task writes outside the task domain (a task's tags, its artifacts) signal on the
// notify bus the task ops' own `onMutation` uses, naming the tasks they touched.
const onTasksChanged = (taskIds: readonly string[]): void => emitTasksChanged({ taskIds })

setTagsRouterDeps({
  onTasksChanged,
  onTagsChanged: () => emitTasksChanged({ taskIds: [], parts: ['tags'] })
})

// `task.startMainAgent` resolves a multi-repo project's child repos the way the
// `worktrees.detectChildRepos` procedure does — same discovery, same workspace fs —
// addressed by the task, so it runs on the computer the task's agent runs on.
setMainAgentDeps({
  detectChildRepos: async (target, projectPath) => {
    const { fs, resolveComputer } = getWorkspaceDeps()
    return detectChildRepos(fs, await resolveComputer(target), projectPath)
  }
})

setArtifactsRouterDeps({ onTasksChanged })

// The `app.*` routers that moved out of api read `AppDeps` (built from their types)
// through these seams. Each getter reads the registry on every call: unset, it throws
// exactly as `getAppDeps()` did inside the router.
setHostCapabilitiesDeps({ getHost: () => getAppDeps() })
setUsageRouterDeps({ getHost: () => getAppDeps() })
setAgentPanelsRouterDeps({ getHost: () => getAppDeps() })

// `app.leaderboard` and `usageAnalytics` sum over the caller's projects only (T-17):
// api's owner gate.
setUsageAnalyticsRouterDeps({ ownedProjectIds })
// `task.search` searches the caller's projects only, so its limit counts theirs.
setTaskSearchScope((ctx) => ownedProjectIds(ctx as Parameters<typeof ownedProjectIds>[0]))

// Who may manage a computer (T-19): api's `computer-access.ts` over the owner gate's
// request, plus the caller's role, decided once per call (once per subscription for
// `onStatusChange`).
setComputersRouterDeps({
  managerAccessFor: (ctx) => {
    const req = { ...accessRequestOf(ctx), role: ctx.principal?.role ?? null }
    return {
      enforcing: req.authRequired,
      mayManage: (computerId) => mayManageComputer(ctx.db, req, computerId),
      filterManaged: (rows) => filterManagedComputers(ctx.db, req, rows)
    }
  }
})

// `app.exportImport`: export/import for one request. Imported projects belong to its
// user — null on a hub without login, where requests carry none — and `exportAll`
// holds only what its access scope allows (O-22: the caller's own content on a hub
// with login).
setExportImportOpsFactory((ctx, isTest) =>
  buildExportImportOps(
    ctx.db,
    {
      userId: ctx.principal?.userId ?? null,
      scope: createAccessScope(ctx.db, accessRequestOf(ctx))
    },
    isTest
  )
)
