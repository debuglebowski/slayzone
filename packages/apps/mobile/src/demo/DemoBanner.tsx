import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useHubSessions } from '../hub-sessions'
import { type ChromeColors, useTheme } from '../theme'

/**
 * Above every tab while the demo is open (`TabStack`): says this is sample data that
 * resets, and leaves the demo in one tap (back to the sign-in screen). Nothing outside
 * the demo.
 */
export function DemoBanner() {
  const { demo, exitDemo } = useHubSessions()
  const theme = useTheme()
  if (!demo) return null
  const styles = makeStyles(theme)
  return (
    <View testID="demo-banner" style={styles.banner} accessibilityRole="summary">
      <View style={styles.badge}>
        <Text style={styles.badgeText}>DEMO</Text>
      </View>
      <Text style={styles.text} numberOfLines={2}>
        Sample data — changes reset when you exit.
      </Text>
      <Pressable
        testID="exit-demo"
        onPress={exitDemo}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Exit demo"
      >
        <Text style={styles.action}>Exit demo</Text>
      </Pressable>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: t.accent,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    badge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: t.primary
    },
    badgeText: { fontSize: 11, fontWeight: '700', color: t.primaryForeground, letterSpacing: 0.5 },
    text: { flex: 1, fontSize: 13, color: t.accentForeground },
    action: { fontSize: 14, fontWeight: '600', color: t.accentForeground }
  })
