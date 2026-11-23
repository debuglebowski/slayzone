import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useHubSessions } from '../hub-sessions'
import { type ChromeColors, useTheme } from '../theme'
import { confirmExitDemo } from '../ui-kit/confirm'

/**
 * Above every tab while the demo is open (`TabStack`): says this is sample data that
 * resets, and leaves the demo (back to the sign-in screen) once the user confirms — what
 * they changed in it is discarded. Nothing outside the demo.
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
      <Text style={styles.text}>Sample data — changes reset when you exit.</Text>
      <Pressable
        testID="exit-demo"
        onPress={() => confirmExitDemo(exitDemo)}
        hitSlop={8}
        style={styles.exit}
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
      // Exit demo's 44pt sets the height.
      paddingVertical: 0,
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
    exit: { minHeight: 44, maxWidth: '35%', justifyContent: 'center' },
    action: { fontSize: 14, fontWeight: '600', color: t.accentForeground }
  })
