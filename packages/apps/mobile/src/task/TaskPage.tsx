/**
 * One task, managed entirely from here — desktop's task page.
 *
 * Phone: the page is the conversation. A compact nav bar — ‹ back to the board, the
 * title (one line) with the agent under it ("<provider> · <state>"; a tap opens the
 * agent menu: provider, agent tabs, every action), Start while the agent offers it, and
 * ⓘ, which opens Details / Artifacts as a sheet (`TaskInfoSheet`, its own route: the
 * page stays mounted under it, so a draft, a running terminal or an upload survive) —
 * then the agent, full height (the chat, its controls one model pill in the composer;
 * or the terminal).
 *
 * iPad (`wide`): the header — ‹ back, ⋯ (mark unread, archive, delete), the status icon
 * (tap: change status), the title (edit in place), priority, tags and due date under it
 * — then Agent and Details side by side (Artifacts as a tab of the right pane). A part,
 * once shown, stays mounted while another is shown (hidden: not drawn to touch, not read
 * by VoiceOver); each mounts the first time it is shown.
 *
 * Scopes itself to the task's hub: every read and write goes to the hub that owns it.
 */
import type { HubSession } from '../hub-session'
import { HubScope } from '@slayzone/transport/client'
import { type ReactNode, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { type AgentNav, AgentPanel } from '../agents/AgentPanel'
import { hubTarget } from '../artifacts/hub-rest'
import { ArtifactsScreen } from '../artifacts/ArtifactsScreen'
import { useTaskArtifacts } from '../artifacts/use-task-artifacts'
import { ChatUploadTargetContext } from '../chat/ChatUploadTarget'
import type { HubFeed, TaskRow } from '../hub-board'
import { useFieldSheets } from '../task-edit/TaskFields'
import { useTaskWrites } from '../task-edit/use-task-writes'
import { type ChromeColors, useTheme } from '../theme'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import {
  artifactsLabel,
  DetailsPanel,
  KeptPart,
  PartSegments,
  TaskMenu,
  TaskMenuButton,
  TitleBlock
} from './task-parts'

export type TaskSegment = 'agent' | 'details' | 'artifacts'
export const TASK_SEGMENTS: readonly TaskSegment[] = ['agent', 'details', 'artifacts']
/** The parts of the phone's Details / Artifacts sheet (and the iPad's right pane). */
export type InfoSegment = Exclude<TaskSegment, 'agent'>
export const INFO_SEGMENTS: readonly InfoSegment[] = ['details', 'artifacts']

export interface TaskPageProps {
  row: TaskRow
  /** The feed of the hub that owns the task. */
  feed: HubFeed
  session: HubSession
  showHub: boolean
  /** iPad: Agent and Details side by side. */
  wide: boolean
  /** iPad: the part shown in the right pane (`agent`: Details). */
  segment: TaskSegment
  onSegment: (segment: TaskSegment) => void
  /** Phone: open the Details / Artifacts sheet on that part. */
  onOpenInfo?: (segment: InfoSegment) => void
  /** The agent tab shown; undefined = the main one. */
  agentTabId: string | undefined
  onSelectAgentTab: (tabId: string) => void
  /** Back to the board; absent = no back (an iPad tab). */
  onBack?: () => void
  onDeleted: () => void
  /** A sub-task was tapped. */
  onOpenTask: (taskId: string) => void
  /** An artifact of the Artifacts tab was tapped. */
  onOpenArtifact: (artifactId: string, version: number | null) => void
}

export function TaskPage(props: TaskPageProps) {
  return (
    <HubScope hubId={props.row.hubId}>
      {props.wide ? <WidePage {...props} /> : <PhonePage {...props} />}
    </HubScope>
  )
}

/** Phone: the nav bar, then the agent. */
function PhonePage(props: TaskPageProps) {
  const { row } = props
  const styles = makeStyles(useTheme())
  const uploadTarget = useMemo(() => hubTarget(props.session), [props.session])
  return (
    <View style={styles.screen} testID="task-page">
      <ChatUploadTargetContext.Provider value={uploadTarget}>
        <AgentPanel
          hubId={row.hubId}
          feed={props.feed}
          row={row}
          showHub={props.showHub}
          tabId={props.agentTabId}
          onSelectTab={props.onSelectAgentTab}
          nav={(agent) => <NavBar {...props} agent={agent} />}
        />
      </ChatUploadTargetContext.Provider>
    </View>
  )
}

/** A nav-bar button: 44pt, a glyph in a circle. */
const NAV_BUTTON = 44
/** The nav bar's words grow with Dynamic Type, but not past what one line holds. */
const NAV_MAX_SCALE = 1.3

function NavBar({ row, onBack, onOpenInfo, agent }: TaskPageProps & { agent: AgentNav }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const line = `${agent.provider} · ${agent.status}`
  const project = row.project?.name ?? 'the board'
  return (
    <View style={styles.nav}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${project}`}
          style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}
        >
          <Text style={styles.navGlyph} maxFontSizeMultiplier={NAV_MAX_SCALE}>
            ‹
          </Text>
        </Pressable>
      ) : (
        <View style={styles.navSpacer} />
      )}
      <Pressable
        onPress={agent.openMenu}
        accessibilityRole="button"
        accessibilityLabel={`${row.task.title}, ${line}`}
        accessibilityHint="Opens the agent menu."
        style={({ pressed }) => [styles.navTitle, pressed && styles.pressed]}
      >
        <Text
          testID="task-title"
          style={styles.title}
          numberOfLines={1}
          maxFontSizeMultiplier={NAV_MAX_SCALE}
        >
          {row.task.title}
        </Text>
        <View style={styles.agentLine}>
          {agent.dot ? <AgentDot kind={agent.dot} size={7} /> : null}
          <Text
            testID="task-agent-line"
            style={styles.agentText}
            numberOfLines={1}
            maxFontSizeMultiplier={NAV_MAX_SCALE}
          >
            {line}
          </Text>
          <Text style={styles.agentText} maxFontSizeMultiplier={NAV_MAX_SCALE}>
            ⌄
          </Text>
        </View>
      </Pressable>
      {agent.start ? (
        <Pressable
          onPress={agent.start}
          accessibilityRole="button"
          accessibilityLabel="Start the agent"
          style={({ pressed }) => [styles.start, pressed && styles.pressed]}
        >
          <Text style={styles.startText} maxFontSizeMultiplier={NAV_MAX_SCALE}>
            Start
          </Text>
        </Pressable>
      ) : null}
      {onOpenInfo ? (
        <Pressable
          onPress={() => onOpenInfo('details')}
          accessibilityRole="button"
          accessibilityLabel="Details and artifacts"
          testID="task-info"
          style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}
        >
          <Text style={styles.infoGlyph} maxFontSizeMultiplier={NAV_MAX_SCALE}>
            ⓘ
          </Text>
        </Pressable>
      ) : (
        <View style={styles.navSpacer} />
      )}
    </View>
  )
}

/** iPad: the header, then Agent and Details side by side. */
function WidePage(props: TaskPageProps) {
  const { row, segment, onSegment } = props
  const theme = useTheme()
  const styles = makeStyles(theme)
  const writes = useTaskWrites(row.task)
  const fields = useFieldSheets(row, writes)
  const [menu, setMenu] = useState(false)
  const { artifacts } = useTaskArtifacts(row.task.id)
  const uploadTarget = useMemo(() => hubTarget(props.session), [props.session])
  const shown: InfoSegment = segment === 'artifacts' ? 'artifacts' : 'details'
  // The parts shown so far: each stays mounted from its first showing on.
  const [visited, setVisited] = useState<ReadonlySet<InfoSegment>>(() => new Set([shown]))
  if (!visited.has(shown)) setVisited(new Set([...visited, shown]))

  const kept = (part: InfoSegment, node: ReactNode) =>
    visited.has(part) ? (
      <KeptPart key={part} shown={shown === part} testID={`part-${part}`}>
        {node}
      </KeptPart>
    ) : null

  return (
    <View style={styles.screen} testID="task-page">
      <View style={styles.header}>
        {props.onBack ? (
          <Pressable
            onPress={props.onBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back to the board"
          >
            <Text style={styles.back} numberOfLines={1}>
              ‹ {row.project?.name ?? 'Board'}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.flex} />
        <TaskMenuButton onPress={() => setMenu(true)} />
      </View>
      <TitleBlock
        row={row}
        writes={writes}
        feed={props.feed}
        showHub={props.showHub}
        openField={fields.open}
      />
      {writes.error ? <Text style={styles.error}>{writes.error}</Text> : null}
      <ChatUploadTargetContext.Provider value={uploadTarget}>
        <View style={styles.panes}>
          <View style={[styles.pane, styles.agentPane]} testID="pane-agent">
            <AgentPanel
              hubId={row.hubId}
              feed={props.feed}
              row={{ ...row, task: writes.task }}
              showHub={props.showHub}
              tabId={props.agentTabId}
              onSelectTab={props.onSelectAgentTab}
            />
          </View>
          <View style={[styles.pane, styles.sidePane]} testID="pane-side">
            <PartSegments
              parts={INFO_SEGMENTS}
              shown={shown}
              labelOf={(part) =>
                part === 'details' ? 'Details' : artifactsLabel(artifacts?.length)
              }
              onShow={onSegment}
            />
            <View style={styles.flex}>
              {kept(
                'details',
                <DetailsPanel
                  row={row}
                  feed={props.feed}
                  writes={writes}
                  openField={fields.open}
                  onOpenTask={props.onOpenTask}
                />
              )}
              {kept(
                'artifacts',
                <ArtifactsScreen
                  session={props.session}
                  taskId={row.task.id}
                  layout="list"
                  selected={null}
                  embedded
                  onSelect={(id) => props.onOpenArtifact(id, null)}
                  onSelectVersion={props.onOpenArtifact}
                  onBack={() => onSegment('agent')}
                />
              )}
            </View>
          </View>
        </View>
      </ChatUploadTargetContext.Provider>
      {fields.sheets}
      <TaskMenu
        visible={menu}
        writes={writes}
        columns={row.project?.columns_config}
        onDeleted={props.onDeleted}
        onClose={() => setMenu(false)}
      />
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    flex: { flex: 1 },
    pressed: { opacity: 0.6 },
    nav: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 6,
      minHeight: NAV_BUTTON + 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    navButton: {
      width: NAV_BUTTON,
      height: NAV_BUTTON,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: NAV_BUTTON / 2
    },
    navSpacer: { width: NAV_BUTTON },
    navGlyph: { fontSize: 30, lineHeight: 34, color: t.primary, fontWeight: '400' },
    infoGlyph: { fontSize: 22, color: t.primary },
    navTitle: {
      flex: 1,
      minHeight: NAV_BUTTON,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4
    },
    title: { fontSize: 16, fontWeight: '600', color: t.foreground },
    agentLine: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
    agentText: { flexShrink: 1, fontSize: 12, color: t.mutedForeground },
    start: {
      minHeight: NAV_BUTTON,
      justifyContent: 'center',
      paddingHorizontal: 12
    },
    startText: { fontSize: 15, fontWeight: '600', color: t.primary },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingTop: 6,
      paddingBottom: 4,
      gap: 8
    },
    back: { fontSize: 16, color: t.primary, fontWeight: '500', maxWidth: 240 },
    error: { color: t.destructive, fontSize: 13, paddingHorizontal: 16, paddingBottom: 4 },
    panes: { flex: 1, flexDirection: 'row', gap: 10, padding: 10 },
    pane: {
      backgroundColor: t.surface1,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      overflow: 'hidden'
    },
    agentPane: { flex: 3 },
    sidePane: { flex: 2 }
  })
