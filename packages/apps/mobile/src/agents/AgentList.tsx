import { Pressable, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import type { AgentGroup } from './agent-status'
import { agentStateLabel } from './agent-status'
import { type AgentRow, groupAgentRows } from './hub-agents'

/** The colour of each group's dot: what it needs from the user, in the theme's tones. */
export function groupColor(t: ChromeColors, group: AgentGroup): string {
  switch (group) {
    case 'waiting':
      return t.warning
    case 'error':
      return t.destructive
    case 'running':
      return t.success
    case 'hibernated':
      return t.agent
    case 'done':
      return t.mutedForeground
  }
}

/** `Active · Unread · 2 jobs · Project · hub` (the hub only when there are several). */
export function agentMeta(row: AgentRow, showHub: boolean): string {
  const parts = [agentStateLabel(row.state)]
  if (row.unread) parts.push('Unread')
  if (row.backgroundJobs > 0)
    parts.push(`${row.backgroundJobs} ${row.backgroundJobs === 1 ? 'job' : 'jobs'}`)
  parts.push(row.project?.name ?? 'Unknown project')
  if (showHub) parts.push(row.hubLabel)
  return parts.join(' · ')
}

/**
 * Agents under their group titles ("Waiting for you", "Error", "Running", "Paused",
 * "Done"), each row: a dot in the group's colour, the task's title, its state, unread,
 * background jobs, project and (several hubs) hub.
 */
export function AgentRows({
  rows,
  showHub,
  onOpen
}: {
  rows: readonly AgentRow[]
  showHub: boolean
  onOpen: (row: AgentRow) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <View>
      {groupAgentRows(rows).map((group) => (
        <View key={group.group}>
          <Text style={styles.group}>{group.title}</Text>
          {group.rows.map((row) => (
            <Pressable
              key={row.key}
              testID={`agent-row-${row.hubLabel}-${row.task.id}`}
              style={styles.row}
              onPress={() => onOpen(row)}
              accessibilityRole="button"
            >
              <View style={[styles.dot, { backgroundColor: groupColor(theme, row.group) }]} />
              <View style={styles.text}>
                <Text testID="agent-title" style={styles.title} numberOfLines={1}>
                  {row.task.title}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {agentMeta(row, showHub)}
                </Text>
              </View>
              {row.unread ? (
                <View style={[styles.unread, { backgroundColor: theme.warning }]} />
              ) : null}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  )
}

/** How many agents home shows before "All agents (N)". */
export const HOME_AGENT_LIMIT = 5

/** Home's Agents section: the first agents (what needs the user first) + a link to all. */
export function AgentsSection({
  rows,
  showHub,
  onOpen,
  onShowAll
}: {
  rows: readonly AgentRow[]
  showHub: boolean
  onOpen: (row: AgentRow) => void
  onShowAll: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <View testID="agents-section">
      <View style={styles.sectionHeader}>
        <Text style={styles.section}>Agents</Text>
        {rows.length > HOME_AGENT_LIMIT ? (
          <Pressable onPress={onShowAll} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>All agents ({rows.length})</Text>
          </Pressable>
        ) : null}
      </View>
      {rows.length === 0 ? (
        <Text style={styles.note}>No agents</Text>
      ) : (
        <AgentRows rows={rows.slice(0, HOME_AGENT_LIMIT)} showHub={showHub} onOpen={onOpen} />
      )}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingRight: 16
    },
    section: {
      fontSize: 12,
      fontWeight: '600',
      color: t.mutedForeground,
      textTransform: 'uppercase',
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 4
    },
    link: { fontSize: 13, color: t.foreground, fontWeight: '500', paddingTop: 12 },
    group: {
      fontSize: 12,
      color: t.mutedForeground,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 2
    },
    note: { color: t.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    text: { flex: 1 },
    title: { fontSize: 16, color: t.foreground },
    meta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    unread: { width: 8, height: 8, borderRadius: 4 }
  })
