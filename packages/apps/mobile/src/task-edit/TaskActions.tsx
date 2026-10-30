/**
 * Archive / unarchive and delete, each after asking — desktop's two ways out: an archived
 * task stays (restorable from the archive), a deleted one leaves the board (the hub keeps
 * it soft-deleted; `task.restore` brings it back, as desktop's Undo does). The hub
 * refuses to delete a task linked to an integration (`linked_to_provider`).
 */
import { Alert, Pressable, Text, View } from 'react-native'
import { useTheme } from '../theme'
import { useTRPCClient } from '../trpc'
import { makeStyles } from './ui'
import type { TaskWrites } from './use-task-writes'

export function TaskActions({
  writes,
  onDeleted
}: {
  writes: TaskWrites
  /** The task was deleted (a screen of its own leaves). */
  onDeleted?: () => void
}) {
  const styles = makeStyles(useTheme())
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
    Alert.alert('Delete task?', `Delete “${task.title}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          void writes
            .run(() => client.task.delete.mutate({ id: task.id }))
            .then((result) => {
              if (result === true) onDeleted?.()
              else if (result && typeof result === 'object' && result.blocked) {
                writes.setError(
                  'This task is linked to an integration (e.g. Linear). Unlink it on desktop before deleting it.'
                )
              } else if (result === false) writes.setError('The hub has no such task any more.')
            })
      }
    ])

  return (
    <View style={styles.section}>
      {archived ? <Text style={styles.muted}>Archived</Text> : null}
      <View style={{ flexDirection: 'row', gap: 24 }}>
        <Pressable accessibilityRole="button" onPress={toggleArchive} hitSlop={8}>
          <Text style={styles.link}>{archived ? 'Unarchive' : 'Archive'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={remove} hitSlop={8}>
          <Text style={styles.destructive}>Delete</Text>
        </Pressable>
      </View>
    </View>
  )
}
