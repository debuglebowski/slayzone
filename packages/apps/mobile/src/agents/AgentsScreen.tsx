import { useMemo } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { HubFeed } from '../hub-board'
import { HubBanners } from '../HubBanner'
import { type ChromeColors, useTheme } from '../theme'
import { AgentRows } from './AgentList'
import { type AgentRow, mergeHubAgents } from './hub-agents'

/**
 * The Agents tab (`/`, where the app opens): every signed-in hub's agents, under what
 * they need from the user ("Waiting for you", "Error", "Running", "Paused", "Done"). A
 * hub with a problem gets its banner (Retry, Sign out) above the list; pulling the list
 * down reloads every hub.
 */
export function AgentsScreen({
  feeds,
  onRetry,
  onSignOut,
  onOpen
}: {
  feeds: readonly HubFeed[]
  onRetry: (hubId: string) => void
  onSignOut: (hubId: string) => void
  onOpen: (row: AgentRow) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const rows = useMemo(() => mergeHubAgents(feeds), [feeds])
  const onlyHub = feeds.length === 1 ? feeds[0].hub : null
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Agents
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {onlyHub ? onlyHub.label : `${feeds.length} hubs`}
        </Text>
      </View>
      <HubBanners feeds={feeds} onRetry={onRetry} onSignOut={onSignOut} />
      <ScrollView
        refreshControl={
          <RefreshControl
            tintColor={theme.foreground}
            refreshing={feeds.some((f) => f.board.refreshing)}
            onRefresh={() => {
              for (const feed of feeds) onRetry(feed.hub.id)
            }}
          />
        }
      >
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
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { fontSize: 22, fontWeight: '700', color: t.foreground },
    sub: { fontSize: 12, color: t.mutedForeground },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' }
  })
