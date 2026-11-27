import { observable } from '@trpc/server/observable'
import { router, publicProcedure } from '@slayzone/trpc-server'
import type { BoardPart, TasksChange, TasksChangedEvent } from '@slayzone/task-contracts'
import { getNotifyEvents, type SettingsChange } from './notify-events'
import { createNotifyCoalescer } from './notify-coalescer'

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
/**
 * `onTasksChanged`'s input. `boardParts`: this subscriber reads `TasksChangedEvent.parts`
 * (a tag/project/group list changed, reload just it). Without it (a client older than
 * the field) an event that names a part arrives as unknown scope (`taskIds: null`), the
 * full reload that client already does for it.
 */
export interface TasksChangedInput {
  boardParts?: true
}

function parseTasksChangedInput(raw: unknown): TasksChangedInput | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') throw new Error('notify.onTasksChanged: input must be an object')
  return (raw as { boardParts?: unknown }).boardParts === true ? { boardParts: true } : {}
}

export const notifyRouter = router({
  onTasksChanged: publicProcedure.input(parseTasksChangedInput).subscription(({ input }) =>
    observable<TasksChangedEvent>((emit) => {
      const readsParts = input?.boardParts === true
      const coalescer = createNotifyCoalescer<TasksChange>(
        (taskIds, parts) => {
          if (parts.length === 0) emit.next({ taskIds })
          else if (readsParts) emit.next({ taskIds, parts: parts as BoardPart[] })
          else emit.next({ taskIds: null })
        },
        (change) => change?.taskIds,
        undefined,
        (change) => change?.parts
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

export type NotifyRouter = typeof notifyRouter
/** Where `@slayzone/api` mounts it: `notify`. */
export type NotifyMounts = { notify: NotifyRouter }
