import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '../trpc'
import { getNotifyEvents } from '../app-deps'

/**
 * Cross-domain refresh signals. Mirrors (and in slice 5 replaces) the
 * `tasks:changed` / `settings:changed` `webContents.send` broadcasts driven by
 * `notifyRenderer()`. The CLI → `POST /api/notify` → `notifyRenderer()` →
 * `notifyEvents.emit(...)` chain fans out to every WS subscriber (all windows,
 * no windowId filter). Both subscriptions carry no payload — they only tell the
 * renderer to refetch. The legacy IPC broadcast stays live in parallel until the
 * renderer drops IPC (slice 5).
 */
export const notifyRouter = router({
  onTasksChanged: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const handler = (): void => emit.next()
      const ev = getNotifyEvents()
      ev.on('tasks-changed', handler)
      return () => ev.off('tasks-changed', handler)
    })
  ),
  onSettingsChanged: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const handler = (): void => emit.next()
      const ev = getNotifyEvents()
      ev.on('settings-changed', handler)
      return () => ev.off('settings-changed', handler)
    })
  )
})
