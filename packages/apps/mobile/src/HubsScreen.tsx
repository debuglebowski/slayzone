import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { type HubFeed, hubProblem } from './hub-board'
import type { HubSession } from './hub-session'
import { HubDetails } from './hubs/HubDetails'
import { type ChromeColors, useTheme } from './theme'

/** Hub cards stay a readable width on an iPad. */
const MAX_CONTENT_WIDTH = 720

/**
 * The Hubs tab: the hubs this app is signed in to, in sign-in order, like desktop's Settings →
 * Connections: each with its connection, who the app is signed in as there, its
 * computers (live), and Sign out (which removes it: its tasks and agents leave every
 * list, its bearer and the theme kept from it are forgotten). Add a hub opens the
 * sign-in screen. The first hub paints the app's theme.
 */
export function HubsScreen({
  feeds,
  sessions,
  onAdd,
  onSignOut
}: {
  feeds: readonly HubFeed[]
  sessions: readonly HubSession[]
  onAdd: () => void
  onSignOut: (hubId: string) => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Hubs</Text>
        <Pressable onPress={onAdd} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>Add a hub</Text>
        </Pressable>
      </View>
      <FlatList
        data={feeds}
        keyExtractor={(feed) => feed.hub.id}
        contentContainerStyle={styles.list}
        renderItem={({ item, index }) => {
          const status = statusOf(item)
          const session = sessions.find((s) => s.entry.id === item.hub.id)
          return (
            <View testID={`hub-${item.hub.id}`} style={styles.card}>
              <View style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{item.hub.label}</Text>
                  <Text style={styles.rowMeta}>
                    {index === 0 ? `${status} · theme from this hub` : status}
                  </Text>
                </View>
                <Pressable
                  onPress={() => onSignOut(item.hub.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                >
                  <Text style={styles.link}>Sign out</Text>
                </Pressable>
              </View>
              {session ? <HubDetails session={session} /> : null}
            </View>
          )
        }}
      />
    </View>
  )
}

function statusOf(feed: HubFeed): string {
  const problem = hubProblem(feed)
  if (problem?.kind === 'unreachable') return "Can't reach"
  if (problem?.kind === 'failed') return problem.message
  return feed.connection?.status === 'open' ? 'Connected' : 'Connecting…'
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
    headerTitle: { flex: 1, fontSize: 22, fontWeight: '700', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    list: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center' },
    card: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 16, color: t.foreground },
    rowMeta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 }
  })
