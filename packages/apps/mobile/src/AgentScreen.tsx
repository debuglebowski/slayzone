import { Pressable, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from './theme'

/**
 * An agent session, `/agent/<hub address>/<session id>`. A placeholder: the live
 * terminal and chat of an agent come with the agents phase.
 */
export function AgentScreen({ hubAddress, onBack }: { hubAddress: string; onBack: () => void }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>‹ Home</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>Agent sessions on {hubAddress} will open here.</Text>
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
