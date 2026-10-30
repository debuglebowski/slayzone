import { NO_COMPUTERS_NOTE } from '@slayzone/computers/labels'
import { HubScope } from '@slayzone/transport/client'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { ComputerStatus } from '../computers/ComputerStatus'
import type { HubComputer } from '../computers/hub-computers'
import { useHubComputers } from '../computers/use-hub-computers'
import type { HubSession } from '../hub-session'
import { type ChromeColors, useTheme } from '../theme'
import { useHubAccount } from './use-hub-account'

/**
 * What a hub card shows beyond its connection: who the app is signed in as there, and
 * the hub's computers with their live state — desktop's Settings → Connections card,
 * which lists a hub's computers under it. Scopes itself to that hub.
 */
export function HubDetails({ session }: { session: HubSession }) {
  return (
    <HubScope hubId={session.entry.id}>
      <HubDetailsBody session={session} />
    </HubScope>
  )
}

function HubDetailsBody({ session }: { session: HubSession }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const email = useHubAccount(session)
  const { computers, pending, error } = useHubComputers()

  let list
  if (pending) list = <ActivityIndicator color={theme.mutedForeground} style={styles.spinner} />
  else if (error) list = <Text style={styles.error}>{error}</Text>
  else if (computers.length === 0) list = <Text style={styles.note}>{NO_COMPUTERS_NOTE}</Text>
  else list = computers.map((computer) => <ComputerRow key={computer.id} computer={computer} />)

  return (
    <View style={styles.details}>
      {email ? <Text style={styles.note}>Signed in as {email}</Text> : null}
      <Text style={styles.section}>Computers</Text>
      <View testID={`hub-computers-${session.entry.id}`}>{list}</View>
    </View>
  )
}

function ComputerRow({ computer }: { computer: HubComputer }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const meta = [computer.platform, computer.machine?.name].filter(Boolean).join(' · ')
  return (
    <View style={styles.computer}>
      <View style={styles.computerText}>
        <Text style={styles.computerName} numberOfLines={1}>
          {computer.name}
        </Text>
        {meta ? <Text style={styles.note}>{meta}</Text> : null}
      </View>
      <ComputerStatus computer={computer} />
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    details: { gap: 4, marginTop: 6 },
    section: {
      fontSize: 11,
      fontWeight: '600',
      color: t.mutedForeground,
      textTransform: 'uppercase',
      marginTop: 8
    },
    spinner: { alignSelf: 'flex-start', marginVertical: 6 },
    computer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    computerText: { flex: 1 },
    computerName: { fontSize: 15, color: t.foreground },
    note: { fontSize: 12, color: t.mutedForeground },
    error: { fontSize: 12, color: t.destructive }
  })
