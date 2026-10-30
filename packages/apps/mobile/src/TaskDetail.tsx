import { PRIORITY_LABELS } from '@slayzone/tasks/board'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { TaskRow } from './hub-board'
import { type ChromeColors, useTheme } from './theme'

/**
 * A task, read-only: title, project, status, priority, its hub, description; with
 * `onOpenAgent`, a link to its agent screen.
 */
export function TaskDetail({
  row,
  showHub,
  onOpenAgent
}: {
  row: TaskRow
  showHub: boolean
  onOpenAgent?: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { task, project } = row
  return (
    <ScrollView contentContainerStyle={styles.detail}>
      <Text style={styles.title}>{task.title}</Text>
      <View style={styles.chips}>
        <Text style={styles.chip}>{project?.name ?? 'Unknown project'}</Text>
        <Text style={styles.chip}>{task.status}</Text>
        <Text style={styles.chip}>{PRIORITY_LABELS[task.priority] ?? `P${task.priority}`}</Text>
        {showHub ? <Text style={styles.chip}>{row.hubLabel}</Text> : null}
      </View>
      {onOpenAgent ? (
        <Pressable onPress={onOpenAgent} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>Agent ›</Text>
        </Pressable>
      ) : null}
      <Text style={styles.body}>{task.description?.trim() || 'No description'}</Text>
    </ScrollView>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    detail: { padding: 20, gap: 12 },
    title: { fontSize: 22, fontWeight: '600', color: t.foreground },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      fontSize: 12,
      color: t.foreground,
      backgroundColor: t.muted,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      overflow: 'hidden'
    },
    body: { fontSize: 15, lineHeight: 22, color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' }
  })
