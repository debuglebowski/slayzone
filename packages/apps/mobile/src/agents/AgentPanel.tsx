/**
 * A task's agents — the Agent panel of the task page (desktop's Agent panel): the
 * task's terminal tabs (`taskTerminals.list`, live via `taskTerminals.onChanged`;
 * the main tab is created when the task has none yet, as desktop does on open), the
 * selected tab's agent — a chat tab in the chat view (`ChatSession`), any other in
 * the terminal (`TerminalView`) — its state, and what can be done with it (Start,
 * Interrupt, Stop, Restart, Reset, provider; `lifecycle.ts`; destructive ones ask
 * first; a failed one says what failed and offers Retry). Interrupt and Stop are up
 * front only while the agent works; idle, they are under ⋯ with the rest. A terminal's
 * ⋯ also shares its text and switches its text size. Until the hub's agent states are
 * in, it says it is loading (never "Not started" and Start for an agent that runs).
 * Opening it marks the task read, as opening it on desktop does — once per opening
 * (`openingKey`, `opening-reads.ts`), so "Mark as unread" survives a remount.
 *
 * Rendered inside the HubScope of the hub that owns the task (`feed`'s hub): every
 * call here goes to that hub.
 */
import type { HubFeed, TaskRow } from '../hub-board'
import {
  getModeLabel,
  getTabLabel,
  numberDuplicateLabels
} from '@slayzone/task-terminals/tab-label'
import {
  isAliveTerminalState,
  isChatSupported,
  type TerminalState
} from '@slayzone/terminal-contracts'
import { computerName } from '@slayzone/computers/labels'
import { workComputerId } from '@slayzone/projects-contracts/placements'
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { ChatSession } from '../chat'
import { useHubComputers } from '../computers/use-hub-computers'
import { TerminalView, type TerminalViewHandle } from '../terminal/TerminalView'
import { type ChromeColors, useTheme } from '../theme'
import { type RouterOutputs, useTRPC, useTRPCClient } from '../trpc'
import { agentDotOf } from '../board/card-model'
import { BottomSheet } from '../ui-kit/Chrome'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import { agentStateLabel } from './agent-status'
import { sessionIdOf } from './hub-agents'
import { claimOpening } from './opening-reads'
import { AGENT_SNAPSHOT_QUERY_KEY } from './use-hub-agent-sessions'
import {
  type AgentTarget,
  interruptAgent,
  isMainTab,
  resetAgent,
  restartAgent,
  startAgent,
  stopAgent,
  switchAgentMode
} from './lifecycle'

export interface AgentPanelProps {
  hubId: string
  /** The feed of the hub that owns the task. */
  feed: HubFeed
  row: TaskRow
  /** Several hubs are signed in: say which one this is. */
  showHub: boolean
  /** The tab to show; undefined = the main tab. */
  tabId: string | undefined
  onSelectTab: (tabId: string) => void
  /**
   * Names this opening of the task (stable while the page that opened it stays open):
   * the task is marked read once per opening, however often the panel remounts.
   * Omitted: once per mount.
   */
  openingKey?: string
}

/** A tab as `taskTerminals.list` returns it. */
type Tab = RouterOutputs['taskTerminals']['list'][number]

/**
 * Counts the times the session came back after it had ended (restart, reset, a
 * resumed hibernation): each is a new process whose output starts over, so the
 * terminal is mounted afresh.
 */
function useRestarts(state: TerminalState | undefined): number {
  const [restarts, setRestarts] = useState(0)
  const [previous, setPrevious] = useState(state)
  if (state !== previous) {
    setPrevious(state)
    if (state && isAliveTerminalState(state) && (previous === 'dead' || previous === 'hibernated'))
      setRestarts((n) => n + 1)
  }
  return restarts
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** What failed, in the user's words, by action. */
const FAILED: Readonly<Record<string, string>> = {
  Start: 'Couldn’t start the agent.',
  Stop: 'Couldn’t stop the agent.',
  Interrupt: 'Couldn’t interrupt the agent.',
  Restart: 'Couldn’t restart the agent.',
  Reset: 'Couldn’t start a new conversation.',
  Switch: 'Couldn’t switch the provider.'
}

/** States in which the agent is doing something (Interrupt and Stop are up front). */
const WORKING: ReadonlySet<TerminalState> = new Set(['starting', 'running', 'background'])

/** Chrome glyphs and labels grow with Dynamic Type, but not past what the bar holds. */
const MAX_CHROME_SCALE = 1.4

/** The terminal's handle, as its ref sets it — read in handlers only, never in render. */
class TerminalSlot {
  private handle: TerminalViewHandle | null = null
  readonly attach = (handle: TerminalViewHandle | null): void => {
    this.handle = handle
  }
  get(): TerminalViewHandle | null {
    return this.handle
  }
}

/** A pill's 30pt, reaching the 44pt a finger needs. */
const PILL_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 }

export function AgentPanel({
  hubId,
  feed,
  showHub,
  tabId,
  onSelectTab,
  row,
  openingKey
}: AgentPanelProps) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const task = row.task
  const taskId = task.id

  const tabsQ = useQuery(trpc.taskTerminals.list.queryOptions({ taskId }))
  useSubscription(
    trpc.taskTerminals.onChanged.subscriptionOptions(undefined, {
      onData: (change) => {
        if (change.taskId === taskId)
          void queryClient.invalidateQueries(trpc.taskTerminals.list.queryFilter({ taskId }))
      }
    })
  )
  const modesQ = useQuery(trpc.pty.agentsList.queryOptions())

  // A task with no main tab row yet (never opened on desktop): create it, as
  // desktop's terminal does when it opens the task.
  const ensured = useRef(false)
  const tabRows = tabsQ.data
  const taskMode = task.agent_id
  useEffect(() => {
    if (!tabRows || ensured.current || tabRows.some((t) => t.isMain)) return
    ensured.current = true
    client.taskTerminals.ensureMain
      .mutate({ taskId, mode: taskMode })
      .then(() => queryClient.invalidateQueries(trpc.taskTerminals.list.queryFilter({ taskId })))
      .catch(() => undefined)
  }, [tabRows, client, queryClient, trpc, taskId, taskMode])

  // Opened: the user has seen it (desktop clears it when a task becomes the active
  // tab, once per opening — "Mark as unread" afterwards sticks, a remount included).
  const mountKey = useId()
  const opening = `${hubId}\u0000${taskId}\u0000${openingKey ?? mountKey}`
  const unread = Boolean(task.needs_attention)
  useEffect(() => {
    if (!claimOpening(opening)) return
    if (unread)
      client.task.update.mutate({ id: taskId, needsAttention: false }).catch(() => undefined)
  }, [opening, unread, client, taskId])

  const tabs = useMemo<Tab[]>(
    () => [...(tabRows ?? [])].sort((a, b) => a.position - b.position),
    [tabRows]
  )
  // Until the tabs load, the main tab (its id is the task's; its mode the task's).
  const main: Tab = tabs.find((t) => t.isMain) ?? {
    id: taskId,
    taskId,
    groupId: taskId,
    label: null,
    mode: taskMode,
    isMain: true,
    position: 0,
    createdAt: '',
    agentState: 'new',
    chatFontSize: null
  }
  const selected = tabs.find((t) => t.id === tabId) ?? main
  const target: AgentTarget = { taskId, tabId: selected.id, mode: selected.mode }
  const chat = isChatSupported(selected.mode)
  const sessionId = sessionIdOf(taskId, selected.id)
  const state: TerminalState | undefined = feed.agents.state.byId[sessionId]
  const jobs = feed.agents.state.jobsById[sessionId] ?? 0
  // Until the first snapshot is in, no state means "not known yet", not "not started".
  const loaded = feed.agents.loaded
  const loadError = loaded ? null : feed.agents.error
  const live = state !== undefined && isAliveTerminalState(state)
  const working = state !== undefined && WORKING.has(state)
  const restarts = useRestarts(state)
  const onMain = isMainTab(target)
  const [terminal] = useState(() => new TerminalSlot())
  /** The grid to start a terminal agent at (the terminal's area); chat: none. */
  const size = () => (chat ? undefined : terminal.get()?.grid())

  const { computers } = useHubComputers()
  const taskComputer = computerName(
    computers,
    workComputerId({ computer_id: task.computer_id ?? null }, row.project)
  )

  const modeLabel = (mode: string): string =>
    modesQ.data?.find((m) => m.id === mode)?.label ?? getModeLabel(mode)

  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{
    name: string
    detail: string
    retry: () => void
  } | null>(null)
  const [picking, setPicking] = useState(false)
  const [menu, setMenu] = useState(false)
  // The terminal's text size when ⋯ opened: what its switch offers is the other one.
  const [menuTextSize, setMenuTextSize] = useState<'readable' | 'fit'>('readable')
  const openMenu = (): void => {
    setMenuTextSize(terminal.get()?.textSize() ?? 'readable')
    setMenu(true)
  }

  const run = (name: string, action: () => Promise<unknown>): void => {
    setBusy(name)
    setActionError(null)
    action()
      .catch((error: unknown) =>
        setActionError({ name, detail: messageOf(error), retry: () => run(name, action) })
      )
      .finally(() => setBusy(null))
  }
  const confirmThen = (
    name: string,
    title: string,
    message: string,
    action: () => Promise<unknown>
  ): void => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: name, style: 'destructive', onPress: () => run(name, action) }
    ])
  }

  const switchTo = (mode: string): void => {
    setPicking(false)
    if (mode === task.agent_id) return
    confirmThen(
      'Switch',
      `Switch to ${modeLabel(mode)}?`,
      'The agent is stopped and starts again with a new conversation.',
      () => switchAgentMode(client, taskId, mode, size())
    )
  }

  const statusParts = [
    state
      ? agentStateLabel(state)
      : loadError
        ? 'Couldn’t load'
        : loaded
          ? 'Not started'
          : 'Loading…'
  ]
  if (unread) statusParts.push('Unread')
  if (jobs > 0) statusParts.push(`${jobs} background ${jobs === 1 ? 'job' : 'jobs'}`)
  if (showHub) statusParts.push(feed.hub.label)
  const dot = agentDotOf(state, unread)

  const tabLabels = numberDuplicateLabels(new Map(tabs.map((t) => [t.id, getTabLabel(t)])))

  const actions: Array<{ name: string; label?: string; onPress: () => void; more?: boolean }> = []
  // Nothing to act on until the agent's state is known.
  if (onMain && !live && loaded)
    actions.push({
      name: 'Start',
      onPress: () => run('Start', () => startAgent(client, taskId, size()))
    })
  if (live && !chat)
    actions.push({
      name: 'Interrupt',
      more: !working,
      onPress: () => run('Interrupt', () => interruptAgent(client, target))
    })
  if (live)
    actions.push({
      name: 'Stop',
      more: !working,
      onPress: () =>
        confirmThen(
          'Stop',
          'Stop the agent?',
          'Its process ends; Start resumes the conversation.',
          () => stopAgent(client, target)
        )
    })
  if (onMain && live)
    actions.push({
      name: 'Restart',
      more: true,
      onPress: () =>
        confirmThen(
          'Restart',
          'Restart the agent?',
          'It stops and starts again in the same conversation.',
          () => restartAgent(client, target, size())
        )
    })
  if (onMain)
    actions.push({
      name: 'Reset',
      more: true,
      onPress: () =>
        confirmThen(
          'Reset',
          'Start a new conversation?',
          'The agent stops and starts fresh; this conversation is left behind.',
          () => resetAgent(client, target, size())
        )
    })
  if (!chat) {
    actions.push(
      {
        name: 'Copy screen text',
        more: true,
        onPress: () => terminal.get()?.exportText('screen', 'copy')
      },
      {
        name: 'Copy all output',
        more: true,
        onPress: () => terminal.get()?.exportText('all', 'copy')
      },
      {
        name: 'Share all output…',
        more: true,
        onPress: () => terminal.get()?.exportText('all', 'share')
      },
      {
        name: menuTextSize === 'fit' ? 'Readable text size' : 'Fit text to width',
        more: true,
        onPress: () => terminal.get()?.toggleTextSize()
      }
    )
  }

  const inline = actions.filter((a) => !a.more)
  const more = actions.filter((a) => a.more)

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <View style={styles.identity}>
          {dot ? <AgentDot kind={dot} /> : <View style={styles.noDot} />}
          {onMain ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change provider"
              accessibilityValue={{ text: modeLabel(task.agent_id) }}
              onPress={() => setPicking(true)}
              disabled={busy !== null}
              style={styles.provider}
            >
              <Text style={styles.mode} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
                {modeLabel(task.agent_id)} ▾
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.mode} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
              {modeLabel(selected.mode)}
            </Text>
          )}
          <Text
            style={styles.statusText}
            numberOfLines={2}
            maxFontSizeMultiplier={MAX_CHROME_SCALE}
          >
            {statusParts.join(' · ')}
          </Text>
          {busy || (!loaded && !loadError) ? (
            <ActivityIndicator color={theme.mutedForeground} />
          ) : null}
        </View>
        {inline.length > 0 || more.length > 0 ? (
          <View style={styles.actions}>
            {inline.map((a) => (
              <Pressable
                key={a.name}
                accessibilityRole="button"
                onPress={a.onPress}
                disabled={busy !== null}
                hitSlop={PILL_HIT_SLOP}
                style={[styles.action, a.name === 'Start' && styles.actionPrimary]}
              >
                <Text
                  style={[
                    styles.actionText,
                    a.name === 'Start' && styles.actionPrimaryText,
                    busy !== null && styles.disabled
                  ]}
                  maxFontSizeMultiplier={MAX_CHROME_SCALE}
                >
                  {a.name}
                </Text>
              </Pressable>
            ))}
            {more.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="More agent actions"
                onPress={openMenu}
                disabled={busy !== null}
                hitSlop={PILL_HIT_SLOP}
                style={styles.action}
              >
                <Text style={styles.actionText} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
                  ⋯
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      {loadError ? (
        <View style={styles.problemRow}>
          <View style={styles.problemText}>
            <Text style={styles.problem}>Couldn’t load the agent’s state.</Text>
            <Text style={styles.problemDetail} numberOfLines={2}>
              {loadError}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading the agent’s state"
            onPress={() => void queryClient.refetchQueries({ queryKey: AGENT_SNAPSHOT_QUERY_KEY })}
            hitSlop={PILL_HIT_SLOP}
            style={styles.action}
          >
            <Text style={styles.actionText} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}
      {actionError ? (
        <View style={styles.problemRow} accessibilityLiveRegion="polite">
          <View style={styles.problemText}>
            <Text style={styles.problem}>
              {FAILED[actionError.name] ?? `Couldn’t ${actionError.name.toLowerCase()}.`}
            </Text>
            <Text style={styles.problemDetail} numberOfLines={2}>
              {actionError.detail}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Retry: ${actionError.name}`}
            onPress={actionError.retry}
            disabled={busy !== null}
            hitSlop={PILL_HIT_SLOP}
            style={styles.action}
          >
            <Text style={styles.actionText} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
              Retry
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss the error"
            onPress={() => setActionError(null)}
            style={styles.dismiss}
          >
            <Text style={styles.dismissText} maxFontSizeMultiplier={MAX_CHROME_SCALE}>
              ✕
            </Text>
          </Pressable>
        </View>
      ) : null}
      {tabs.length > 1 ? (
        <ScrollView horizontal style={styles.tabs} contentContainerStyle={styles.tabsContent}>
          {tabs.map((t) => (
            <Pressable
              key={t.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: t.id === selected.id }}
              onPress={() => onSelectTab(t.id)}
              hitSlop={PILL_HIT_SLOP}
              style={[styles.tab, t.id === selected.id && styles.tabActive]}
            >
              <Text style={[styles.tabText, t.id === selected.id && styles.tabTextActive]}>
                {tabLabels.get(t.id)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.body}>
        {chat ? (
          <ChatSession hubId={hubId} taskId={taskId} tabId={selected.id} mode={selected.mode} />
        ) : (
          <TerminalView
            onHandle={terminal.attach}
            key={`${sessionId}#${restarts}`}
            sessionId={sessionId}
            taskId={taskId}
            live={live}
            stateLoading={!loaded}
            computerName={taskComputer}
            notRunningHint={onMain ? 'Tap Start to run it.' : undefined}
          />
        )}
      </View>
      <BottomSheet visible={menu} onClose={() => setMenu(false)} testID="agent-menu">
        {more.map((a) => (
          <Pressable
            key={a.name}
            accessibilityRole="button"
            onPress={() => {
              setMenu(false)
              a.onPress()
            }}
            style={styles.pickerRow}
          >
            <Text style={styles.pickerText}>{a.name}</Text>
          </Pressable>
        ))}
      </BottomSheet>
      <BottomSheet visible={picking} onClose={() => setPicking(false)} testID="mode-picker">
        <Text style={styles.pickerTitle}>Provider</Text>
        {(modesQ.data ?? [])
          .filter((m) => m.enabled)
          .sort((a, b) => a.order - b.order)
          .map((m) => (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              accessibilityState={{ selected: m.id === task.agent_id }}
              onPress={() => switchTo(m.id)}
              style={styles.pickerRow}
            >
              <Text style={styles.pickerText}>{m.label}</Text>
              {m.id === task.agent_id ? <Text style={styles.pickerText}>✓</Text> : null}
            </Pressable>
          ))}
      </BottomSheet>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    // Wraps: on a narrow phone (or at a large text size) the actions go to a second
    // line instead of squeezing the status to nothing.
    bar: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: 8,
      rowGap: 4,
      paddingHorizontal: 14,
      paddingVertical: 4
    },
    identity: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 180,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 44
    },
    provider: { minHeight: 44, justifyContent: 'center' },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
    noDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: t.muted },
    mode: { fontSize: 14, fontWeight: '600', color: t.foreground },
    statusText: { flexShrink: 1, minWidth: 64, fontSize: 12, color: t.mutedForeground },
    action: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    actionPrimary: { backgroundColor: t.primary, borderColor: t.primary },
    actionText: { fontSize: 13, fontWeight: '500', color: t.foreground },
    actionPrimaryText: { color: t.primaryForeground, fontWeight: '600' },
    disabled: { color: t.mutedForeground },
    problemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingBottom: 6
    },
    problemText: { flex: 1 },
    problem: { color: t.destructive, fontSize: 13, fontWeight: '500' },
    problemDetail: { color: t.mutedForeground, fontSize: 12 },
    dismiss: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    dismissText: { fontSize: 14, color: t.mutedForeground },
    tabs: { flexGrow: 0 },
    tabsContent: { paddingHorizontal: 12, gap: 6, paddingBottom: 8 },
    tab: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      backgroundColor: t.surface2
    },
    tabActive: { backgroundColor: t.surface3 },
    tabText: { fontSize: 13, color: t.mutedForeground },
    tabTextActive: { color: t.foreground, fontWeight: '600' },
    body: { flex: 1 },
    pickerTitle: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.6,
      color: t.mutedForeground,
      textTransform: 'uppercase',
      paddingBottom: 8
    },
    pickerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 13,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    pickerText: { fontSize: 16, color: t.foreground }
  })
