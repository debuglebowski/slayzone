/**
 * The phone task page's tab bar: Agent · Details · Artifacts (with how many), in iOS 26's
 * floating glass capsule at the bottom — the app's own tab bar is hidden on the task
 * page. The Agent tab carries an amber dot while the agent needs the user and another
 * tab shows. Compact (the user reads back in the chat) it is one round button showing
 * the shown tab: a tap brings the whole bar back.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import { Glass } from '../ui-kit/Glass'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import type { TaskSegment } from './TaskPage'

/** The bar's height, and the compact button's. */
export const TAB_BAR_HEIGHT = 62
export const TAB_BUTTON_SIZE = 54

/** The tabs' words grow with Dynamic Type, but not past what the bar holds. */
const MAX_SCALE = 1.2

const TABS: readonly TaskSegment[] = ['agent', 'details', 'artifacts']

export function TaskTabBar({
  shown,
  onShow,
  compact,
  onExpand,
  artifacts,
  agentNeedsYou
}: {
  shown: TaskSegment
  onShow: (tab: TaskSegment) => void
  compact?: boolean
  /** Compact: the button was tapped — show the whole bar. */
  onExpand?: () => void
  /** How many artifacts the task has (undefined: not loaded). */
  artifacts?: number
  /** The agent needs the user (its dot is amber): marked on the Agent tab. */
  agentNeedsYou?: boolean
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const label = (tab: TaskSegment) =>
    tab === 'agent'
      ? 'Agent'
      : tab === 'details'
        ? 'Details'
        : artifacts
          ? `Artifacts ${artifacts}`
          : 'Artifacts'
  if (compact) {
    return (
      <Glass key="compact" interactive style={styles.button}>
        <Pressable
          onPress={onExpand}
          accessibilityRole="button"
          accessibilityLabel={`${label(shown)}. Show the tabs`}
          testID="task-tabs-compact"
          style={styles.fill}
        >
          <TabIcon tab={shown} on s={styles} />
        </Pressable>
      </Glass>
    )
  }
  return (
    <Glass key="full" style={styles.bar} testID="task-tabs">
      <View style={styles.row} accessibilityRole="tablist">
        {TABS.map((tab) => {
          const on = tab === shown
          return (
            <Pressable
              key={tab}
              onPress={() => onShow(tab)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={
                tab === 'agent' && agentNeedsYou ? `${label(tab)}, needs you` : label(tab)
              }
              testID={`tab-${tab}`}
              style={[styles.tab, on && styles.tabOn]}
            >
              <View>
                <TabIcon tab={tab} on={on} s={styles} />
                {tab === 'agent' && agentNeedsYou && !on ? (
                  <View style={styles.badge}>
                    <AgentDot kind="attention" size={8} />
                  </View>
                ) : null}
              </View>
              <Text
                style={[styles.label, on && styles.labelOn]}
                numberOfLines={1}
                maxFontSizeMultiplier={MAX_SCALE}
              >
                {label(tab)}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </Glass>
  )
}

/** A tab's glyph, drawn: a speech bubble (Agent), a list (Details), a page (Artifacts). */
function TabIcon({
  tab,
  on,
  s
}: {
  tab: TaskSegment
  on: boolean
  s: ReturnType<typeof makeStyles>
}) {
  const ink = on ? s.inkOn : s.ink
  if (tab === 'agent')
    return (
      <View style={s.icon} accessible={false}>
        <View style={[ink, s.bubble]} />
      </View>
    )
  if (tab === 'details')
    return (
      <View style={[s.icon, s.listIcon]} accessible={false}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={s.listRow}>
            <View style={[s.listDot, ink]} />
            <View style={[s.listLine, ink]} />
          </View>
        ))}
      </View>
    )
  return (
    <View style={s.icon} accessible={false}>
      <View style={[ink, s.page]} />
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    bar: { width: '100%', height: TAB_BAR_HEIGHT, borderRadius: TAB_BAR_HEIGHT / 2, padding: 4 },
    row: { flex: 1, flexDirection: 'row' },
    tab: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
      borderRadius: (TAB_BAR_HEIGHT - 8) / 2
    },
    tabOn: { backgroundColor: t.accent },
    label: { fontSize: 10, fontWeight: '600', color: t.mutedForeground },
    labelOn: { color: t.foreground },
    button: {
      alignSelf: 'flex-start',
      width: TAB_BUTTON_SIZE,
      height: TAB_BUTTON_SIZE,
      borderRadius: TAB_BUTTON_SIZE / 2
    },
    fill: { width: '100%', flex: 1, alignItems: 'center', justifyContent: 'center' },
    badge: { position: 'absolute', top: -2, right: -6 },
    icon: { width: 24, height: 22, alignItems: 'center', justifyContent: 'center' },
    ink: { borderColor: t.mutedForeground, backgroundColor: t.mutedForeground },
    inkOn: { borderColor: t.foreground, backgroundColor: t.foreground },
    bubble: {
      width: 20,
      height: 15,
      borderRadius: 5,
      borderWidth: 1.8,
      backgroundColor: 'transparent'
    },
    listIcon: { gap: 3 },
    listRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    listDot: { width: 3, height: 3, borderRadius: 1.5 },
    listLine: { width: 13, height: 1.8, borderRadius: 1 },
    page: {
      width: 14,
      height: 18,
      borderRadius: 3,
      borderWidth: 1.8,
      backgroundColor: 'transparent'
    }
  })
