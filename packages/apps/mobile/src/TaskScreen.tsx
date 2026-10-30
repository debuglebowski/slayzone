import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { findTaskRow, type HubFeed } from './hub-board'
import type { HubSession } from './hub-session'
import { findSession } from './routes'
import { TaskDetail } from './TaskDetail'
import { type ChromeColors, useTheme } from './theme'

/**
 * A task on its own screen (phone; an iPad shows it beside the list): the one its
 * route names, `/task/<hub address>/<task id>`, on that hub.
 */
export function TaskScreen({
  hubAddress,
  taskId,
  sessions,
  feeds,
  onBack,
  onOpenAgent
}: {
  hubAddress: string
  taskId: string
  sessions: readonly HubSession[]
  feeds: readonly HubFeed[]
  onBack: () => void
  /** The task's agent screen (its agent can be started there). */
  onOpenAgent: (taskId: string) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const session = findSession(sessions, hubAddress)
  const feed = session && feeds.find((f) => f.hub.id === session.entry.id)
  const row = feed ? findTaskRow(feed, taskId) : null

  let body: ReactNode
  if (!session) body = <Text style={styles.note}>Not signed in to {hubAddress}</Text>
  else if (row) body = <TaskDetail row={row} showHub={feeds.length > 1} onDeleted={onBack} />
  else if (feed?.board.pending)
    body = (
      <View style={styles.center} testID="task-loading">
        <ActivityIndicator color={theme.foreground} />
      </View>
    )
  else body = <Text style={styles.note}>No such task on {hubAddress}</Text>

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
        {row ? (
          <Pressable
            onPress={() => onOpenAgent(row.task.id)}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={styles.link}>Agent ›</Text>
          </Pressable>
        ) : null}
      </View>
      {body}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' }
  })
