import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { HubFeed } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { Caption } from '../ui-kit/Chrome'
import { AgentDot, PriorityIcon } from '../ui-kit/TaskGlyphs'
import { statusCategoryOf, taskAgentDot } from './card-model'
import { searchTasks, type TaskSearchResult } from './task-search'

/**
 * The Search tab's task results for a query (`searchTasks`: every hub's loaded board,
 * titles and descriptions) as board cards: priority, title, agent dot, project ·
 * status (· hub, with several), and the description around the match when that is
 * where it was found.
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
      <View style={styles.section}>
        <Caption>Tasks</Caption>
      </View>
      {results.length === 0 ? <Text style={styles.note}>No tasks found</Text> : null}
      {results.map((r) => {
        const meta = [
          r.project?.name ?? 'Unknown project',
          statusCategoryOf(r.task.status, r.project).label
        ]
        if (severalHubs) meta.push(r.hubLabel)
        const feed = feeds.find((f) => f.hub.id === r.hubId)
        const dot = feed ? taskAgentDot(feed, r.task) : null
        return (
          <Pressable
            key={r.key}
            style={styles.row}
            onPress={() => onOpen(r)}
            accessibilityRole="button"
            testID={`task-search-result-${r.hubLabel}-${r.task.id}`}
          >
            <View style={styles.top}>
              <View style={styles.glyph}>
                <PriorityIcon priority={r.task.priority} />
              </View>
              <View style={styles.text}>
                <Text style={styles.title} numberOfLines={2}>
                  {r.task.title}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {meta.join(' · ')}
                </Text>
              </View>
              {dot ? (
                <View style={styles.glyph}>
                  <AgentDot kind={dot} />
                </View>
              ) : null}
            </View>
            {r.excerpt ? (
              <Text style={styles.excerpt} numberOfLines={2}>
                {r.excerpt}
              </Text>
            ) : null}
          </Pressable>
        )
      })}
      <View style={styles.section}>
        <Caption>Artifacts</Caption>
      </View>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    section: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
    note: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 },
    row: {
      marginHorizontal: 12,
      marginBottom: 8,
      paddingHorizontal: 11,
      paddingVertical: 11,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface3
    },
    top: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
    glyph: { paddingTop: 3 },
    text: { flex: 1 },
    title: { fontSize: 15, fontWeight: '500', color: t.foreground },
    meta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    excerpt: { fontSize: 13, color: t.mutedForeground, marginTop: 6 }
  })
