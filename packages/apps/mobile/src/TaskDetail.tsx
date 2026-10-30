import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { TaskArtifactsLink } from './artifacts/TaskArtifactsLink'
import { TaskComputer } from './computers/TaskComputer'
import type { TaskRow } from './hub-board'
import { TaskEditor } from './task-edit/TaskEditor'
import { type ChromeColors, useTheme } from './theme'

/**
 * A task, editable (`TaskEditor`: title, fields, description, subtasks, tags, blockers,
 * archive, delete), with `onOpenAgent` a link to its agent screen, the computer it runs
 * on (changeable) and a link to its artifacts. Everything scopes itself to the task's
 * hub (the iPad split has no hub scope). `onDeleted`: the task was deleted.
 */
export function TaskDetail({
  row,
  showHub,
  onOpenAgent,
  onDeleted
}: {
  row: TaskRow
  showHub: boolean
  onOpenAgent?: () => void
  onDeleted?: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { task } = row
  return (
    <ScrollView
      contentContainerStyle={styles.detail}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <TaskEditor row={row} showHub={showHub} onDeleted={onDeleted}>
        {onOpenAgent ? (
          <Pressable onPress={onOpenAgent} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Agent ›</Text>
          </Pressable>
        ) : null}
        <TaskComputer row={row} />
        <TaskArtifactsLink hubId={row.hubId} hubAddress={row.hubLabel} taskId={task.id} />
      </TaskEditor>
    </ScrollView>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    detail: { padding: 20, paddingBottom: 48 },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' }
  })
