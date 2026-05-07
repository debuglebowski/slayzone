import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { getAppDeps } from '../app-deps'

const anyInput = z.unknown()

export const appLevelRouter = router({
  // Backup
  backup: router({
    list: publicProcedure.query(() => getAppDeps().backupList()),
    create: publicProcedure.input(z.object({ name: z.string().optional() }).optional()).mutation(({ input }) =>
      getAppDeps().backupCreate(input?.name),
    ),
    rename: publicProcedure
      .input(z.object({ filename: z.string(), name: z.string() }))
      .mutation(({ input }) => getAppDeps().backupRename(input.filename, input.name)),
    delete: publicProcedure.input(z.object({ filename: z.string() })).mutation(({ input }) =>
      getAppDeps().backupDelete(input.filename),
    ),
    restore: publicProcedure.input(z.object({ filename: z.string() })).mutation(({ input }) =>
      getAppDeps().backupRestore(input.filename),
    ),
    getSettings: publicProcedure.query(() => getAppDeps().backupGetSettings()),
    setSettings: publicProcedure.input(anyInput).mutation(({ input }) =>
      getAppDeps().backupSetSettings(input as never),
    ),
    revealInFinder: publicProcedure.mutation(() => getAppDeps().backupRevealInFinder()),
  }),

  // Clipboard
  clipboard: router({
    writeFilePaths: publicProcedure.input(z.object({ paths: z.array(z.string()) })).mutation(({ input }) =>
      getAppDeps().clipboardWriteFilePaths(input.paths),
    ),
    readFilePaths: publicProcedure.query(() => getAppDeps().clipboardReadFilePaths()),
    hasFiles: publicProcedure.query(() => getAppDeps().clipboardHasFiles()),
  }),

  // Screenshot
  screenshot: router({
    captureView: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().screenshotCaptureView(input.viewId),
    ),
  }),

  // Leaderboard
  leaderboard: router({
    getLocalStats: publicProcedure.query(() => getAppDeps().leaderboardGetLocalStats()),
  }),

  // Export/Import
  exportImport: router({
    exportAll: publicProcedure.mutation(() => getAppDeps().exportAll()),
    exportProject: publicProcedure.input(z.object({ projectId: z.string() })).mutation(({ input }) =>
      getAppDeps().exportProject(input.projectId),
    ),
    import: publicProcedure.mutation(() => getAppDeps().importBundle()),
    testExportAllToPath: publicProcedure.input(z.object({ filePath: z.string() })).mutation(({ input }) => {
      const fn = getAppDeps().testExportAllToPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.filePath)
    }),
    testExportProjectToPath: publicProcedure
      .input(z.object({ projectId: z.string(), filePath: z.string() }))
      .mutation(({ input }) => {
        const fn = getAppDeps().testExportProjectToPath
        if (!fn) throw new Error('test-only handler unavailable in production')
        return fn(input.projectId, input.filePath)
      }),
    testImportFromPath: publicProcedure.input(z.object({ filePath: z.string() })).mutation(({ input }) => {
      const fn = getAppDeps().testImportFromPath
      if (!fn) throw new Error('test-only handler unavailable in production')
      return fn(input.filePath)
    }),
    testSetTaskParent: publicProcedure
      .input(z.object({ taskId: z.string(), parentId: z.string().nullable() }))
      .mutation(({ input }) => {
        const fn = getAppDeps().testSetTaskParent
        if (!fn) throw new Error('test-only handler unavailable in production')
        return fn(input.taskId, input.parentId)
      }),
  }),

  // Usage
  usage: router({
    fetch: publicProcedure.input(z.object({ force: z.boolean().optional() }).optional()).query(({ input }) =>
      getAppDeps().usageFetch(input?.force),
    ),
    test: publicProcedure.input(anyInput).mutation(({ input }) =>
      getAppDeps().usageTest(input as never),
    ),
  }),
})
