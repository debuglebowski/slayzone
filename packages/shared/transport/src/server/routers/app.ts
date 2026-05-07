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

  // Files
  files: router({
    pathExists: publicProcedure.input(z.object({ filePath: z.string() })).query(({ input }) =>
      getAppDeps().filesPathExists(input.filePath),
    ),
    saveTempImage: publicProcedure
      .input(z.object({ base64: z.string(), mimeType: z.string() }))
      .mutation(({ input }) => getAppDeps().filesSaveTempImage(input.base64, input.mimeType)),
  }),

  // Shell
  shell: router({
    openExternal: publicProcedure.input(anyInput).mutation(({ input }) => {
      const i = input as { url: string; options?: { blockDesktopHandoff?: boolean; desktopHandoff?: { protocol?: string; hostScope?: string } } }
      return getAppDeps().shellOpenExternal(i.url, i.options)
    }),
    openPath: publicProcedure.input(z.object({ absPath: z.string() })).mutation(({ input }) =>
      getAppDeps().shellOpenPath(input.absPath),
    ),
  }),

  // db:feedback
  feedback: router({
    listThreads: publicProcedure.query(() => getAppDeps().feedbackListThreads()),
    createThread: publicProcedure.input(anyInput).mutation(({ input }) =>
      getAppDeps().feedbackCreateThread(input as never),
    ),
    getMessages: publicProcedure.input(z.object({ threadId: z.string() })).query(({ input }) =>
      getAppDeps().feedbackGetMessages(input.threadId),
    ),
    addMessage: publicProcedure.input(anyInput).mutation(({ input }) =>
      getAppDeps().feedbackAddMessage(input as never),
    ),
    updateThreadDiscordId: publicProcedure
      .input(z.object({ threadId: z.string(), discordThreadId: z.string() }))
      .mutation(({ input }) => getAppDeps().feedbackUpdateThreadDiscordId(input.threadId, input.discordThreadId)),
    deleteThread: publicProcedure.input(z.object({ threadId: z.string() })).mutation(({ input }) =>
      getAppDeps().feedbackDeleteThread(input.threadId),
    ),
  }),

  // App metadata
  meta: router({
    getVersion: publicProcedure.query(() => getAppDeps().appGetVersion()),
    getTrpcPort: publicProcedure.query(() => getAppDeps().appGetTrpcPort()),
    isTestsPanelEnabled: publicProcedure.query(() => getAppDeps().appIsTestsPanelEnabled()),
    isJiraIntegrationEnabled: publicProcedure.query(() => getAppDeps().appIsJiraIntegrationEnabled()),
    isLoopModeEnabled: publicProcedure.query(() => getAppDeps().appIsLoopModeEnabled()),
    getZoomFactor: publicProcedure.query(() => getAppDeps().appGetZoomFactor()),
    checkCliInstalled: publicProcedure.query(() => getAppDeps().appCheckCliInstalled()),
    installCli: publicProcedure.mutation(() => getAppDeps().appInstallCli()),
  }),
})
