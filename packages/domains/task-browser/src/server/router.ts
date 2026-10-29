// The `app.browser` (view manager) and `app.webview` (webview registry) routers. Each
// delegates to the host through the seam in `./router-deps`. `@slayzone/api` mounts
// them at `app.browser` / `app.webview`.
import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import type { BrowserShortcutPayload, BrowserCreateTaskFromLinkIntent } from '../shared'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getTaskBrowserHost } from './router-deps'

const anyInput = z.unknown()

// Browser view ops — delegate to the BrowserViewManager singleton (same
// instance backing the still-live `browser:*` IPC handlers; coexistence
// until the renderer drops IPC in slice 5).
export const appBrowserRouter = router({
  createView: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => getTaskBrowserHost().browser.createView(input)),
  destroyView: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.destroyView(input.viewId)),
  destroyAllForTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.destroyAllForTask(input.taskId)),
  setBounds: publicProcedure
    .input(z.object({ viewId: z.string(), bounds: anyInput }))
    .mutation(({ input }) => getTaskBrowserHost().browser.setBounds(input.viewId, input.bounds)),
  setVisible: publicProcedure
    .input(z.object({ viewId: z.string(), visible: z.boolean() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.setVisible(input.viewId, input.visible)),
  setLocked: publicProcedure
    .input(z.object({ viewId: z.string(), locked: z.boolean() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.setLocked(input.viewId, input.locked)),
  hideAll: publicProcedure.mutation(() => getTaskBrowserHost().browser.hideAll()),
  showAll: publicProcedure.mutation(() => getTaskBrowserHost().browser.showAll()),
  setHandoffPolicy: publicProcedure
    .input(z.object({ viewId: z.string(), policy: anyInput }))
    .mutation(({ input }) =>
      getTaskBrowserHost().browser.setHandoffPolicy(input.viewId, input.policy)
    ),
  navigate: publicProcedure
    .input(z.object({ viewId: z.string(), url: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.navigate(input.viewId, input.url)),
  goBack: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.goBack(input.viewId)),
  goForward: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.goForward(input.viewId)),
  reload: publicProcedure
    .input(z.object({ viewId: z.string(), ignoreCache: z.boolean().optional() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.reload(input.viewId, input.ignoreCache)),
  stop: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.stop(input.viewId)),
  executeJs: publicProcedure
    .input(z.object({ viewId: z.string(), code: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.executeJs(input.viewId, input.code)),
  insertCss: publicProcedure
    .input(z.object({ viewId: z.string(), css: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.insertCss(input.viewId, input.css)),
  removeCss: publicProcedure
    .input(z.object({ viewId: z.string(), key: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.removeCss(input.viewId, input.key)),
  setForcedTheme: publicProcedure
    .input(z.object({ viewId: z.string(), theme: z.enum(['light', 'dark']).nullable() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().browser.setForcedTheme(input.viewId, input.theme)
    ),
  setZoom: publicProcedure
    .input(z.object({ viewId: z.string(), factor: z.number() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.setZoom(input.viewId, input.factor)),
  focus: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.focus(input.viewId)),
  findInPage: publicProcedure
    .input(z.object({ viewId: z.string(), text: z.string(), options: anyInput.optional() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().browser.findInPage(input.viewId, input.text, input.options)
    ),
  stopFindInPage: publicProcedure
    .input(
      z.object({
        viewId: z.string(),
        action: z.enum(['clearSelection', 'keepSelection', 'activateSelection'])
      })
    )
    .mutation(({ input }) =>
      getTaskBrowserHost().browser.stopFindInPage(input.viewId, input.action)
    ),
  setKeyboardPassthrough: publicProcedure
    .input(z.object({ viewId: z.string(), enabled: z.boolean() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().browser.setKeyboardPassthrough(input.viewId, input.enabled)
    ),
  sendInputEvent: publicProcedure
    .input(z.object({ viewId: z.string(), input: anyInput }))
    .mutation(({ input }) =>
      getTaskBrowserHost().browser.sendInputEvent(input.viewId, input.input)
    ),
  openDevTools: publicProcedure
    .input(
      z.object({ viewId: z.string(), mode: z.enum(['bottom', 'right', 'undocked', 'detach']) })
    )
    .mutation(({ input }) => getTaskBrowserHost().browser.openDevTools(input.viewId, input.mode)),
  closeDevTools: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.closeDevTools(input.viewId)),
  isDevToolsOpen: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.isDevToolsOpen(input.viewId)),
  getUrl: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getUrl(input.viewId)),
  getBounds: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getBounds(input.viewId)),
  getZoomFactor: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getZoomFactor(input.viewId)),
  getActualNativeBounds: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getActualNativeBounds(input.viewId)),
  getViewVisible: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getViewVisible(input.viewId)),
  getViewsForTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getViewsForTask(input.taskId)),
  getAllViewIds: publicProcedure.query(() => getTaskBrowserHost().browser.getAllViewIds()),
  listViews: publicProcedure.query(() => getTaskBrowserHost().browser.listViews()),
  getNativeChildViewCount: publicProcedure.query(() =>
    getTaskBrowserHost().browser.getNativeChildViewCount()
  ),
  isAllHidden: publicProcedure.query(() => getTaskBrowserHost().browser.isAllHidden()),
  isFocused: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.isFocused(input.viewId)),
  isViewNativelyVisible: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.isViewNativelyVisible(input.viewId)),
  getPartition: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getPartition(input.viewId)),
  getWebContentsId: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .query(({ input }) => getTaskBrowserHost().browser.getWebContentsId(input.viewId)),
  activateExtension: publicProcedure
    .input(z.object({ extensionId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.activateExtension(input.extensionId)),
  getExtensions: publicProcedure.query(() => getTaskBrowserHost().browser.getExtensions()),
  loadExtension: publicProcedure.mutation(() => getTaskBrowserHost().browser.loadExtension()),
  removeExtension: publicProcedure
    .input(z.object({ extensionId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.removeExtension(input.extensionId)),
  discoverBrowserExtensions: publicProcedure.query(() =>
    getTaskBrowserHost().browser.discoverBrowserExtensions()
  ),
  importExtension: publicProcedure
    .input(z.object({ extPath: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.importExtension(input.extPath)),
  reparentToCurrentWindow: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getTaskBrowserHost().browser.reparentToCurrentWindow(input.viewId)),
  onEvent: publicProcedure.subscription(() =>
    observable<unknown>((emit) => {
      const browser = getTaskBrowserHost().browser
      const h = (e: unknown): void => emit.next(e)
      browser.events.on('event', h)
      // Replay per-view nav-state snapshots so a subscriber attaching after
      // createView's loadURL (the WS round-trip race) doesn't miss
      // did-navigate/dom-ready and strand the loading overlay. Listener is
      // attached first; both run in one sync block, so nothing interleaves.
      for (const s of browser.getAllStateSnapshots()) emit.next(s)
      return () => browser.events.off('event', h)
    })
  ),
  onShortcut: publicProcedure.subscription(() =>
    observable<BrowserShortcutPayload>((emit) => {
      const h = (p: BrowserShortcutPayload): void => emit.next(p)
      const ev = getTaskBrowserHost().browser.events
      ev.on('shortcut', h)
      return () => ev.off('shortcut', h)
    })
  ),
  onFocused: publicProcedure.subscription(() =>
    observable<{ viewId: string }>((emit) => {
      const h = (p: { viewId: string }): void => emit.next(p)
      const ev = getTaskBrowserHost().browser.events
      ev.on('focused', h)
      return () => ev.off('focused', h)
    })
  ),
  onCreateTaskFromLink: publicProcedure.subscription(() =>
    observable<BrowserCreateTaskFromLinkIntent>((emit) => {
      const h = (i: BrowserCreateTaskFromLinkIntent): void => emit.next(i)
      const ev = getTaskBrowserHost().browser.events
      ev.on('create-task-from-link', h)
      return () => ev.off('create-task-from-link', h)
    })
  )
})

export type AppBrowserRouter = typeof appBrowserRouter
/** Where `@slayzone/api` mounts it: `app.browser`. */
export type AppBrowserMounts = { app: { browser: AppBrowserRouter } }

// Webview — CLI browser-tab registry (P19i; grown with devtools/shortcuts in
// P19k/P19m). Same impls back the `webview:*` IPC handlers (slice 5 cutover).
export const appWebviewRouter = router({
  registerBrowserTab: publicProcedure
    .input(z.object({ taskId: z.string(), tabId: z.string(), webContentsId: z.number() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().webview.registerBrowserTab(
        input.taskId,
        input.tabId,
        input.webContentsId
      )
    ),
  unregisterBrowserTab: publicProcedure
    .input(z.object({ taskId: z.string(), tabId: z.string() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().webview.unregisterBrowserTab(input.taskId, input.tabId)
    ),
  setActiveBrowserTab: publicProcedure
    .input(z.object({ taskId: z.string(), tabId: z.string().nullable() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().webview.setActiveBrowserTab(input.taskId, input.tabId)
    ),
  closeDevTools: publicProcedure
    .input(z.object({ webviewId: z.number() }))
    .mutation(({ input }) => getTaskBrowserHost().webview.closeDevTools(input.webviewId)),
  isDevToolsOpened: publicProcedure
    .input(z.object({ webviewId: z.number() }))
    .query(({ input }) => getTaskBrowserHost().webview.isDevToolsOpened(input.webviewId)),
  disableDeviceEmulation: publicProcedure
    .input(z.object({ webviewId: z.number() }))
    .mutation(({ input }) => getTaskBrowserHost().webview.disableDeviceEmulation(input.webviewId)),
  registerShortcuts: publicProcedure
    .input(z.object({ webviewId: z.number() }))
    .mutation(({ input }) => getTaskBrowserHost().webview.registerShortcuts(input.webviewId)),
  setKeyboardPassthrough: publicProcedure
    .input(z.object({ webviewId: z.number(), enabled: z.boolean() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().webview.setKeyboardPassthrough(input.webviewId, input.enabled)
    ),
  setDesktopHandoffPolicy: publicProcedure
    .input(z.object({ webviewId: z.number(), policy: anyInput }))
    .mutation(({ input }) =>
      getTaskBrowserHost().webview.setDesktopHandoffPolicy(input.webviewId, input.policy)
    ),
  openDevToolsBottom: publicProcedure
    .input(z.object({ webviewId: z.number(), options: anyInput.optional() }))
    .mutation(({ input }) =>
      getTaskBrowserHost().webview.openDevToolsBottom(
        input.webviewId,
        input.options as { probe?: boolean } | undefined
      )
    ),
  openDevToolsDetached: publicProcedure
    .input(z.object({ webviewId: z.number() }))
    .mutation(({ input }) => getTaskBrowserHost().webview.openDevToolsDetached(input.webviewId)),
  enableDeviceEmulation: publicProcedure
    .input(z.object({ webviewId: z.number(), params: anyInput }))
    .mutation(({ input }) =>
      getTaskBrowserHost().webview.enableDeviceEmulation(input.webviewId, input.params as never)
    ),
  onShortcut: publicProcedure.subscription(() =>
    observable<{ webviewId: number; key: string; shift: boolean }>((emit) => {
      const handler = (payload: { webviewId: number; key: string; shift: boolean }): void =>
        emit.next(payload)
      const ev = getTaskBrowserHost().webview.events
      ev.on('shortcut', handler)
      return () => ev.off('shortcut', handler)
    })
  )
})

export type AppWebviewRouter = typeof appWebviewRouter
/** Where `@slayzone/api` mounts it: `app.webview`. */
export type AppWebviewMounts = { app: { webview: AppWebviewRouter } }
