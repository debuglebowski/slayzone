// The `app.*` routers over host (main-process) capabilities: each delegates to the
// host through the seam in `./host` (api's `AppDeps`, wired at load). `@slayzone/api`
// mounts them under `app` (`api/src/routers/app.ts`) at the same keys as before they
// moved, so every wire path (`app.meta.getVersion`, …) and every policy key is
// unchanged. A domain's client types against the `App*Mounts` it calls.
import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { assertHubIntegrationsEnabled } from '@slayzone/platform/hub-switch-refusal'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getAuthEvents, getHost } from './host'
import { hubGithubSignInConvexUrl } from './github-sign-in-url'

const anyInput = z.unknown()

// Clipboard
export const appClipboardRouter = router({
  writeFilePaths: publicProcedure
    .input(z.object({ paths: z.array(z.string()) }))
    .mutation(({ input }) => getHost().clipboardWriteFilePaths(input.paths)),
  readFilePaths: publicProcedure.query(() => getHost().clipboardReadFilePaths()),
  hasFiles: publicProcedure.query(() => getHost().clipboardHasFiles())
})

export type AppClipboardRouter = typeof appClipboardRouter
/** Where `@slayzone/api` mounts it: `app.clipboard`. */
export type AppClipboardMounts = { app: { clipboard: AppClipboardRouter } }

// Screenshot
export const appScreenshotRouter = router({
  captureView: publicProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(({ input }) => getHost().screenshotCaptureView(input.viewId))
})

export type AppScreenshotRouter = typeof appScreenshotRouter
/** Where `@slayzone/api` mounts it: `app.screenshot`. */
export type AppScreenshotMounts = { app: { screenshot: AppScreenshotRouter } }

// Files
export const appFilesRouter = router({
  pathExists: publicProcedure
    .input(z.object({ filePath: z.string() }))
    .query(({ input }) => getHost().filesPathExists(input.filePath)),
  saveTempImage: publicProcedure
    .input(z.object({ base64: z.string(), mimeType: z.string() }))
    .mutation(({ input }) => getHost().filesSaveTempImage(input.base64, input.mimeType))
})

export type AppFilesRouter = typeof appFilesRouter
/** Where `@slayzone/api` mounts it: `app.files`. */
export type AppFilesMounts = { app: { files: AppFilesRouter } }

// Shell
export const appShellRouter = router({
  openExternal: publicProcedure.input(anyInput).mutation(({ input }) => {
    const i = input as {
      url: string
      options?: {
        blockDesktopHandoff?: boolean
        desktopHandoff?: { protocol?: string; hostScope?: string }
      }
    }
    return getHost().shellOpenExternal(i.url, i.options)
  }),
  openPath: publicProcedure
    .input(z.object({ absPath: z.string() }))
    .mutation(({ input }) => getHost().shellOpenPath(input.absPath))
})

export type AppShellRouter = typeof appShellRouter
/** Where `@slayzone/api` mounts it: `app.shell`. */
export type AppShellMounts = { app: { shell: AppShellRouter } }

// App metadata
export const appMetaRouter = router({
  getVersion: publicProcedure.query(() => getHost().appGetVersion()),
  getTrpcPort: publicProcedure.query(() => getHost().appGetTrpcPort()),
  isTestsPanelEnabled: publicProcedure.query(() => getHost().appIsTestsPanelEnabled()),
  setLabFlag: publicProcedure
    .input(z.object({ key: z.enum(['labs_tests_panel', 'labs_loop_mode']), on: z.boolean() }))
    .mutation(({ input }) => getHost().appSetLabFlag(input.key, input.on)),
  isLoopModeEnabled: publicProcedure.query(() => getHost().appIsLoopModeEnabled()),
  getZoomFactor: publicProcedure.query(() => getHost().appGetZoomFactor()),
  getProtocolClientStatus: publicProcedure.query(() => getHost().appGetProtocolClientStatus()),
  getRendererZoomFactor: publicProcedure.query(() => getHost().appGetRendererZoomFactor()),
  checkCliInstalled: publicProcedure.query(() => getHost().appCheckCliInstalled()),
  installCli: publicProcedure.mutation(() => getHost().appInstallCli()),
  adjustZoom: publicProcedure
    .input(z.object({ command: z.enum(['in', 'out', 'reset']) }))
    .mutation(({ input }) => getHost().appAdjustZoom(input.command)),
  restartForUpdate: publicProcedure.mutation(() => getHost().appRestartForUpdate()),
  checkForUpdates: publicProcedure.mutation(() => getHost().appCheckForUpdates()),
  // Dark-launch side-car supervisor status (Diagnostics settings tab).
  getSidecarStatus: publicProcedure.query(() => getHost().appGetSidecarStatus()),
  revealSidecarLog: publicProcedure.mutation(() => getHost().appRevealSidecarLog())
})

export type AppMetaRouter = typeof appMetaRouter
/** Where `@slayzone/api` mounts it: `app.meta`. */
export type AppMetaMounts = { app: { meta: AppMetaRouter } }

// Window
export const appWindowRouter = router({
  getContentBounds: publicProcedure.query(() => getHost().appWindowGetContentBounds()),
  getDisplayScaleFactor: publicProcedure.query(() => getHost().appWindowGetDisplayScaleFactor()),
  close: publicProcedure.mutation(({ ctx }) => {
    if (ctx.windowId == null) throw new Error('windowId required')
    return getHost().windowClose(ctx.windowId)
  }),
  // Cosmetic, fire-and-forget — no windowId guard (graceful no-op if the
  // window can't be resolved) so the renderer's useEffect calls never reject.
  setTrafficLightPosition: publicProcedure
    .input(z.object({ pos: z.object({ x: z.number(), y: z.number() }).nullable() }))
    .mutation(({ ctx, input }) =>
      getHost().appWindowSetTrafficLightPosition(ctx.windowId ?? null, input.pos)
    ),
  setWindowButtonVisibility: publicProcedure
    .input(z.object({ visible: z.boolean() }))
    .mutation(({ ctx, input }) =>
      getHost().appWindowSetWindowButtonVisibility(ctx.windowId ?? null, input.visible)
    ),
  // Pull OS keyboard focus back to this connection's renderer (browser find).
  // Fire-and-forget, no windowId guard (graceful no-op if unresolved) so the
  // renderer's focus calls never reject. Was the `app:focus-renderer` IPC.
  focusRenderer: publicProcedure.mutation(({ ctx }) =>
    getHost().appFocusRenderer(ctx.windowId ?? null)
  )
})

export type AppWindowRouter = typeof appWindowRouter
/** Where `@slayzone/api` mounts it: `app.window`. */
export type AppWindowMounts = { app: { window: AppWindowRouter } }

// Shortcuts — rebuild the native menu after the renderer persists custom
// shortcut overrides. Was the `shortcuts:changed` IPC (preload bootstrap-only).
export const appShortcutsRouter = router({
  changed: publicProcedure.mutation(() => getHost().appRebuildMenuForShortcuts())
})

export type AppShortcutsRouter = typeof appShortcutsRouter
/** Where `@slayzone/api` mounts it: `app.shortcuts`. */
export type AppShortcutsMounts = { app: { shortcuts: AppShortcutsRouter } }

// Auth
export const appAuthRouter = router({
  // Refused with integrations switched off: the hub would POST to Convex and open
  // GitHub's authorize page itself.
  githubSystemSignIn: publicProcedure.input(anyInput).mutation(({ input }) => {
    assertHubIntegrationsEnabled({ op: 'sign_in', detail: { provider: 'github' } })
    // T-99: the host POSTs only to THIS hub's Convex deployment. A client `convexUrl`
    // naming another host (or a hub with none configured) is refused here, before the
    // host is asked; what the host gets is the hub's own value, never the client's.
    const req = typeof input === 'object' && input !== null ? input : {}
    const convexUrl = hubGithubSignInConvexUrl((req as { convexUrl?: unknown }).convexUrl)
    return getHost().authGithubSystemSignIn({ ...req, convexUrl } as never)
  }),
  // Chromium-fork OAuth callback relay. The C++ shell forwards the
  // `slayzone://auth/callback` deep-link to the sidecar (auth:deep-link), the
  // sidecar's socket server emits it on `authEvents`, and this subscription
  // pushes the {code,error} to the renderer's ConvexAuthBridge — which then
  // completes the Convex sign-in (the renderer owns the Convex session). The
  // Electron renderer uses the inline-mutation path and never subscribes here.
  onCallback: publicProcedure.subscription(() =>
    observable<{ code?: string; error?: string }>((emit) => {
      const handler = (payload: { code?: string; error?: string }): void => emit.next(payload)
      const ev = getAuthEvents()
      ev.on('callback', handler)
      return () => ev.off('callback', handler)
    })
  )
})

export type AppAuthRouter = typeof appAuthRouter
/** Where `@slayzone/api` mounts it: `app.auth`. */
export type AppAuthMounts = { app: { auth: AppAuthRouter } }

// Dialog (native file picker — same impl backs the dialog:showOpenDialog IPC)
export const appDialogRouter = router({
  showOpenDialog: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => getHost().dialogShowOpenDialog(input))
})

export type AppDialogRouter = typeof appDialogRouter
/** Where `@slayzone/api` mounts it: `app.dialog`. */
export type AppDialogMounts = { app: { dialog: AppDialogRouter } }

// Task windows + panel ownership — window-scoped via ctx.windowId (parsed from
// the WS ?windowId=N query). Same ops back the `task-window:*` / `panels:*`
// IPC handlers (coexistence until slice 5). Procedures that mutate per-window
// ownership require ctx.windowId; null connections (CLI) cannot call them.
export const appTaskWindowsRouter = router({
  open: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ input }) => getHost().taskWindows.open(input.taskId)),
  close: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ input }) => getHost().taskWindows.close(input.taskId)),
  list: publicProcedure.query(() => getHost().taskWindows.list()),
  setPrimaryActive: publicProcedure
    .input(z.object({ taskId: z.string().nullable() }))
    .mutation(({ ctx, input }) =>
      getHost().taskWindows.setPrimaryActive(input.taskId, ctx.windowId ?? null)
    ),
  getPrimaryActive: publicProcedure.query(() => getHost().taskWindows.getPrimaryActive()),
  claimPanel: publicProcedure
    .input(z.object({ taskId: z.string(), panelId: z.string() }))
    .mutation(({ ctx, input }) => {
      if (ctx.windowId == null) throw new Error('windowId required')
      return getHost().taskWindows.claimPanel(input.taskId, input.panelId, ctx.windowId)
    }),
  releasePanel: publicProcedure
    .input(z.object({ taskId: z.string(), panelId: z.string() }))
    .mutation(({ ctx, input }) => {
      if (ctx.windowId == null) throw new Error('windowId required')
      return getHost().taskWindows.releasePanel(input.taskId, input.panelId, ctx.windowId)
    }),
  releaseAllForTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ ctx, input }) => {
      if (ctx.windowId == null) throw new Error('windowId required')
      return getHost().taskWindows.releaseAllForTask(input.taskId, ctx.windowId)
    }),
  getOwnership: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ input }) => getHost().taskWindows.getOwnership(input.taskId)),
  getWindowId: publicProcedure.query(({ ctx }) =>
    ctx.windowId == null ? null : getHost().taskWindows.getWindowId(ctx.windowId)
  ),
  claimAndCloseOther: publicProcedure
    .input(z.object({ taskId: z.string(), panelId: z.string() }))
    .mutation(({ ctx, input }) => {
      if (ctx.windowId == null) throw new Error('windowId required')
      return getHost().taskWindows.claimAndCloseOther(input.taskId, input.panelId, ctx.windowId)
    }),
  claimSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ ctx, input }) => {
      if (ctx.windowId == null) throw new Error('windowId required')
      return getHost().taskWindows.claimSession(input.sessionId, ctx.windowId)
    }),
  onListChanged: publicProcedure.subscription(() =>
    observable<string[]>((emit) => {
      const handler = (taskIds: string[]): void => emit.next(taskIds)
      const ev = getHost().taskWindows.events
      ev.on('list-changed', handler)
      return () => ev.off('list-changed', handler)
    })
  ),
  onPrimaryActiveChanged: publicProcedure.subscription(() =>
    observable<string | null>((emit) => {
      const handler = (taskId: string | null): void => emit.next(taskId)
      const ev = getHost().taskWindows.events
      ev.on('primary-active-changed', handler)
      return () => ev.off('primary-active-changed', handler)
    })
  ),
  onOwnershipChanged: publicProcedure.subscription(() =>
    observable<{ taskId: string; ownership: Array<{ panelId: string; ownerWindowId: number }> }>(
      (emit) => {
        const handler = (payload: {
          taskId: string
          ownership: Array<{ panelId: string; ownerWindowId: number }>
        }): void => emit.next(payload)
        const ev = getHost().taskWindows.events
        ev.on('ownership-changed', handler)
        return () => ev.off('ownership-changed', handler)
      }
    )
  ),
  onPanelsReleasedOnClose: publicProcedure.subscription(() =>
    observable<{ closedWindowId: number; released: Array<{ taskId: string; panelId: string }> }>(
      (emit) => {
        const handler = (payload: {
          closedWindowId: number
          released: Array<{ taskId: string; panelId: string }>
        }): void => emit.next(payload)
        const ev = getHost().taskWindows.events
        ev.on('panels-released-on-close', handler)
        return () => ev.off('panels-released-on-close', handler)
      }
    )
  ),
  // Targeted: only fires for the connection whose ctx.windowId matches the
  // close-request's target window.
  onPanelCloseRequest: publicProcedure.subscription(({ ctx }) =>
    observable<{ taskId: string; panelId: string }>((emit) => {
      const handler = (
        targetWindowId: number,
        payload: { taskId: string; panelId: string }
      ): void => {
        if (ctx.windowId !== targetWindowId) return
        emit.next(payload)
      }
      const ev = getHost().taskWindows.events
      ev.on('panels-close-request', handler)
      return () => ev.off('panels-close-request', handler)
    })
  )
})

export type AppTaskWindowsRouter = typeof appTaskWindowsRouter
/** Where `@slayzone/api` mounts it: `app.taskWindows`. */
export type AppTaskWindowsMounts = { app: { taskWindows: AppTaskWindowsRouter } }
