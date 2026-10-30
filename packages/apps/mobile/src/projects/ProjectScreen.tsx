import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { HubFeed, TaskRow } from '../hub-board'
import type { HubSession } from '../hub-session'
import { findSession } from '../routes'
import { type ChromeColors, useTheme } from '../theme'
import { findProjectRow, projectTasks } from './hub-projects'
import { ProjectDetail } from './ProjectDetail'

/**
 * A project on its own screen (phone; an iPad shows it beside the list): the one its
 * route names, `/projects/<hub address>/<project id>`, on that hub.
 */
export function ProjectScreen({
  hubAddress,
  projectId,
  sessions,
  feeds,
  onBack,
  onOpenTask
}: {
  hubAddress: string
  projectId: string
  sessions: readonly HubSession[]
  feeds: readonly HubFeed[]
  onBack: () => void
  onOpenTask: (task: TaskRow) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const session = findSession(sessions, hubAddress)
  const feed = session && feeds.find((f) => f.hub.id === session.entry.id)
  const row = feed ? findProjectRow(feed, projectId) : null

  let body: ReactNode
  if (!session) body = <Text style={styles.note}>Not signed in to {hubAddress}</Text>
  else if (row && feed)
    body = (
      <ProjectDetail
        row={row}
        tasks={projectTasks(feed, projectId)}
        showHub={feeds.length > 1}
        onOpenTask={onOpenTask}
      />
    )
  else if (feed?.board.pending)
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={theme.foreground} />
      </View>
    )
  else body = <Text style={styles.note}>No such project on {hubAddress}</Text>

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Projects</Text>
        </Pressable>
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
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' }
  })
