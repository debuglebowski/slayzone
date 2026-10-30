import { useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { HubFeed } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { AgentRows } from './AgentList'
import { type AgentRow, mergeHubAgents } from './hub-agents'

/**
 * `/agents`: every signed-in hub's agents, under what they need from the user
 * ("Waiting for you", "Error", "Running", "Paused", "Done"). Home shows the first
 * few; this screen shows them all.
 */
export function AgentsScreen({
  feeds,
  onBack,
  onOpen
}: {
  feeds: readonly HubFeed[]
  onBack: () => void
  onOpen: (row: AgentRow) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const rows = useMemo(() => mergeHubAgents(feeds), [feeds])
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Home</Text>
        </Pressable>
        <Text style={styles.title}>Agents</Text>
      </View>
      <ScrollView>
        {rows.length === 0 ? (
          <Text style={styles.note}>No agents</Text>
        ) : (
          <AgentRows rows={rows} showHub={feeds.length > 1} onOpen={onOpen} />
        )}
      </ScrollView>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { fontSize: 17, fontWeight: '600', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' }
  })
