import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '@slayzone/trpc-server'
import type { TasksChange, TasksChangedEvent } from '@slayzone/task-contracts'
import { getNotifyEvents, type SettingsChange } from '../app-deps'
import { createNotifyCoalescer } from '../notify-coalescer'

/**
 * Cross-domain refresh signals. Mirrors (and in slice 5 replaces) the
 * `tasks:changed` / `settings:changed` `webContents.send` broadcasts driven by
 * `notifyRenderer()`. The CLI → `POST /api/notify` → `notifyRenderer()` →
 * `notifyEvents.emit(...)` chain fans out to every WS subscriber (all windows,
 * no windowId filter). Both are refresh signals: `onTasksChanged` names the
 * changed task ids when every writer in the (coalesced) burst knew them
 * (`TasksChangedEvent`), `onSettingsChanged` names the written setting keys the
 * same way (`settings.set` emits its key; a generic ping names none). Bursts are merged
 * per subscriber (`createNotifyCoalescer`) so a storm of writes costs each
 * renderer one refetch per window, not one per write.
 */
export const notifyRouter = router({
  onTasksChanged: publicProcedure.subscription(() =>
    observable<TasksChangedEvent>((emit) => {
      const coalescer = createNotifyCoalescer<TasksChange>(
        (taskIds) => emit.next({ taskIds }),
        (change) => change?.taskIds
      )
      const handler = (change?: TasksChange): void => coalescer.push(change)
      const ev = getNotifyEvents()
      ev.on('tasks-changed', handler)
      return () => {
        ev.off('tasks-changed', handler)
        coalescer.dispose()
      }
    })
  ),
  // `keys`: the setting keys written (merged across a burst), or null = any.
  onSettingsChanged: publicProcedure.subscription(() =>
    observable<{ keys: string[] | null }>((emit) => {
      const coalescer = createNotifyCoalescer<SettingsChange>(
        (keys) => emit.next({ keys }),
        (change) => change?.keys
      )
      const handler = (change?: SettingsChange): void => coalescer.push(change)
      const ev = getNotifyEvents()
      ev.on('settings-changed', handler)
      return () => {
        ev.off('settings-changed', handler)
        coalescer.dispose()
      }
    })
  ),
  // Supervised embedded server exhausted its restart backoff (slice 7) —
  // carries a payload (unlike the refresh signals above) so the renderer's
  // persistent toast can say how many attempts were made and why.
  onEmbeddedServerFailed: publicProcedure.subscription(() =>
    observable<{ attempts: number; message: string }>((emit) => {
      const handler = (payload: { attempts: number; message: string }): void => emit.next(payload)
      const ev = getNotifyEvents()
      ev.on('embedded-server-failed', handler)
      return () => ev.off('embedded-server-failed', handler)
    })
  )
})
