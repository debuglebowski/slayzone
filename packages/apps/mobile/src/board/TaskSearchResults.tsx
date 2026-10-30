import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { HubFeed } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { searchTasks, type TaskSearchResult } from './task-search'

/**
 * The Search tab's task results for a query (`searchTasks`: every hub's loaded board,
 * titles and descriptions): title, project · status (· hub, with several), and the
 * description around the match when that is where it was found.
 */
export function TaskSearchResults({
  feeds,
  q,
  onOpen
}: {
  feeds: readonly HubFeed[]
  q: string
  onOpen: (result: TaskSearchResult) => void
}) {
  const styles = makeStyles(useTheme())
  const results = searchTasks(feeds, q)
  const severalHubs = feeds.length > 1
  return (
    <View testID="task-search-results">
      <Text style={styles.section}>Tasks</Text>
      {results.length === 0 ? <Text style={styles.note}>No tasks found</Text> : null}
      {results.map((r) => {
        const meta = [r.project?.name ?? 'Unknown project', r.task.status]
        if (severalHubs) meta.push(r.hubLabel)
        return (
          <Pressable
            key={r.key}
            style={styles.row}
            onPress={() => onOpen(r)}
            accessibilityRole="button"
            testID={`task-search-result-${r.hubLabel}-${r.task.id}`}
          >
            <Text style={styles.title} numberOfLines={2}>
              {r.task.title}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {meta.join(' · ')}
            </Text>
            {r.excerpt ? (
              <Text style={styles.excerpt} numberOfLines={2}>
                {r.excerpt}
              </Text>
            ) : null}
          </Pressable>
        )
      })}
      <Text style={styles.section}>Artifacts</Text>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    section: {
      fontSize: 13,
      fontWeight: '600',
      color: t.mutedForeground,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 6
    },
    note: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 },
    row: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { fontSize: 16, color: t.foreground },
    meta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    excerpt: { fontSize: 13, color: t.mutedForeground, marginTop: 4 }
  })
