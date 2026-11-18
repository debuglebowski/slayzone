import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { findTaskRow, type HubFeed, type TaskRow } from '../hub-board'
import type { HubSession } from '../hub-session'
import { findSession } from '../routes'
import { type ChromeColors, useTheme } from '../theme'
import { type TaskPageProps, TASK_SEGMENTS, TaskPage, type TaskSegment } from './TaskPage'

/** A route's `segment` param; anything else = the Agent (what a task opens on). */
export function segmentParam(value: string | undefined): TaskSegment {
  return TASK_SEGMENTS.includes(value as TaskSegment) ? (value as TaskSegment) : 'agent'
}

interface Located {
  hubAddress: string
  taskId: string
  sessions: readonly HubSession[]
  feeds: readonly HubFeed[]
}

/**
 * The task a route names (`/task/<hub address>/<task id>`), on that hub, as `show` draws
 * it; or why it can't be shown (not signed in to the hub, still loading, no such task
 * there), with a way back.
 */
function LocatedTask({
  hubAddress,
  taskId,
  sessions,
  feeds,
  onBack,
  backLabel,
  show
}: Located & {
  onBack: () => void
  backLabel: string
  show: (found: { row: TaskRow; feed: HubFeed; session: HubSession; showHub: boolean }) => ReactNode
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const session = findSession(sessions, hubAddress)
  const feed = session && feeds.find((f) => f.hub.id === session.entry.id)
  const row = feed ? findTaskRow(feed, taskId) : null

  if (session && feed && row) return show({ row, feed, session, showHub: feeds.length > 1 })

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>{backLabel}</Text>
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

/** The task a route names, as its page (`TaskPage`). */
export function TaskScreen({
  hubAddress,
  taskId,
  sessions,
  feeds,
  onBack,
  ...page
}: Located &
  Omit<TaskPageProps, 'row' | 'feed' | 'session' | 'showHub' | 'onDeleted' | 'onBack'> & {
    onBack: () => void
  }) {
  return (
    <LocatedTask
      hubAddress={hubAddress}
      taskId={taskId}
      sessions={sessions}
      feeds={feeds}
      onBack={onBack}
      backLabel="‹ Board"
      show={(found) => <TaskPage {...found} {...page} onBack={onBack} onDeleted={onBack} />}
    />
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
