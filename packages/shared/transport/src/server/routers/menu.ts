import { observable } from '@trpc/server/observable'
import type { UpdateStatus } from '@slayzone/types'
import { router, publicProcedure } from '../trpc'
import { getMenuEvents } from '../app-deps'

/**
 * Menu / app-shortcut signals. Mirrors (and in slice 5 replaces) the one-way
 * `app:*` / `browser:*` `webContents.send` broadcasts driven by native menus,
 * the `before-input-event` accelerator handler, the auto-updater, and the
 * REST/MCP task-open routes. The host dual-emits onto `menuEvents` (menu-events.ts)
 * alongside the legacy broadcasts; each `.emit(...)` fans out to every WS
 * subscriber. The legacy IPC broadcasts stay live in parallel until the renderer
 * drops IPC (slice 5). `getMenuEvents()` is read lazily inside each factory so the
 * standalone `@slayzone/server` host (which never calls `setMenuEvents()`) doesn't
 * throw at import.
 */
export const menuRouter = router({
  onGoHome: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('go-home', h)
      return () => ev.off('go-home', h)
    })
  ),
  onToggleGlobalAgentPanel: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('toggle-global-agent-panel', h)
      return () => ev.off('toggle-global-agent-panel', h)
    })
  ),
  onToggleAgentStatusPanel: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('toggle-agent-status-panel', h)
      return () => ev.off('toggle-agent-status-panel', h)
    })
  ),
  onOpenSettings: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('open-settings', h)
      return () => ev.off('open-settings', h)
    })
  ),
  onOpenProjectSettings: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('open-project-settings', h)
      return () => ev.off('open-project-settings', h)
    })
  ),
  onNewTemporaryTask: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('new-temporary-task', h)
      return () => ev.off('new-temporary-task', h)
    })
  ),
  onOpenTask: publicProcedure.subscription(() =>
    observable<{ taskId: string; background?: boolean }>((emit) => {
      const h = (payload: { taskId: string; background?: boolean }): void => emit.next(payload)
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
  onScreenshotTrigger: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('screenshot-trigger', h)
      return () => ev.off('screenshot-trigger', h)
    })
  ),
  onCloseCurrentFocus: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('close-current-focus', h)
      return () => ev.off('close-current-focus', h)
    })
  ),
  onCloseActiveTask: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('close-active-task', h)
      return () => ev.off('close-active-task', h)
    })
  ),
  onSyncSessionId: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('sync-session-id', h)
      return () => ev.off('sync-session-id', h)
    })
  ),
  onReloadBrowser: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('reload-browser', h)
      return () => ev.off('reload-browser', h)
    })
  ),
  onReloadApp: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const h = (): void => emit.next()
      const ev = getMenuEvents()
      ev.on('reload-app', h)
      return () => ev.off('reload-app', h)
    })
  ),
  onZoomFactorChanged: publicProcedure.subscription(() =>
    observable<number>((emit) => {
      const h = (factor: number): void => emit.next(factor)
      const ev = getMenuEvents()
      ev.on('zoom-factor-changed', h)
      return () => ev.off('zoom-factor-changed', h)
    })
  ),
  onUpdateStatus: publicProcedure.subscription(() =>
    observable<UpdateStatus>((emit) => {
      const h = (status: UpdateStatus): void => emit.next(status)
      const ev = getMenuEvents()
      ev.on('update-status', h)
      return () => ev.off('update-status', h)
    })
  ),
  onBrowserEnsurePanelOpen: publicProcedure.subscription(() =>
    observable<{ taskId: string; url?: string; tabId?: string }>((emit) => {
      const h = (payload: { taskId: string; url?: string; tabId?: string }): void =>
        emit.next(payload)
      const ev = getMenuEvents()
      ev.on('browser-ensure-panel-open', h)
      return () => ev.off('browser-ensure-panel-open', h)
    })
  ),
  onBrowserCreateTab: publicProcedure.subscription(() =>
    observable<{ taskId: string; tabId: string; url?: string; background?: boolean }>((emit) => {
      const h = (payload: {
        taskId: string
        tabId: string
        url?: string
        background?: boolean
      }): void => emit.next(payload)
      const ev = getMenuEvents()
      ev.on('browser-create-tab', h)
      return () => ev.off('browser-create-tab', h)
    })
  )
})
