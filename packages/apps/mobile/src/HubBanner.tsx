import { Pressable, StyleSheet, Text, View } from 'react-native'
import { type HubFeed, type HubProblem, hubProblem } from './hub-board'
import { type ChromeColors, useTheme } from './theme'
import { confirmSignOut } from './ui-kit/confirm'

/**
 * A banner for every hub with a problem (`HubBanner`), in sign-in order; none while all
 * are fine. The tabs that list hub data put it under their header (Agents, Tasks).
 */
export function HubBanners({
  feeds,
  onRetry,
  onSignOut
}: {
  feeds: readonly HubFeed[]
  onRetry: (hubId: string) => void
  onSignOut: (hubId: string) => void
}) {
  return feeds.map((feed) => {
    const problem = hubProblem(feed)
    return problem ? (
      <HubBanner
        key={problem.hub.id}
        problem={problem}
        onRetry={() => onRetry(problem.hub.id)}
        onSignOut={() => onSignOut(problem.hub.id)}
      />
    ) : null
  })
}

/**
 * What is wrong with one hub, above the list: it can't be reached, it is still
 * connecting, or it refused the board. Always with Retry and Sign out — a hub that is
 * gone for good must not trap the user (the other hubs' rows stay in the list). Sign out
 * is set apart (red) and asks first: a thumb aiming at Retry must not wipe the hub.
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
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={`Retry ${problem.hub.label}`}
      >
        <Text style={styles.action}>Retry</Text>
      </Pressable>
      <Pressable
        onPress={() => confirmSignOut(problem.hub.label, onSignOut)}
        hitSlop={8}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={`Sign out of ${problem.hub.label}`}
      >
        <Text style={styles.signOut}>Sign out</Text>
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
      // The 44pt buttons set the height; a little more around a two-line detail.
      paddingVertical: 4,
      backgroundColor: t.muted,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    bannerBad: { borderLeftWidth: 3, borderLeftColor: t.destructive },
    text: { flex: 1 },
    title: { fontSize: 14, fontWeight: '600', color: t.foreground },
    detail: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    button: { minHeight: 44, justifyContent: 'center' },
    action: { fontSize: 14, fontWeight: '600', color: t.foreground },
    signOut: { fontSize: 14, fontWeight: '400', color: t.destructive }
  })
