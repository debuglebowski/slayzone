/**
 * The chat's timeline: a virtualised list (only the rows on screen are rendered), newest
 * at the bottom and kept there while the agent writes (an inverted list grows at its
 * bottom; scrolled up, the visible rows stay put). Below the last row, the agent's
 * current step while a turn runs (desktop's `deriveLoadingLabel`). What a rewind / fork /
 * switch left the conversation without stays folded behind its divider until opened.
 */
import { type ChatTimelineState, deriveLoadingLabel } from '@slayzone/terminal/reducer'
import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItem,
  StyleSheet,
  Text,
  View
} from 'react-native'
import type { ChromeColors } from '../theme'
import { useThemedStyles } from './styles'
import { TimelineRow } from './TimelineRow'
import { subAgentItems, type TimelineRow as Row, timelineRows } from './timeline-rows'

export function ChatTimeline({
  state,
  hydrating,
  working,
  emptyText
}: {
  state: ChatTimelineState
  hydrating: boolean
  /** A turn runs and the agent is not waiting for the user. */
  working: boolean
  emptyText: string
}) {
  const { s, theme } = useThemedStyles(makeStyles)
  const [openBranches, setOpenBranches] = useState<ReadonlySet<string>>(() => new Set())
  const toggleBranch = useCallback((id: string) => {
    setOpenBranches((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const rows = useMemo(
    () => timelineRows(state.timeline, openBranches).reverse(),
    [state.timeline, openBranches]
  )
  const { timeline, childIndex } = state
  // Not keyed on the whole state: a streaming delta changes only `state.live`, which
  // reaches its row through the live store, not through the list.
  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => (
      <TimelineRow
        item={item.item}
        childItems={
          item.item.kind === 'sub-agent'
            ? subAgentItems({ timeline, childIndex }, item.item.toolUseId)
            : undefined
        }
        branchOpen={item.item.kind === 'conversation-branch' && openBranches.has(item.item.id)}
        onToggleBranch={toggleBranch}
      />
    ),
    [timeline, childIndex, openBranches, toggleBranch]
  )
  // The last row streams: it shows the progress itself.
  const last = rows[0]?.item
  const tailStreaming =
    (last?.kind === 'text' || last?.kind === 'thinking') && last.stream === 'open'
  const label = working && !tailStreaming ? (deriveLoadingLabel(state) ?? 'Working…') : null

  if (hydrating) {
    return (
      <View style={s.center} testID="chat-loading">
        <ActivityIndicator color={theme.foreground} />
      </View>
    )
  }
  if (rows.length === 0 && !label) {
    return (
      <View style={s.center}>
        <Text style={s.empty}>{emptyText}</Text>
      </View>
    )
  }
  return (
    <FlatList
      testID="chat-timeline"
      inverted
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={renderItem}
      ListHeaderComponent={
        label ? (
          <View style={s.working} testID="chat-working">
            <ActivityIndicator size="small" color={theme.mutedForeground} />
            <Text style={s.workingText}>{label}</Text>
          </View>
        ) : undefined
      }
      contentContainerStyle={s.content}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      initialNumToRender={15}
      windowSize={11}
    />
  )
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    empty: { color: t.mutedForeground, textAlign: 'center' },
    content: { paddingVertical: 8 },
    working: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 16,
      marginVertical: 8
    },
    workingText: { color: t.mutedForeground, fontSize: 13 }
  })
}
