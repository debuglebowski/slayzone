/**
 * Desktop's small task glyphs, drawn with plain views (no SVG in the app): the status
 * icon of a column category (`task-status.ts`: dashed circle backlog, ring unstarted,
 * ring + dot started, filled ✓ completed, ✕ canceled, tray triage), the priority icon
 * (`priority-icon.tsx`: lightning urgent, 3 bars, dashes someday), the agent dot
 * (`TerminalProgressDot`: pulses while running; paused = ❙❙), the subtask ring.
 */
import type { WorkflowCategory } from '@slayzone/workflow'
import { useEffect, useState } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import type { AgentDot as AgentDotKind, CardTag } from '../board/card-model'
import {
  AGENT_DOT_COLORS,
  type ChromeColors,
  PRIORITY_COLORS,
  statusToneColor,
  useTheme
} from '../theme'

export function StatusIcon({
  category,
  tone,
  size = 14
}: {
  category: WorkflowCategory
  tone: string
  size?: number
}) {
  const color = statusToneColor(tone)
  const theme = useTheme()
  const ring = { width: size, height: size, borderRadius: size / 2, borderColor: color }
  const center = { alignItems: 'center' as const, justifyContent: 'center' as const }
  switch (category) {
    case 'triage':
      return (
        <View
          testID="status-icon"
          style={[
            { width: size, height: size, borderRadius: 3, borderWidth: 1.5, borderColor: color }
          ]}
        />
      )
    case 'backlog':
      return (
        <View testID="status-icon" style={[ring, { borderWidth: 1.5, borderStyle: 'dashed' }]} />
      )
    case 'started':
      return (
        <View testID="status-icon" style={[ring, center, { borderWidth: 1.5 }]}>
          <View
            style={{
              width: size * 0.4,
              height: size * 0.4,
              borderRadius: size,
              backgroundColor: color
            }}
          />
        </View>
      )
    case 'completed':
      return (
        <View testID="status-icon" style={[ring, center, { backgroundColor: color }]}>
          <Text
            style={{
              fontSize: size * 0.7,
              lineHeight: size,
              color: theme.background,
              fontWeight: '800'
            }}
          >
            ✓
          </Text>
        </View>
      )
    case 'canceled':
      return (
        <View testID="status-icon" style={[ring, center, { borderWidth: 1.5 }]}>
          <Text style={{ fontSize: size * 0.6, lineHeight: size * 0.8, color, fontWeight: '700' }}>
            ✕
          </Text>
        </View>
      )
    default:
      return <View testID="status-icon" style={[ring, { borderWidth: 1.5 }]} />
  }
}

export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  const theme = useTheme()
  if (priority === 1)
    return (
      <Text
        testID="priority-urgent"
        accessibilityLabel="Urgent"
        style={{
          fontSize: size * 0.85,
          lineHeight: size,
          width: size,
          textAlign: 'center',
          color: PRIORITY_COLORS[1]
        }}
      >
        ⚡
      </Text>
    )
  if (priority >= 5)
    return (
      <View
        testID="priority-someday"
        accessibilityLabel="Someday"
        style={{ width: size, height: size, flexDirection: 'row', gap: 2, alignItems: 'center' }}
      >
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ flex: 1, height: 1.5, backgroundColor: theme.mutedForeground }} />
        ))}
      </View>
    )
  const filled = 5 - priority
  const color = PRIORITY_COLORS[priority]
  const bar = size / 5
  return (
    <View
      testID={`priority-${priority}`}
      style={{
        width: size,
        height: size,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: bar / 2,
        paddingHorizontal: bar / 3
      }}
    >
      {[0.3, 0.6, 0.9].map((h, i) => (
        <View
          key={h}
          style={{
            width: bar,
            height: size * h,
            borderRadius: 1,
            backgroundColor: i < filled ? color : theme.mutedForeground,
            opacity: i < filled ? 1 : 0.25
          }}
        />
      ))}
    </View>
  )
}

const DOT_LABELS: Readonly<Record<AgentDotKind, string>> = {
  attention: 'Waiting for you',
  running: 'Running',
  background: 'Subagents working',
  idle: 'Idle',
  error: 'Error',
  hibernated: 'Paused'
}

export function AgentDot({ kind, size = 9 }: { kind: AgentDotKind; size?: number }) {
  const [pulse] = useState(() => new Animated.Value(1))
  const animated = kind === 'running' || kind === 'attention'
  useEffect(() => {
    if (!animated) return
    // JS driver: a native-driver loop warns whenever its card unmounts mid-frame (a board
    // re-render), and the pulse is one opacity value — nothing for the UI thread to win.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: false })
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [animated, pulse])
  const color = AGENT_DOT_COLORS[kind]
  if (kind === 'hibernated')
    return (
      <Text
        testID="agent-dot-hibernated"
        accessibilityLabel={DOT_LABELS[kind]}
        style={{ fontSize: size, lineHeight: size + 2, color, fontWeight: '800' }}
      >
        ❙❙
      </Text>
    )
  return (
    <Animated.View
      testID={`agent-dot-${kind}`}
      accessibilityLabel={DOT_LABELS[kind]}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        opacity: animated ? pulse : 1
      }}
    />
  )
}

/** "1/2" with a ring filled in quarters (green when all are done). */
export function SubtaskRing({ done, total }: { done: number; total: number }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const complete = done === total
  const tint = complete ? statusToneColor('green') : theme.foreground
  const quarters = complete ? 4 : Math.floor((done / total) * 4)
  const side = (i: number) => (i < quarters ? tint : 'transparent')
  return (
    <View style={styles.ringRow} accessibilityLabel={`${done} of ${total} subtasks done`}>
      <View>
        <View style={[styles.ring, styles.ringTrack]} />
        <View
          style={[
            styles.ring,
            styles.ringFill,
            {
              borderTopColor: side(0),
              borderRightColor: side(1),
              borderBottomColor: side(2),
              borderLeftColor: side(3)
            }
          ]}
        />
      </View>
      <Text style={[styles.ringText, complete && { color: tint }]}>
        {done}/{total}
      </Text>
    </View>
  )
}

/** The first tag as a pill, the rest as overlapping dots (desktop's card). */
export function TagPills({ tags }: { tags: readonly CardTag[] }) {
  const styles = makeStyles(useTheme())
  if (tags.length === 0) return null
  const [first, ...rest] = tags
  return (
    <View style={styles.tags}>
      <View style={[styles.tag, { backgroundColor: first.color }]}>
        <Text style={[styles.tagText, { color: first.textColor }]} numberOfLines={1}>
          {first.name}
        </Text>
      </View>
      {rest.map((t, i) => (
        <View
          key={t.id}
          accessibilityLabel={t.name}
          style={[styles.tagDot, { backgroundColor: t.color, zIndex: 9 - i }]}
        />
      ))}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    ringRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    ring: {
      width: 13,
      height: 13,
      borderRadius: 7,
      borderWidth: 2,
      transform: [{ rotate: '45deg' }]
    },
    ringTrack: { borderColor: t.mutedForeground, opacity: 0.3 },
    ringFill: { position: 'absolute' },
    ringText: { fontSize: 11, color: t.mutedForeground },
    tags: { flexDirection: 'row', alignItems: 'center' },
    tag: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1, maxWidth: 90, zIndex: 10 },
    tagText: { fontSize: 11, fontWeight: '600' },
    tagDot: {
      width: 16,
      height: 16,
      borderRadius: 8,
      marginLeft: -7,
      borderWidth: 2,
      borderColor: t.background
    }
  })
