import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { HubProblem } from './hub-board'
import { type ChromeColors, useTheme } from './theme'

/**
 * What is wrong with one hub, above the list: it can't be reached, it is still
 * connecting, or it refused the board. Always with Retry and Sign out — a hub that is
 * gone for good must not trap the user (the other hubs' rows stay in the list).
 */
export function HubBanner({
  problem,
  onRetry,
  onSignOut
}: {
  problem: HubProblem
  onRetry: () => void
  onSignOut: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { title, detail } = describe(problem)
  return (
    <View
      testID={`hub-banner-${problem.hub.id}`}
      style={[styles.banner, problem.kind === 'connecting' ? null : styles.bannerBad]}
    >
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button">
        <Text style={styles.action}>Retry</Text>
      </Pressable>
      <Pressable onPress={onSignOut} hitSlop={8} accessibilityRole="button">
        <Text style={styles.action}>Sign out</Text>
      </Pressable>
    </View>
  )
}

function describe(problem: HubProblem): { title: string; detail: string | null } {
  const name = problem.hub.label
  switch (problem.kind) {
    case 'connecting':
      return { title: `Connecting to ${name}…`, detail: null }
    case 'unreachable':
      return { title: `Can't reach ${name}`, detail: problem.detail }
    case 'failed':
      return { title: name, detail: problem.message }
  }
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: t.muted,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    bannerBad: { borderLeftWidth: 3, borderLeftColor: t.destructive },
    text: { flex: 1 },
    title: { fontSize: 14, fontWeight: '600', color: t.foreground },
    detail: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    action: { fontSize: 14, fontWeight: '500', color: t.foreground }
  })
