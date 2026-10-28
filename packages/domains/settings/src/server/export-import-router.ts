// The `app.exportImport` router: project export/import through the per-request
// `ExportImportOps` api builds (`./export-import-ops`). `@slayzone/api` mounts it at
// `app.exportImport`.
import { z } from 'zod'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getExportImportOps } from './export-import-ops'

/** Same gate the host used when deciding to expose the path-taking variants. */
const isTestBuild = (): boolean => process.env.PLAYWRIGHT === '1'

// Export/Import — reads and writes ctx.db. Was seven AppDeps slots, i.e. this
// process asking the Electron host to read the database this process owns. Only
// the file-picker step is genuinely host-side, and it goes back over AppDeps
// from inside api's `export-import.ts`.
//
// The `test*` variants are no longer test-only in nature — they are just the
// path-taking forms — but the gate stays so production can't be driven headless.
export const appExportImportRouter = router({
  exportAll: publicProcedure.mutation(({ ctx }) => getExportImportOps(ctx).exportAll()),
  exportProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(({ ctx, input }) => getExportImportOps(ctx).exportProject(input.projectId)),
  import: publicProcedure.mutation(({ ctx }) => getExportImportOps(ctx).importBundle()),
  testExportAllToPath: publicProcedure
    .input(z.object({ filePath: z.string() }))
    .mutation(({ ctx, input }) => {
      const fn = getExportImportOps(ctx, isTestBuild()).testExportAllToPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.filePath)
    }),
  testExportProjectToPath: publicProcedure
    .input(z.object({ projectId: z.string(), filePath: z.string() }))
    .mutation(({ ctx, input }) => {
      const fn = getExportImportOps(ctx, isTestBuild()).testExportProjectToPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.projectId, input.filePath)
    }),
  testImportFromPath: publicProcedure
    .input(z.object({ filePath: z.string() }))
    .mutation(({ ctx, input }) => {
      const fn = getExportImportOps(ctx, isTestBuild()).testImportFromPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.filePath)
    }),
  testSetTaskParent: publicProcedure
    .input(z.object({ taskId: z.string(), parentId: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      const fn = getExportImportOps(ctx, isTestBuild()).testSetTaskParent
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.taskId, input.parentId)
    })
})

export type AppExportImportRouter = typeof appExportImportRouter
/** Where `@slayzone/api` mounts it: `app.exportImport`. */
export type AppExportImportMounts = { app: { exportImport: AppExportImportRouter } }
