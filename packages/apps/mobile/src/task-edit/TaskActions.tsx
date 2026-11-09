/**
 * Archive / unarchive and delete, each after asking — desktop's two ways out: an archived
 * task stays (restorable from the archive), a deleted one leaves the board (the hub keeps
 * it soft-deleted; `task.restore` brings it back, as desktop's Undo does). The hub
 * refuses to delete a task linked to an integration (`linked_to_provider`).
 */
import { Alert } from 'react-native'
import { useTRPCClient } from '../trpc'
import type { TaskWrites } from './use-task-writes'

export interface TaskActions {
  archived: boolean
  /** Asks, then archives (or unarchives an archived task). */
  toggleArchive: () => void
  /** Asks, then deletes; `onDeleted` once the hub has. */
  remove: () => void
}

export function useTaskActions(
  writes: TaskWrites,
  /** The task was deleted (a screen of its own leaves). */
  onDeleted?: () => void
): TaskActions {
  const client = useTRPCClient()
  const { task } = writes
  const archived = !!task.archived_at

  const toggleArchive = () => {
    const word = archived ? 'Unarchive' : 'Archive'
    Alert.alert(
      `${word} task?`,
      archived
        ? `Restore “${task.title}” from the archive?`
        : `Archive “${task.title}”? You can restore it later from the archive.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: word,
          onPress: () =>
            void writes.run(() =>
              archived
                ? client.task.unarchive.mutate({ id: task.id })
                : client.task.archive.mutate({ id: task.id })
            )
        }
      ]
    )
  }

  const remove = () =>
    Alert.alert(
      'Permanently delete task?',
      `Delete “${task.title}” and its SlayZone data? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            void writes
              .run(() => client.task.delete.mutate({ id: task.id }))
              .then((result) => {
                if (result === true) onDeleted?.()
                else if (result && typeof result === 'object' && 'blocked' in result) {
                  writes.setError(
                    'This task is linked to an integration (e.g. Linear). Unlink it on desktop before deleting it.'
                  )
                } else if (result && typeof result === 'object' && 'incomplete' in result) {
                  const computers = result.erasure.computers
                    .filter((c) => !c.deleted)
                    .map((c) => c.name)
                  writes.setError(
                    computers.length
                      ? `Data on ${computers.join(', ')} has not been deleted yet.`
                      : 'Some data has not been deleted yet. Cleanup will retry.'
                  )
                } else if (result === false) writes.setError('The hub has no such task any more.')
              })
        }
      ]
    )

  return { archived, toggleArchive, remove }
}
