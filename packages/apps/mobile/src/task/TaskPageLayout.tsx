/**
 * The task page, laid out around its agent (`AgentPanel`'s `phone`):
 *
 * - Top, floating in glass over the content: ‹ back, the title (with its status icon;
 *   a tap shows Details), and the status island (`StatusIsland`: the agent's state,
 *   Stop / Start in it; a tap opens the agent card, `AgentCard` — the agent's controls
 *   and the task's actions). The content scrolls under it, a light fade behind it.
 * - The shown tab: Agent (the chat or the terminal, always mounted), Details (the title
 *   block, then desktop's Settings panel), Artifacts (the task's list). Details and
 *   Artifacts mount the first time they show and stay mounted (an edit, an upload
 *   survive).
 * - Bottom: the tab bar (`TaskTabBar`) — a chat's composer floats on it as its
 *   accessory (same width, same glass). While the user reads back in the chat, the bars
 *   go compact: the title steps aside, the island and back shrink, the tab bar becomes
 *   one button with the composer beside it; back at the newest message (or a tap on
 *   that button) they come back. With the keyboard up the tab bar hides and the
 *   composer sits on the keyboard.
 *
 * The page's floating chrome reaches its content through `TaskChromeProvider`.
 */
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentNav } from '../agents/AgentPanel'
import { ArtifactsScreen } from '../artifacts/ArtifactsScreen'
import { useTaskArtifacts } from '../artifacts/use-task-artifacts'
import { statusCategoryOf } from '../board/card-model'
import { useStableCallback } from '../chat/useStableCallback'
import type { useFieldSheets } from '../task-edit/TaskFields'
import type { TaskWrites } from '../task-edit/use-task-writes'
import { type ChromeColors, useTheme } from '../theme'
import { useKeyboardUp } from '../ui-kit/Chrome'
import { Glass } from '../ui-kit/Glass'
import { StatusIcon } from '../ui-kit/TaskGlyphs'
import { AgentCard } from './AgentCard'
import { StatusIsland } from './StatusIsland'
import { ChromeInsets, type TaskChrome, TaskChromeProvider } from './task-chrome'
import {
  artifactsLabel,
  DetailsPanel,
  KeptPart,
  PartSegments,
  TaskMenu,
  TaskMenuButton,
  TitleBlock,
  useTaskMenuItems
} from './task-parts'
import { TAB_BAR_HEIGHT, TAB_BUTTON_SIZE, TaskTabBar } from './TaskTabBar'
import type { TaskPageProps, TaskSegment } from './TaskPage'

const INFO_SEGMENTS = ['details', 'artifacts'] as const

/** The top bar: its buttons (44pt; compact 32pt) with room above and below. */
const TOP_BUTTON = 44
const TOP_BUTTON_COMPACT = 32
const TOP_ABOVE = 4
const TOP_BELOW = 8
/** The bottom chrome's distance from the screen's sides and from the bottom. */
const SIDE = 16
const BOTTOM = 4
/** Between the composer and the tab bar (and the compact button). */
const GAP = 8
/** The composer's capsule height (`Composer`'s floating input row). */
const COMPOSER_HEIGHT = 50

/** Reading back further than this from the newest message, the bars go compact. */
const COMPACT_FROM = 160
/** Within this of the newest message, or back towards it by this much, they come back. */
const EXPAND_WITHIN = 40
const EXPAND_BACK = 240

/** The words in the top bar grow with Dynamic Type, but not past what one line holds. */
const MAX_SCALE = 1.3

export function TaskPageLayout({
  page,
  agent,
  body,
  writes,
  fields
}: {
  page: TaskPageProps
  agent: AgentNav | undefined
  /** The agent's body (the chat or the terminal): kept mounted whatever tab shows. */
  body: ReactNode
  writes: TaskWrites
  fields: ReturnType<typeof useFieldSheets>
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const { row, segment, onSegment, wide } = page
  const shown = wide && segment === 'agent' ? 'details' : segment
  const keyboardUp = useKeyboardUp()
  const [compactWanted, setCompact] = useState(false)
  const [card, setCard] = useState(false)
  const [menu, setMenu] = useState(false)
  const { artifacts } = useTaskArtifacts(row.task.id)
  const taskItems = useTaskMenuItems(writes, row.project?.columns_config, page.onDeleted)

  // Where the chat's timeline was, read in its scroll handler only.
  const scroll = useRef({ last: 0, mark: 0 })
  const onTimelineScroll = useStableCallback((offset: number) => {
    const s = scroll.current
    if (offset <= EXPAND_WITHIN) {
      s.mark = offset
      setCompact(false)
    } else if (offset > s.last && offset > COMPACT_FROM) {
      s.mark = offset
      setCompact(true)
    } else if (offset < s.mark - EXPAND_BACK) {
      s.mark = offset
      setCompact(false)
    }
    s.last = offset
  })

  // The tabs shown so far: each stays mounted from its first showing on (Agent always).
  const [visited, setVisited] = useState<ReadonlySet<TaskSegment>>(() => new Set([shown]))
  if (!visited.has(shown)) setVisited(new Set([...visited, shown]))

  const compact = !wide && compactWanted && segment === 'agent' && !keyboardUp
  const topButton = compact ? TOP_BUTTON_COMPACT : TOP_BUTTON
  const top = TOP_ABOVE + topButton + TOP_BELOW
  const barHeight = compact ? TAB_BUTTON_SIZE : TAB_BAR_HEIGHT
  const chrome = useMemo<TaskChrome>(
    () => ({
      top,
      bottom: keyboardUp ? 0 : BOTTOM + barHeight + GAP,
      composer: keyboardUp
        ? { bottom: 0, start: GAP, end: GAP }
        : compact
          ? {
              bottom: BOTTOM + (TAB_BUTTON_SIZE - COMPOSER_HEIGHT) / 2,
              start: SIDE + TAB_BUTTON_SIZE + GAP,
              end: SIDE
            }
          : { bottom: BOTTOM + TAB_BAR_HEIGHT + GAP, start: SIDE, end: SIDE },
      keyboardUp,
      onTimelineScroll
    }),
    [top, keyboardUp, barHeight, compact, onTimelineScroll]
  )

  const look = statusCategoryOf(writes.task.status, row.project)
  const backDestination = page.backDestination ?? row.project?.name ?? 'the board'
  const show = (tab: TaskSegment) => {
    setCompact(false)
    onSegment(tab)
  }

  const kept = (part: Exclude<TaskSegment, 'agent'>, node: ReactNode) =>
    visited.has(part) ? (
      <KeptPart key={part} shown={shown === part} testID={`part-${part}`}>
        {node}
      </KeptPart>
    ) : null

  return (
    <View style={styles.screen}>
      <TaskChromeProvider value={wide ? null : chrome}>
        {wide ? (
          <>
            <View style={styles.wideHeader}>
              {page.onBack ? (
                <Pressable
                  onPress={page.onBack}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Back to ${page.backDestination ?? 'the board'}`}
                >
                  <Text style={styles.wideBack} numberOfLines={1}>
                    ‹ {page.backDestination ?? row.project?.name ?? 'Board'}
                  </Text>
                </Pressable>
              ) : null}
              <View style={styles.flex} />
              <TaskMenuButton onPress={() => setMenu(true)} />
            </View>
            <TitleBlock
              row={row}
              writes={writes}
              feed={page.feed}
              showHub={page.showHub}
              openField={fields.open}
            />
            {writes.error ? <Text style={styles.error}>{writes.error}</Text> : null}
          </>
        ) : null}
        <View style={wide ? styles.widePanes : styles.flex}>
          <View
            style={wide ? [styles.widePane, styles.wideAgent] : styles.flex}
            testID={wide ? 'pane-agent' : undefined}
          >
            <KeptPart shown={wide || segment === 'agent'} testID="part-agent">
              {body}
            </KeptPart>
          </View>
          <View
            style={wide ? [styles.widePane, styles.wideSide] : StyleSheet.absoluteFill}
            pointerEvents="box-none"
            testID={wide ? 'pane-side' : undefined}
          >
            {wide ? (
              <PartSegments
                parts={INFO_SEGMENTS}
                shown={segment === 'artifacts' ? 'artifacts' : 'details'}
                labelOf={(part) =>
                  part === 'details' ? 'Details' : artifactsLabel(artifacts?.length)
                }
                onShow={show}
              />
            ) : null}
            <View style={styles.flex} pointerEvents="box-none">
              {kept(
                'details',
                <DetailsPanel
                  row={row}
                  feed={page.feed}
                  writes={writes}
                  openField={fields.open}
                  onOpenTask={page.onOpenTask}
                  {...(wide
                    ? {}
                    : {
                        insets: { top, bottom: chrome.bottom },
                        header: (
                          <TitleBlock
                            row={row}
                            writes={writes}
                            feed={page.feed}
                            showHub={page.showHub}
                            openField={fields.open}
                            flush
                          />
                        )
                      })}
                />
              )}
              {kept(
                'artifacts',
                <ChromeInsets>
                  <ArtifactsScreen
                    session={page.session}
                    taskId={row.task.id}
                    layout="list"
                    selected={null}
                    embedded
                    onSelect={(id) => page.onOpenArtifact(id, null)}
                    onSelectVersion={page.onOpenArtifact}
                    onBack={() => show('agent')}
                  />
                </ChromeInsets>
              )}
            </View>
          </View>
        </View>
      </TaskChromeProvider>

      {wide ? (
        <TaskMenu
          visible={menu}
          writes={writes}
          columns={row.project?.columns_config}
          onDeleted={page.onDeleted}
          onClose={() => setMenu(false)}
        />
      ) : agent ? (
        <>
          <View style={styles.top} pointerEvents="box-none">
            <EdgeFade height={top + GAP} color={theme.background} />
            <View style={[styles.topRow, { height: top }]} pointerEvents="box-none">
              {page.onBack ? (
                <Glass
                  interactive
                  style={[
                    styles.round,
                    { width: topButton, height: topButton, borderRadius: topButton / 2 }
                  ]}
                >
                  <Pressable
                    onPress={page.onBack}
                    accessibilityRole="button"
                    accessibilityLabel={`Back to ${backDestination}`}
                    hitSlop={compact ? 6 : 0}
                    style={({ pressed }) => [styles.fill, pressed && styles.pressed]}
                  >
                    <Text
                      style={[styles.backGlyph, compact && styles.backGlyphCompact]}
                      maxFontSizeMultiplier={MAX_SCALE}
                    >
                      ‹
                    </Text>
                  </Pressable>
                </Glass>
              ) : null}
              {compact ? (
                <View style={styles.flex} />
              ) : (
                <Glass interactive style={styles.title}>
                  <Pressable
                    onPress={() => show('details')}
                    accessibilityRole="button"
                    accessibilityLabel={writes.task.title}
                    accessibilityHint="Shows the task’s details."
                    style={({ pressed }) => [styles.titleInner, pressed && styles.pressed]}
                  >
                    <StatusIcon category={look.category} tone={look.tone} size={15} />
                    <Text
                      testID="task-title"
                      style={styles.titleText}
                      numberOfLines={1}
                      maxFontSizeMultiplier={MAX_SCALE}
                    >
                      {writes.task.title}
                    </Text>
                  </Pressable>
                </Glass>
              )}
              <StatusIsland agent={agent} compact={compact} onOpen={() => setCard(true)} />
            </View>
            {agent.problems ? <View style={styles.problems}>{agent.problems}</View> : null}
            {writes.error ? <Text style={styles.error}>{writes.error}</Text> : null}
          </View>

          {keyboardUp ? null : (
            <View style={styles.bottom} pointerEvents="box-none">
              <TaskTabBar
                shown={segment}
                onShow={show}
                compact={compact}
                onExpand={() => setCompact(false)}
                artifacts={artifacts?.length}
                agentNeedsYou={agent.waiting || agent.dot === 'attention'}
              />
            </View>
          )}

          <AgentCard
            visible={card}
            agent={agent}
            taskItems={taskItems}
            onClose={() => setCard(false)}
          />
        </>
      ) : null}
    </View>
  )
}

/** Bands of the background, fading out downwards: the top bar reads over any content. */
const FADE_BANDS = [0.85, 0.7, 0.55, 0.4, 0.28, 0.17, 0.08, 0.02]

function EdgeFade({ height, color }: { height: number; color: string }) {
  const band = height / FADE_BANDS.length
  return (
    <View style={[StyleSheet.absoluteFill, { height }]} pointerEvents="none">
      {FADE_BANDS.map((opacity) => (
        <View key={opacity} style={{ height: band, backgroundColor: color, opacity }} />
      ))}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    wideHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingTop: 6,
      paddingBottom: 4,
      gap: 8
    },
    wideBack: { fontSize: 16, color: t.primary, fontWeight: '500', maxWidth: 240 },
    widePanes: { flex: 1, flexDirection: 'row', gap: 10, padding: 10 },
    widePane: {
      backgroundColor: t.surface1,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      overflow: 'hidden'
    },
    wideAgent: { flex: 3 },
    wideSide: { flex: 2 },
    flex: { flex: 1 },
    fill: { width: '100%', flex: 1, alignItems: 'center', justifyContent: 'center' },
    pressed: { opacity: 0.6 },
    top: { position: 'absolute', top: 0, left: 0, right: 0 },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: SIDE,
      paddingTop: TOP_ABOVE,
      paddingBottom: TOP_BELOW
    },
    round: { alignItems: 'center', justifyContent: 'center' },
    backGlyph: { fontSize: 30, lineHeight: 34, color: t.foreground, marginTop: -3 },
    backGlyphCompact: { fontSize: 22, lineHeight: 26, color: t.mutedForeground },
    title: { flex: 1, height: TOP_BUTTON, borderRadius: TOP_BUTTON / 2 },
    titleInner: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14
    },
    titleText: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: t.foreground },
    problems: { backgroundColor: t.background, paddingTop: 4 },
    error: {
      color: t.destructive,
      fontSize: 13,
      paddingHorizontal: 16,
      paddingVertical: 4,
      backgroundColor: t.background
    },
    bottom: { position: 'absolute', left: SIDE, right: SIDE, bottom: BOTTOM }
  })
