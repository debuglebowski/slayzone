import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { router, publicProcedure } from '@slayzone/trpc-server'
import type { UpdateStatus } from '@slayzone/platform/client-host'
import { getMenuEvents, type HubMenuEventMap } from './menu-events'

/**
 * Task and browser requests a HUB raises for the clients signed in to it (`slay
 * tasks open`, `done --close`, an artifact to show, `slay browser` opening a panel or
 * tab). `getMenuEvents()` is read lazily inside each factory so a host that never
 * called `setMenuEvents()` doesn't throw at import.
 *
 * The native-menu / accelerator / updater / zoom subscriptions below are RETIRED
 * (task 557ebb72): those events are this device's own and reach its renderers from
 * its client host (`@slayzone/platform/client-host`), never a hub — a hub must not be
 * able to trigger a screenshot of the active browser view or reload the app. The
 * paths stay, inert, for older desktops that still subscribe; delete them once those
 * versions have aged out.
 */
/** An event for `principal` (undefined = not a user's request: everyone) reaches this
 *  subscriber. Same key as the browser relay's hosts: the user id, null when login-off. */
function forCaller(
  principal: string | null | undefined,
  ctx: { principal?: { userId?: string | null } | null }
): boolean {
  return principal === undefined || principal === (ctx.principal?.userId ?? null)
}

/** A retired client-local subscription: accepted, never fires. */
const retired = <T>() => publicProcedure.subscription(() => observable<T>(() => () => undefined))

export const menuRouter = router({
  // Retired with the client-local events (e2e drives them through the desktop's
  // `client-host:test-emit` now). Kept, inert, for the path's older callers.
  testEmit: publicProcedure
    .input(z.object({ event: z.enum(['close-current-focus', 'close-active-task']) }))
    .mutation(() => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
    }),
  onGoHome: retired<void>(),
  onToggleGlobalAgentPanel: retired<void>(),
  onToggleAgentStatusPanel: retired<void>(),
  onOpenSettings: retired<void>(),
  onOpenProjectSettings: retired<void>(),
  onNewTemporaryTask: retired<void>(),
  onScreenshotTrigger: retired<void>(),
  onCloseCurrentFocus: retired<void>(),
  onCloseActiveTask: retired<void>(),
  onSyncSessionId: retired<void>(),
  onReloadBrowser: retired<void>(),
  onReloadApp: retired<void>(),
  onZoomFactorChanged: retired<number>(),
  onUpdateStatus: retired<UpdateStatus>(),
  onOpenTask: publicProcedure.subscription(() =>
    observable<HubMenuEventMap['open-task'][0]>((emit) => {
      const h = (payload: HubMenuEventMap['open-task'][0]): void => emit.next(payload)
      const ev = getMenuEvents()
      ev.on('open-task', h)
      return () => ev.off('open-task', h)
    })
  ),
  onCloseTask: publicProcedure.subscription(() =>
    observable<string>((emit) => {
      const h = (taskId: string): void => emit.next(taskId)
      const ev = getMenuEvents()
      ev.on('close-task', h)
      return () => ev.off('close-task', h)
    })
  ),
  onOpenArtifact: publicProcedure.subscription(() =>
    observable<{ taskId: string; artifactId: string }>((emit) => {
      const h = (payload: { taskId: string; artifactId: string }): void => emit.next(payload)
      const ev = getMenuEvents()
      ev.on('open-artifact', h)
      return () => ev.off('open-artifact', h)
    })
  ),
  // A user's `slay browser` request opens tabs only in THAT user's own panel: on a
  // hub where tasks are shared, another user's agent never reaches yours.
  onBrowserEnsurePanelOpen: publicProcedure.subscription(({ ctx }) =>
    observable<HubMenuEventMap['browser-ensure-panel-open'][0]>((emit) => {
      const h = (payload: HubMenuEventMap['browser-ensure-panel-open'][0]): void => {
        if (forCaller(payload.principal, ctx)) emit.next(payload)
      }
      const ev = getMenuEvents()
      ev.on('browser-ensure-panel-open', h)
      return () => ev.off('browser-ensure-panel-open', h)
    })
  ),
  onBrowserCreateTab: publicProcedure.subscription(({ ctx }) =>
    observable<HubMenuEventMap['browser-create-tab'][0]>((emit) => {
      const h = (payload: HubMenuEventMap['browser-create-tab'][0]): void => {
        if (forCaller(payload.principal, ctx)) emit.next(payload)
      }
      const ev = getMenuEvents()
      ev.on('browser-create-tab', h)
      return () => ev.off('browser-create-tab', h)
    })
  ),
  // Fires when a `slay tasks browser` mutation (click/eval/type/navigate) trips
  // a tab. The renderer stamps `agentTouched: true` locally so a stale tabs-JSON
  // writeback can't clobber the server's sticky flag (replaces the old
  // electron-native browser-agent preload bridge).
  onBrowserAgentTouched: publicProcedure.subscription(() =>
    observable<{ taskId: string; tabId: string }>((emit) => {
      const h = (payload: { taskId: string; tabId: string }): void => emit.next(payload)
      const ev = getMenuEvents()
      ev.on('browser-agent-touched', h)
      return () => ev.off('browser-agent-touched', h)
    })
  )
})

export type MenuRouter = typeof menuRouter
/** Where `@slayzone/api` mounts it: `menu`. */
export type MenuMounts = { menu: MenuRouter }
