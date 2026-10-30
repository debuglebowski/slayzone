import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { type HubFeed, hubProblem } from './hub-board'
import { type ChromeColors, useTheme } from './theme'

/**
 * The hubs this app is signed in to, in sign-in order: each with its connection and
 * Sign out; Add a hub opens the sign-in screen. The first hub paints the app's theme.
 */
export function HubsScreen({
  feeds,
  onAdd,
  onSignOut,
  onBack
}: {
  feeds: readonly HubFeed[]
  onAdd: () => void
  onSignOut: (hubId: string) => void
  onBack: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Home</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Hubs</Text>
        <Pressable onPress={onAdd} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>Add a hub</Text>
        </Pressable>
      </View>
      <FlatList
        data={feeds}
        keyExtractor={(feed) => feed.hub.id}
        renderItem={({ item, index }) => {
          const status = statusOf(item)
          return (
            <View testID={`hub-${item.hub.id}`} style={styles.row}>
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
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 16, color: t.foreground },
    rowMeta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 }
  })
