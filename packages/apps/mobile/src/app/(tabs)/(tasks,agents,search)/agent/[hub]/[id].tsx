import { HubScope } from '@slayzone/transport/client'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { AgentScreen } from '../../../../../agents/AgentScreen'
import { useHubFeeds } from '../../../../../hub-connections'
import { useHubSessions } from '../../../../../hub-sessions'
import { AGENTS, findSession } from '../../../../../routes'
import { type ChromeColors, useTheme } from '../../../../../theme'

/**
 * `/agent/<hub address>/<task id>?tab=<tab id>` (deep link `slayzone://agent/…`): a
 * task's agents, inside the scope of the hub that owns the task — every call the
 * screen makes goes to that hub.
 */
export default function AgentRoute() {
  const { hub, id, tab } = useLocalSearchParams<{ hub: string; id: string; tab?: string }>()
  const router = useRouter()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  const back = () => (router.canGoBack() ? router.back() : router.replace(AGENTS))
  const session = findSession(sessions, hub)
  const feed = session && feeds.find((f) => f.hub.id === session.entry.id)
  if (!session || !feed) return <NotSignedIn hubAddress={hub} onBack={back} />
  return (
    <HubScope hubId={session.entry.id}>
      <AgentScreen
        hubId={session.entry.id}
        feed={feed}
        showHub={feeds.length > 1}
        taskId={id}
        tabId={tab}
        onBack={back}
        onSelectTab={(tabId) => router.setParams({ tab: tabId })}
      />
    </HubScope>
  )
}

function NotSignedIn({ hubAddress, onBack }: { hubAddress: string; onBack: () => void }) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>Not signed in to {hubAddress}</Text>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    header: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' }
  })
