/**
 * A turn's work under the row hosting it (desktop's `ActivityTurn` in its answer's
 * footer): the "Activities" summary, opened on a tap to list them; while the turn
 * runs, its latest activity previewed; its sub-agents; the answer's "Done in …". What
 * shows is decided by the shared `activityTurnDisplay` from the user's display
 * settings (`chat-display-prefs.ts`) — this only draws it.
 */
import {
  type ActivityTurn,
  activityTurnDisplay,
  type ChatActivitySettings
} from '@slayzone/terminal/chat-activity'
import { streamKeyOf, type TimelineItem } from '@slayzone/terminal/reducer'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ChromeColors } from '../theme'
import { useThemedStyles } from './styles'
import { useExpanded } from './timeline-ui'

/** An activity's key among its turn's (stable while it streams). */
function entryKey(item: TimelineItem, index: number): string {
  return (
    streamKeyOf(item) ??
    (item.kind === 'tool'
      ? `tool:${item.invocation.id}`
      : item.kind === 'sub-agent'
        ? `sub-agent:${item.toolUseId}`
        : `${item.kind}:${index}`)
  )
}

export function TurnActivity({
  turn,
  settings,
  rowKey,
  renderEntry
}: {
  turn: ActivityTurn
  settings: ChatActivitySettings
  /** The host row's key: what the user opened stays open across recycling. */
  rowKey: string
  /** One of the turn's items as its own row (a tool card, thinking, a sub-agent, the result). */
  renderEntry: (item: TimelineItem, key: string) => ReactNode
}) {
  const { s } = useThemedStyles(makeStyles)
  const [expanded, toggle] = useExpanded(`activity:${rowKey}`, false)
  const { items, showSummary, latest, empty } = activityTurnDisplay(turn, settings, { expanded })
  const result = turn.final && turn.result ? turn.result : null
  if (empty && !result && !turn.continuedBy) return null
  const count = `${items.length} ${items.length === 1 ? 'item' : 'items'}`
  return (
    <View style={s.turn} testID="chat-turn-activity">
      {showSummary && turn.items.length > 0 ? (
        <>
          <Pressable
            onPress={toggle}
            style={s.summary}
            accessibilityRole="button"
            accessibilityLabel={`Activities, ${count}`}
            accessibilityState={{ expanded }}
            testID="chat-activities-toggle"
          >
            <Text style={s.summaryLabel}>Activities</Text>
            <Text style={s.summaryCount}>
              {count} {expanded ? '▾' : '▸'}
            </Text>
          </Pressable>
          {expanded ? (
            <View testID="chat-activities">
              {items.map((item, i) => {
                const key = entryKey(item, i)
                return <View key={key}>{renderEntry(item, key)}</View>
              })}
            </View>
          ) : null}
        </>
      ) : null}
      {latest ? (
        <View testID="chat-activity-latest">{renderEntry(latest, entryKey(latest, -1))}</View>
      ) : null}
      {turn.subAgents.map((item, i) => {
        const key = entryKey(item, i)
        return <View key={key}>{renderEntry(item, key)}</View>
      })}
      {turn.continuedBy ? (
        <Text style={s.note} testID="chat-turn-continued">
          ↳ Kept going with your next message
        </Text>
      ) : null}
      {result ? renderEntry(result, 'result') : null}
    </View>
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    turn: { marginVertical: 2 },
    summary: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 8,
      marginHorizontal: 16,
      marginVertical: 4,
      paddingHorizontal: 12,
      minHeight: 32,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1
    },
    summaryLabel: { color: t.foreground, fontSize: 13, fontWeight: '600' },
    summaryCount: { color: t.mutedForeground, fontSize: 13 },
    note: { color: t.mutedForeground, fontSize: 12, marginHorizontal: 16, marginVertical: 4 }
  })
}
