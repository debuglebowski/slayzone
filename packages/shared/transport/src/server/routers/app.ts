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
    getRendererZoomFactor: publicProcedure.query(() => getAppDeps().appGetRendererZoomFactor()),
    getProtocolClientStatus: publicProcedure.query(() => getAppDeps().appGetProtocolClientStatus()),
    checkCliInstalled: publicProcedure.query(() => getAppDeps().appCheckCliInstalled()),
    installCli: publicProcedure.mutation(() => getAppDeps().appInstallCli()),
    adjustZoom: publicProcedure
      .input(z.object({ command: z.enum(['in', 'out', 'reset']) }))
      .mutation(({ input }) => getAppDeps().appAdjustZoom(input.command)),
    restartForUpdate: publicProcedure.mutation(() => getAppDeps().appRestartForUpdate()),
    checkForUpdates: publicProcedure.mutation(() => getAppDeps().appCheckForUpdates()),
  }),

  // Window
  window: router({
    getContentBounds: publicProcedure.query(() => getAppDeps().appWindowGetContentBounds()),
    getDisplayScaleFactor: publicProcedure.query(() => getAppDeps().appWindowGetDisplayScaleFactor()),
  }),

  // Auth
  auth: router({
    githubSystemSignIn: publicProcedure.input(anyInput).mutation(({ input }) =>
      getAppDeps().authGithubSystemSignIn(input as never),
    ),
  }),

  // Browser view ops
  browser: router({
    createView: publicProcedure.input(anyInput).mutation(({ input }) =>
      getAppDeps().browser.createView(input),
    ),
    destroyView: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.destroyView(input.viewId),
    ),
    destroyAllForTask: publicProcedure.input(z.object({ taskId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.destroyAllForTask(input.taskId),
    ),
    setBounds: publicProcedure.input(z.object({ viewId: z.string(), bounds: anyInput })).mutation(({ input }) =>
      getAppDeps().browser.setBounds(input.viewId, input.bounds),
    ),
    setVisible: publicProcedure.input(z.object({ viewId: z.string(), visible: z.boolean() })).mutation(({ input }) =>
      getAppDeps().browser.setVisible(input.viewId, input.visible),
    ),
    hideAll: publicProcedure.mutation(() => getAppDeps().browser.hideAll()),
    showAll: publicProcedure.mutation(() => getAppDeps().browser.showAll()),
    setHandoffPolicy: publicProcedure.input(z.object({ viewId: z.string(), policy: anyInput })).mutation(({ input }) =>
      getAppDeps().browser.setHandoffPolicy(input.viewId, input.policy),
    ),
    navigate: publicProcedure.input(z.object({ viewId: z.string(), url: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.navigate(input.viewId, input.url),
    ),
    goBack: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.goBack(input.viewId),
    ),
    goForward: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.goForward(input.viewId),
    ),
    reload: publicProcedure
      .input(z.object({ viewId: z.string(), ignoreCache: z.boolean().optional() }))
      .mutation(({ input }) => getAppDeps().browser.reload(input.viewId, input.ignoreCache)),
    stop: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.stop(input.viewId),
    ),
    executeJs: publicProcedure.input(z.object({ viewId: z.string(), code: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.executeJs(input.viewId, input.code),
    ),
    insertCss: publicProcedure.input(z.object({ viewId: z.string(), css: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.insertCss(input.viewId, input.css),
    ),
    removeCss: publicProcedure.input(z.object({ viewId: z.string(), key: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.removeCss(input.viewId, input.key),
    ),
    setZoom: publicProcedure.input(z.object({ viewId: z.string(), factor: z.number() })).mutation(({ input }) =>
      getAppDeps().browser.setZoom(input.viewId, input.factor),
    ),
    focus: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.focus(input.viewId),
    ),
    findInPage: publicProcedure
      .input(z.object({ viewId: z.string(), text: z.string(), options: anyInput.optional() }))
      .mutation(({ input }) => getAppDeps().browser.findInPage(input.viewId, input.text, input.options)),
    stopFindInPage: publicProcedure
      .input(z.object({ viewId: z.string(), action: z.enum(['clearSelection', 'keepSelection', 'activateSelection']) }))
      .mutation(({ input }) => getAppDeps().browser.stopFindInPage(input.viewId, input.action)),
    setKeyboardPassthrough: publicProcedure.input(z.object({ viewId: z.string(), enabled: z.boolean() })).mutation(({ input }) =>
      getAppDeps().browser.setKeyboardPassthrough(input.viewId, input.enabled),
    ),
    sendInputEvent: publicProcedure.input(z.object({ viewId: z.string(), input: anyInput })).mutation(({ input }) =>
      getAppDeps().browser.sendInputEvent(input.viewId, input.input),
    ),
    openDevTools: publicProcedure
      .input(z.object({ viewId: z.string(), mode: z.enum(['bottom', 'right', 'undocked', 'detach']) }))
      .mutation(({ input }) => getAppDeps().browser.openDevTools(input.viewId, input.mode)),
    closeDevTools: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.closeDevTools(input.viewId),
    ),
    isDevToolsOpen: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.isDevToolsOpen(input.viewId),
    ),
    getUrl: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getUrl(input.viewId),
    ),
    getBounds: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getBounds(input.viewId),
    ),
    getZoomFactor: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getZoomFactor(input.viewId),
    ),
    getActualNativeBounds: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getActualNativeBounds(input.viewId),
    ),
    getViewVisible: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getViewVisible(input.viewId),
    ),
    getViewsForTask: publicProcedure.input(z.object({ taskId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getViewsForTask(input.taskId),
    ),
    getAllViewIds: publicProcedure.query(() => getAppDeps().browser.getAllViewIds()),
    listViews: publicProcedure.query(() => getAppDeps().browser.listViews()),
    getNativeChildViewCount: publicProcedure.query(() => getAppDeps().browser.getNativeChildViewCount()),
    isAllHidden: publicProcedure.query(() => getAppDeps().browser.isAllHidden()),
    isFocused: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.isFocused(input.viewId),
    ),
    isViewNativelyVisible: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.isViewNativelyVisible(input.viewId),
    ),
    getPartition: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getPartition(input.viewId),
    ),
    getWebContentsId: publicProcedure.input(z.object({ viewId: z.string() })).query(({ input }) =>
      getAppDeps().browser.getWebContentsId(input.viewId),
    ),
    activateExtension: publicProcedure.input(z.object({ extensionId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.activateExtension(input.extensionId),
    ),
    getExtensions: publicProcedure.query(() => getAppDeps().browser.getExtensions()),
    loadExtension: publicProcedure.mutation(() => getAppDeps().browser.loadExtension()),
    removeExtension: publicProcedure.input(z.object({ extensionId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.removeExtension(input.extensionId),
    ),
    discoverBrowserExtensions: publicProcedure.query(() => getAppDeps().browser.discoverBrowserExtensions()),
    importExtension: publicProcedure.input(z.object({ extPath: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.importExtension(input.extPath),
    ),
    reparentToCurrentWindow: publicProcedure.input(z.object({ viewId: z.string() })).mutation(({ input }) =>
      getAppDeps().browser.reparentToCurrentWindow(input.viewId),
    ),
  }),

  // Webview ops
  webview: router({
    registerBrowserTab: publicProcedure
      .input(z.object({ taskId: z.string(), tabId: z.string(), webContentsId: z.number() }))
      .mutation(({ input }) => getAppDeps().webview.registerBrowserTab(input.taskId, input.tabId, input.webContentsId)),
    unregisterBrowserTab: publicProcedure
      .input(z.object({ taskId: z.string(), tabId: z.string() }))
      .mutation(({ input }) => getAppDeps().webview.unregisterBrowserTab(input.taskId, input.tabId)),
    setActiveBrowserTab: publicProcedure
      .input(z.object({ taskId: z.string(), tabId: z.string().nullable() }))
      .mutation(({ input }) => getAppDeps().webview.setActiveBrowserTab(input.taskId, input.tabId)),
    registerShortcuts: publicProcedure.input(z.object({ webviewId: z.number() })).mutation(({ input }) =>
      getAppDeps().webview.registerShortcuts(input.webviewId),
    ),
    setKeyboardPassthrough: publicProcedure
      .input(z.object({ webviewId: z.number(), enabled: z.boolean() }))
      .mutation(({ input }) => getAppDeps().webview.setKeyboardPassthrough(input.webviewId, input.enabled)),
    setDesktopHandoffPolicy: publicProcedure.input(z.object({ webviewId: z.number(), policy: anyInput })).mutation(({ input }) =>
      getAppDeps().webview.setDesktopHandoffPolicy(input.webviewId, input.policy),
    ),
    openDevToolsBottom: publicProcedure.input(z.object({ webviewId: z.number(), options: anyInput.optional() })).mutation(({ input }) =>
      getAppDeps().webview.openDevToolsBottom(input.webviewId, input.options as { probe?: boolean } | undefined),
    ),
    openDevToolsDetached: publicProcedure.input(z.object({ webviewId: z.number() })).mutation(({ input }) =>
      getAppDeps().webview.openDevToolsDetached(input.webviewId),
    ),
    closeDevTools: publicProcedure.input(z.object({ webviewId: z.number() })).mutation(({ input }) =>
      getAppDeps().webview.closeDevTools(input.webviewId),
    ),
    isDevToolsOpened: publicProcedure.input(z.object({ webviewId: z.number() })).query(({ input }) =>
      getAppDeps().webview.isDevToolsOpened(input.webviewId),
    ),
    disableDeviceEmulation: publicProcedure.input(z.object({ webviewId: z.number() })).mutation(({ input }) =>
      getAppDeps().webview.disableDeviceEmulation(input.webviewId),
    ),
  }),
})
