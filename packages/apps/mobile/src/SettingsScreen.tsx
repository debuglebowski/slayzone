import Constants from 'expo-constants'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { type HubFeed, hubProblem } from './hub-board'
import type { HubSession } from './hub-session'
import { HubDetails } from './hubs/HubDetails'
import { type ChromeColors, useTheme, useThemeVariant } from './theme'
import { Caption } from './ui-kit/Chrome'

/** Settings stay a readable width on an iPad. */
const MAX_CONTENT_WIDTH = 720

/**
 * The Settings tab, like desktop's Settings:
 *
 * - Hubs (desktop's Connections): the hubs this app is signed in to, in sign-in order,
 *   each with its connection, who the app is signed in as there, its computers (live),
 *   and Sign out (which removes it: its tasks and agents leave every list, its bearer
 *   and the theme kept from it are forgotten). Add a hub opens the sign-in screen.
 *   The demo hub (`HubSession.inProcess`) shows as the demo, with Exit demo instead of
 *   Sign out (both go through `onSignOut`, which closes the demo for its hub).
 * - Appearance: the theme is the first hub's (desktop's Appearance settings there).
 * - About: the app's version.
 *
 * A project's folders and computer are its settings (the project switcher's ⋯).
 */
export function SettingsScreen({
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
  const variant = useThemeVariant()
  const styles = makeStyles(theme)
  const themeHub = feeds[0]?.hub.label
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          Settings
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        <View style={styles.sectionHead}>
          <Caption>Hubs</Caption>
          <Pressable onPress={onAdd} hitSlop={8} accessibilityRole="button" testID="add-hub">
            <Text style={styles.link}>＋ Add a hub</Text>
          </Pressable>
        </View>
        {feeds.map((item, index) => {
          const status = statusOf(item)
          const session = sessions.find((s) => s.entry.id === item.hub.id)
          const demo = session?.inProcess !== undefined
          return (
            <View key={item.hub.id} testID={`hub-${item.hub.id}`} style={styles.card}>
              <View style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{demo ? 'SlayZone demo' : item.hub.label}</Text>
                  <Text style={styles.rowMeta}>
                    {demo
                      ? 'Sample data inside the app — nothing is sent anywhere'
                      : index === 0
                        ? `${status} · theme from this hub`
                        : status}
                  </Text>
                </View>
                <Pressable
                  onPress={() => onSignOut(item.hub.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                >
                  <Text style={styles.destructive}>{demo ? 'Exit demo' : 'Sign out'}</Text>
                </Pressable>
              </View>
              {session ? <HubDetails session={session} /> : null}
            </View>
          )
        })}

        <View style={styles.sectionHead}>
          <Caption>Appearance</Caption>
        </View>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>
            {variant === 'dark' ? 'Dark' : 'Light'} theme
            {themeHub ? ` · from ${themeHub}` : ''}
          </Text>
          <Text style={styles.rowMeta}>
            The app paints in the theme chosen on desktop (Settings → Appearance) on the first hub.
          </Text>
        </View>

        <View style={styles.sectionHead}>
          <Caption>About</Caption>
        </View>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>SlayZone {Constants.expoConfig?.version ?? ''}</Text>
          <Text style={styles.rowMeta}>
            Project folders and computers: the project switcher's ⋯ on the board.
          </Text>
        </View>
      </ScrollView>
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
    header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
    headerTitle: { fontSize: 24, fontWeight: '700', color: t.foreground },
    link: { fontSize: 14, color: t.primary, fontWeight: '600' },
    destructive: { fontSize: 14, color: t.destructive, fontWeight: '500' },
    list: {
      width: '100%',
      maxWidth: MAX_CONTENT_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: 14,
      paddingBottom: 40,
      gap: 8
    },
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 4,
      paddingTop: 14
    },
    card: {
      backgroundColor: t.surface1,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 6
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 16, color: t.foreground },
    rowMeta: { fontSize: 12, color: t.mutedForeground, marginTop: 2 }
  })
