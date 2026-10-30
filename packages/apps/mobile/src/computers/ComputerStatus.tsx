import { type ComputerStatusTone, computerStatus } from '@slayzone/computers/labels'
import { StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import type { HubComputer } from './hub-computers'

/** A tone's dot colour: desktop's (green / destructive / muted), from the theme. */
export function toneColor(theme: ChromeColors, tone: ComputerStatusTone): string {
  switch (tone) {
    case 'ok':
      return theme.success
    case 'bad':
      return theme.destructive
    case 'idle':
      return theme.mutedForeground
  }
}

/** A computer's state as desktop's Settings → Connections shows it: a dot and the word. */
export function ComputerStatus({ computer }: { computer: HubComputer }) {
  const theme = useTheme()
  const { label, tone } = computerStatus(computer)
  return (
    <View style={styles.status} testID={`computer-status-${computer.id}`}>
      <View style={[styles.dot, { backgroundColor: toneColor(theme, tone) }]} />
      <Text
        style={[
          styles.label,
          { color: tone === 'bad' ? theme.destructive : theme.mutedForeground }
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { fontSize: 12, flexShrink: 1 }
})
