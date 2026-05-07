import { useEffect } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'

/**
 * Sets a timeout for the nearest snoozed task. When it fires, clears the
 * snooze via updateTask (which triggers tasks:changed → loadData → re-render)
 * and shows a desktop notification.
 */
export function useSnoozeWakeUp(tasks: Task[]): void {
  useEffect(() => {
    const now = Date.now()
    const snoozed = tasks.filter(
      (t) => t.snoozed_until && new Date(t.snoozed_until).getTime() > now
    )
    if (snoozed.length === 0) return

    // Find the nearest wake time
    let nearest: Task = snoozed[0]
    let nearestTime = new Date(nearest.snoozed_until!).getTime()
    for (let i = 1; i < snoozed.length; i++) {
      const t = new Date(snoozed[i].snoozed_until!).getTime()
      if (t < nearestTime) {
        nearest = snoozed[i]
        nearestTime = t
      }
    }

    const delay = Math.max(nearestTime - Date.now(), 500)

    const timer = setTimeout(async () => {
      // Clear the snooze — this triggers tasks:changed → re-render
      try {
        await getTrpcVanillaClient().task.update.mutate({ id: nearest.id, snoozedUntil: null })
      } catch { /* task may have been deleted */ }

      // Desktop notification
      try {
        new Notification('Task unsnoozed', { body: nearest.title })
      } catch { /* notifications may be blocked */ }
    }, delay)

    return () => clearTimeout(timer)
  }, [tasks])
}
