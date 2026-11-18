/**
 * The phone task page's status island: the agent's state in one glass capsule at the
 * top right — its dot (a spinner while an action runs or the state loads) and its state
 * in desktop's words ("Active", "Idle" …; "Needs you" while a chat waits for an answer)
 * — with what to do about it right in it: Stop (asks first) while the agent works,
 * Start while it can start. A tap on the rest opens the agent card (`AgentCard`).
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentNav } from '../agents/AgentPanel'
import { type ChromeColors, useTheme } from '../theme'
import { Glass } from '../ui-kit/Glass'
import { AgentDot } from '../ui-kit/TaskGlyphs'

/** The island's words grow with Dynamic Type, but not past what the top bar holds. */
const MAX_SCALE = 1.3

export function StatusIsland({
  agent,
  compact,
  onOpen
}: {
  agent: AgentNav
  /** The top bar is compact (the user reads back): a smaller island. */
  compact: boolean
  onOpen: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const label = agent.waiting ? 'Needs you' : agent.stateLabel
  const height = compact ? COMPACT : FULL
  return (
    <Glass interactive style={[styles.island, { height, borderRadius: height / 2 }]}>
      <Pressable
        onPress={() => {
          agent.onOpen()
          onOpen()
        }}
        accessibilityRole="button"
        accessibilityLabel={`${agent.provider}: ${agent.waiting ? 'needs you' : agent.status}`}
        accessibilityHint="Opens the agent’s controls and the task’s actions."
        testID="status-island"
        style={({ pressed }) => [styles.state, pressed && styles.pressed]}
      >
        {agent.busy ? (
          <ActivityIndicator size="small" color={theme.mutedForeground} />
        ) : agent.dot ? (
          <AgentDot kind={agent.waiting ? 'attention' : agent.dot} size={8} />
        ) : (
          <View style={styles.noDot} />
        )}
        <Text
          style={[styles.label, agent.waiting && styles.waiting, compact && styles.labelCompact]}
          numberOfLines={1}
          maxFontSizeMultiplier={MAX_SCALE}
          testID="status-island-label"
        >
          {label}
        </Text>
      </Pressable>
      {agent.stop ? (
        <Pressable
          onPress={agent.stop}
          accessibilityRole="button"
          accessibilityLabel="Stop the agent"
          hitSlop={6}
          style={({ pressed }) => [
            styles.stop,
            compact && styles.stopCompact,
            pressed && styles.pressed
          ]}
        >
          <View style={styles.stopGlyph} />
        </Pressable>
      ) : agent.start ? (
        <Pressable
          onPress={agent.start}
          accessibilityRole="button"
          accessibilityLabel="Start the agent"
          hitSlop={6}
          style={({ pressed }) => [styles.start, pressed && styles.pressed]}
        >
          <Text style={styles.startText} maxFontSizeMultiplier={MAX_SCALE}>
            Start
          </Text>
        </Pressable>
      ) : null}
    </Glass>
  )
}

/** The island's height: beside the 44pt back button, and compact. */
const FULL = 44
const COMPACT = 32

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    island: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingRight: 4,
      maxWidth: 190,
      overflow: 'hidden'
    },
    state: {
      flexShrink: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      alignSelf: 'stretch',
      paddingLeft: 13,
      paddingRight: 8
    },
    pressed: { opacity: 0.6 },
    noDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.muted },
    label: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: t.foreground },
    labelCompact: { fontSize: 12 },
    waiting: { color: t.warningForeground },
    stop: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.destructive
    },
    stopCompact: { width: 24, height: 24, borderRadius: 12 },
    stopGlyph: { width: 9, height: 9, borderRadius: 2, backgroundColor: t.background },
    start: {
      height: 30,
      justifyContent: 'center',
      paddingHorizontal: 12,
      borderRadius: 15,
      backgroundColor: t.primary
    },
    startText: { fontSize: 13, fontWeight: '600', color: t.primaryForeground }
  })
