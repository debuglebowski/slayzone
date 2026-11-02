import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { findTaskRow, type HubFeed } from '../hub-board'
import type { HubSession } from '../hub-session'
import { findSession } from '../routes'
import { type ChromeColors, useTheme } from '../theme'
import { TASK_SEGMENTS, TaskPage, type TaskSegment } from './TaskPage'

/** A route's `segment` param; anything else = the Agent (what a task opens on). */
export function segmentParam(value: string | undefined): TaskSegment {
  return TASK_SEGMENTS.includes(value as TaskSegment) ? (value as TaskSegment) : 'agent'
}

/**
 * The task a route names (`/task/<hub address>/<task id>`), on that hub, as its page
 * (`TaskPage`); or why it can't be shown (not signed in to the hub, still loading, no
 * such task there).
 */
export function TaskScreen({
  hubAddress,
  taskId,
  sessions,
  feeds,
  wide,
  segment,
  agentTabId,
  onSegment,
  onSelectAgentTab,
  onBack,
  onOpenTask,
  onOpenArtifact
}: {
  hubAddress: string
  taskId: string
  sessions: readonly HubSession[]
  feeds: readonly HubFeed[]
  wide: boolean
  segment: TaskSegment
  agentTabId: string | undefined
  onSegment: (segment: TaskSegment) => void
  onSelectAgentTab: (tabId: string) => void
  onBack: () => void
  onOpenTask: (taskId: string) => void
  onOpenArtifact: (artifactId: string, version: number | null) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const session = findSession(sessions, hubAddress)
  const feed = session && feeds.find((f) => f.hub.id === session.entry.id)
  const row = feed ? findTaskRow(feed, taskId) : null

  if (session && feed && row)
    return (
      <TaskPage
        row={row}
        feed={feed}
        session={session}
        showHub={feeds.length > 1}
        wide={wide}
        segment={segment}
        onSegment={onSegment}
        agentTabId={agentTabId}
        onSelectAgentTab={onSelectAgentTab}
        onBack={onBack}
        onDeleted={onBack}
        onOpenTask={onOpenTask}
        onOpenArtifact={onOpenArtifact}
      />
    )

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Board</Text>
        </Pressable>
      </View>
      {!session ? (
        <Text style={styles.note}>Not signed in to {hubAddress}</Text>
      ) : feed?.board.pending ? (
        <View style={styles.center} testID="task-loading">
          <ActivityIndicator color={theme.foreground} />
        </View>
      ) : (
        <Text style={styles.note}>No such task on {hubAddress}</Text>
      )}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 8 },
    link: { fontSize: 16, color: t.primary, fontWeight: '500' },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' }
  })
