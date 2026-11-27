/**
 * The chat's timeline: a virtualised list (only the rows on screen are rendered), newest
 * at the bottom and kept there while the agent writes (an inverted list grows at its
 * bottom; scrolled up, the visible rows stay put). Below the last row, the agent's
 * current step while a turn runs (desktop's `deriveLoadingLabel`). What a rewind / fork /
 * switch left the conversation without stays folded behind its divider until opened.
 *
 * At (or near) the newest row, a change scrolls back to it — a new row, a growing answer
 * stays in view (`autoscrollToTopThreshold`: the inverted list's top is its bottom);
 * scrolled up, the rows in view stay put and a ↓ pill jumps back to the newest. What the
 * user opened stays open when the list recycles a row; a long press on a message offers
 * to copy or share it.
 *
 * Under a floating bar (the phone task page's top bar, `topInset`) the rows scroll under
 * it and the oldest stops below it; how far the list is from its newest row is reported
 * as it scrolls (`onScrollFromNewest`: the page makes its bars compact while the user
 * reads back).
 */
import {
  type ChatTimelineState,
  deriveLoadingLabel,
  type TimelineItem
} from '@slayzone/terminal/reducer'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import type { ChromeColors } from '../theme'
import { BottomSheet } from '../ui-kit/Chrome'
import { codeBlocksOf, copyText, shareText } from './message-text'
import { useThemedStyles } from './styles'
import { TextViewer } from './TextViewer'
import { TimelineRow } from './TimelineRow'
import type { OlderChatHistory } from './useChatSession'
import { ExpandedStore, type TimelineUi, TimelineUiContext } from './timeline-ui'
import { subAgentItems, type TimelineRow as Row, turnRows } from './timeline-rows'
import { TurnActivity } from './TurnActivity'
import { useChatDisplayPrefs } from './chat-display-prefs-file'

/** Within this of the newest row (pt), a change scrolls back to it. */
const FOLLOW_THRESHOLD = 80
/** Scrolled further than this from the newest row, the ↓ pill shows. */
const PILL_OFFSET = 200

const MVCP = { minIndexForVisible: 1, autoscrollToTopThreshold: FOLLOW_THRESHOLD }

export function ChatTimeline({
  state,
  agentName,
  productName,
  hydrating,
  working,
  inFlight = working,
  reconnecting = false,
  emptyText,
  topInset = 0,
  onScrollFromNewest,
  olderHistory,
  loadHistoryRows
}: {
  state: ChatTimelineState
  agentName?: string
  productName?: string
  hydrating: boolean
  /** A turn runs and the agent is not waiting for the user. */
  working: boolean
  /** A turn runs (waiting for the user too): its activity block shows it live. */
  inFlight?: boolean
  /** Not in step with the hub: the turn state is the last known one, so it says so. */
  reconnecting?: boolean
  emptyText: string
  /** How far a bar floating over the list's top reaches into it (pt). */
  topInset?: number
  /** The list scrolled: how far it is from its newest row (pt). */
  onScrollFromNewest?: (offset: number) => void
  olderHistory?: OlderChatHistory | null
  loadHistoryRows?: (rows: readonly number[]) => void
}) {
  const { s, theme } = useThemedStyles(makeStyles)
  const list = useRef<FlatList<Row>>(null)
  const userScrolled = useRef(false)
  const [away, setAway] = useState(false)
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Inverted: the offset grows from the newest row (0) back into the history.
      const offset = e.nativeEvent.contentOffset.y
      const far = offset > PILL_OFFSET
      setAway((prev) => (prev === far ? prev : far))
      onScrollFromNewest?.(offset)
    },
    [onScrollFromNewest]
  )
  const jumpToLatest = useCallback(() => {
    list.current?.scrollToOffset({ offset: 0, animated: true })
    setAway(false)
    onScrollFromNewest?.(0)
  }, [onScrollFromNewest])
  // The message a long press picked: its actions, then (Select text) its own screen.
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [expanded] = useState(() => new ExpandedStore())
  const ui = useMemo<TimelineUi>(
    () => ({ expanded, showMessageActions: setActionsFor }),
    [expanded]
  )
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
    () => turnRows(state.timeline, openBranches, inFlight).reverse(),
    [state.timeline, openBranches, inFlight]
  )
  const [display] = useChatDisplayPrefs()
  const { timeline, childIndex } = state
  const loadSubAgent = useCallback(
    (id: string) => {
      const children = childIndex.get(id)
      if (children?.length) loadHistoryRows?.(children)
    },
    [childIndex, loadHistoryRows]
  )
  const onReachOlder = useCallback(() => {
    if (!userScrolled.current || olderHistory?.loading || olderHistory?.error) return
    userScrolled.current = false
    olderHistory?.load()
  }, [olderHistory])
  // Not keyed on the whole state: a streaming delta changes only `state.live`, which
  // reaches its row through the live store, not through the list.
  const renderRow = useCallback(
    (item: TimelineItem, key: string) => (
      <TimelineRow
        item={item}
        agentName={agentName}
        productName={productName}
        childItems={
          item.kind === 'sub-agent'
            ? subAgentItems({ timeline, childIndex }, item.toolUseId)
            : undefined
        }
        rowKey={key}
        loadSubAgent={loadSubAgent}
        branchOpen={item.kind === 'conversation-branch' && openBranches.has(item.id)}
        onToggleBranch={toggleBranch}
      />
    ),
    [timeline, childIndex, loadSubAgent, openBranches, toggleBranch, agentName, productName]
  )
  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item: row }) =>
      row.turn ? (
        <View>
          {row.turn.hostIsActivity ? null : renderRow(row.item, row.key)}
          <TurnActivity
            turn={row.turn}
            settings={display}
            rowKey={row.key}
            renderEntry={renderRow}
          />
        </View>
      ) : (
        renderRow(row.item, row.key)
      ),
    [renderRow, display]
  )
  // The last row streams: it shows the progress itself.
  const last = rows[0]?.item
  const tailStreaming =
    (last?.kind === 'text' || last?.kind === 'thinking') && last.stream === 'open'
  const label = reconnecting
    ? 'Reconnecting…'
    : working && !tailStreaming
      ? (deriveLoadingLabel(state) ?? 'Working…')
      : null

  if (hydrating) {
    return (
      <View style={s.center} testID="chat-loading">
        <ActivityIndicator accessibilityLabel="Loading chat" color={theme.foreground} />
      </View>
    )
  }
  if (rows.length === 0 && !label && !olderHistory) {
    return (
      <View style={[s.center, { paddingTop: topInset }]}>
        <Text style={s.empty}>{emptyText}</Text>
      </View>
    )
  }
  const code = actionsFor ? codeBlocksOf(actionsFor) : []
  const act = (run: () => void) => () => {
    setActionsFor(null)
    run()
  }
  return (
    <TimelineUiContext.Provider value={ui}>
      <View style={s.flex}>
        <FlatList
          ref={list}
          testID="chat-timeline"
          inverted
          data={rows}
          // The display settings change rows' contents, not the rows.
          extraData={display}
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
          // Inverted, the list's footer is its top: the oldest row stops below the bar.
          ListFooterComponent={
            olderHistory || topInset > 0 ? (
              <View style={{ paddingBottom: topInset }}>
                {olderHistory?.loading ? (
                  <ActivityIndicator accessibilityLabel="Loading earlier messages" />
                ) : olderHistory ? (
                  <Pressable
                    style={s.olderHistory}
                    accessibilityRole="button"
                    onPress={olderHistory.load}
                  >
                    <Text style={s.workingText}>
                      {olderHistory.error
                        ? "Couldn't load earlier messages. Retry"
                        : 'Load earlier messages'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : undefined
          }
          scrollIndicatorInsets={topInset > 0 ? { bottom: topInset } : undefined}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={MVCP}
          onScroll={onScroll}
          onScrollBeginDrag={() => {
            userScrolled.current = true
          }}
          onEndReached={onReachOlder}
          onEndReachedThreshold={0.3}
          scrollEventThrottle={64}
          initialNumToRender={15}
          windowSize={11}
        />
        {away ? (
          <Pressable
            onPress={jumpToLatest}
            style={s.pill}
            accessibilityRole="button"
            accessibilityLabel="Jump to latest"
            hitSlop={8}
            testID="jump-to-latest"
          >
            <Text style={s.pillText}>↓</Text>
          </Pressable>
        ) : null}
      </View>
      <BottomSheet
        visible={actionsFor !== null}
        onClose={() => setActionsFor(null)}
        testID="message-actions"
      >
        <SheetAction label="Copy text" onPress={act(() => copyText(actionsFor ?? ''))} s={s} />
        {code.length > 0 ? (
          <SheetAction label="Copy code" onPress={act(() => copyText(code.join('\n\n')))} s={s} />
        ) : null}
        <SheetAction label="Share…" onPress={act(() => shareText(actionsFor ?? ''))} s={s} />
        <SheetAction label="Select text" onPress={act(() => setReading(actionsFor))} s={s} />
      </BottomSheet>
      <TextViewer
        title="Message"
        text={reading ?? ''}
        visible={reading !== null}
        onClose={() => setReading(null)}
      />
    </TimelineUiContext.Provider>
  )
}

function SheetAction({
  label,
  onPress,
  s
}: {
  label: string
  onPress: () => void
  s: ReturnType<typeof makeStyles>
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={s.sheetRow}>
      <Text style={s.sheetText}>{label}</Text>
    </Pressable>
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
    olderHistory: { alignItems: 'center', padding: 12 },
    workingText: { color: t.mutedForeground, fontSize: 13 },
    flex: { flex: 1 },
    pill: {
      position: 'absolute',
      right: 14,
      bottom: 10,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    pillText: { color: t.foreground, fontSize: 18, fontWeight: '700' },
    sheetRow: {
      minHeight: 44,
      justifyContent: 'center',
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    sheetText: { fontSize: 16, color: t.foreground }
  })
}
