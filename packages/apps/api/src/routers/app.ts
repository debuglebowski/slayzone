import { z } from 'zod'
import { router, publicProcedure, type TrpcContext } from '@slayzone/trpc-server'
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
import { appBackupRouter } from '@slayzone/settings/server'
import { appLeaderboardRouter } from '@slayzone/usage-analytics/server'
import { appUsageRouter } from '@slayzone/terminal/server'
import { appFeedbackRouter } from '@slayzone/feedback/server'
import { appBrowserRouter, appWebviewRouter } from '@slayzone/task-browser/server'
import { appFloatingAgentRouter } from '@slayzone/agent-panels/server'
import { buildExportImportOps } from '../export-import'
import { createAccessScope } from '../access'
import { accessRequestOf } from '../owner-gate'

/** Same gate the host used when deciding to expose the path-taking variants. */
const isTestBuild = (): boolean => process.env.PLAYWRIGHT === '1'

// App-level router — main-process capabilities grouped by concern, mounted at `app`.
// Each sub-router lives with the package that owns it (host capabilities in
// `@slayzone/host-capabilities`, the rest in their domain), so a domain's client can
// type against just the `app.*` routers it calls (`{ app: { meta: AppMetaRouter } }`,
// asserted in `../router.ts`). The keys below ARE the wire paths
// (`app.meta.getVersion`) and the policy keys: never rename or move one, a client and
// a hub of different versions must agree. Only export/import stays in api: it needs
// api's access scope.

/** Export/import for one request. Imported projects belong to its user — null on
 *  a hub without login, where requests carry none — and `exportAll` holds only what
 *  its access scope allows (O-22: the caller's own content on a hub with login). */
const exportImportOps = (ctx: TrpcContext, isTest = false) =>
  buildExportImportOps(
    ctx.db,
    {
      userId: ctx.principal?.userId ?? null,
      scope: createAccessScope(ctx.db, accessRequestOf(ctx))
    },
    isTest
  )

// Export/Import — reads and writes ctx.db. Was seven AppDeps slots, i.e. this
// process asking the Electron host to read the database this process owns. Only
// the file-picker step is genuinely host-side, and it goes back over AppDeps
// from inside `export-import.ts`.
//
// The `test*` variants are no longer test-only in nature — they are just the
// path-taking forms — but the gate stays so production can't be driven headless.
export const appExportImportRouter = router({
  exportAll: publicProcedure.mutation(({ ctx }) => exportImportOps(ctx).exportAll()),
  exportProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(({ ctx, input }) => exportImportOps(ctx).exportProject(input.projectId)),
  import: publicProcedure.mutation(({ ctx }) => exportImportOps(ctx).importBundle()),
  testExportAllToPath: publicProcedure
    .input(z.object({ filePath: z.string() }))
    .mutation(({ ctx, input }) => {
      const fn = exportImportOps(ctx, isTestBuild()).testExportAllToPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.filePath)
    }),
  testExportProjectToPath: publicProcedure
    .input(z.object({ projectId: z.string(), filePath: z.string() }))
    .mutation(({ ctx, input }) => {
      const fn = exportImportOps(ctx, isTestBuild()).testExportProjectToPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.projectId, input.filePath)
    }),
  testImportFromPath: publicProcedure
    .input(z.object({ filePath: z.string() }))
    .mutation(({ ctx, input }) => {
      const fn = exportImportOps(ctx, isTestBuild()).testImportFromPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.filePath)
    }),
  testSetTaskParent: publicProcedure
    .input(z.object({ taskId: z.string(), parentId: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      const fn = exportImportOps(ctx, isTestBuild()).testSetTaskParent
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.taskId, input.parentId)
    })
})

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
