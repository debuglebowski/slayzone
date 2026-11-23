/**
 * A task's agent — the Agent panel of the task page (desktop's Agent panel). The app
 * shows a task's MAIN agent only, never its other agent tabs: the main tab
 * (`taskTerminals.list`, live via `taskTerminals.onChanged`; created when the task has
 * none yet, as desktop does on open) — a chat in the chat view (`ChatSession`), any
 * other in the terminal (`TerminalView`) — its state, and what can be done with it (Start,
 * Interrupt, Stop, Restart, Reset, provider; `lifecycle.ts`; destructive ones ask
 * first; a failed one says what failed and offers Retry). Interrupt and Stop are up
 * front only while the agent works; idle, they are under ⋯ with the rest. A terminal's
 * ⋯ also shares its text and switches its text size. Until the hub's agent states are
 * in, it says it is loading (never "Not started" and Start for an agent that runs).
 * Opening it marks the task read, as opening it on desktop does — once per opening
 * (`openingKey`, `opening-reads.ts`), so "Mark as unread" survives a remount.
 *
 * On the phone's task page (`phone`) the panel draws no chrome of its own: it hands the
 * page the agent (`AgentNav`: provider, state, Start / Stop while offered, every
 * action, the providers, a chat's mode / model / effort) and its body (the chat or the
 * terminal), and the page lays out both — its status island and agent card show the
 * agent, a chat's composer sits on the page's tab bar.
 *
 * Rendered inside the HubScope of the hub that owns the task (`feed`'s hub): every
 * call here goes to that hub.
 */
import type { HubFeed, TaskRow } from '../hub-board'
import { getModeLabel } from '@slayzone/task-terminals/tab-label'
import {
  isAliveTerminalState,
  isChatSupported,
  type TerminalState
} from '@slayzone/terminal-contracts'
import { computerName } from '@slayzone/computers/labels'
import { workComputerId } from '@slayzone/projects-contracts/placements'
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChatSession, type ChatChrome } from '../chat'
import { useHubComputers } from '../computers/use-hub-computers'
import { ChromeInsets } from '../task/task-chrome'
import { TerminalView, type TerminalViewHandle } from '../terminal/TerminalView'
import { type ChromeColors, useTheme } from '../theme'
import { type RouterOutputs, useTRPC, useTRPCClient } from '../trpc'
import { type AgentDot as AgentDotKind, agentDotOf } from '../board/card-model'
import { BottomSheet } from '../ui-kit/Chrome'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import { agentStateLabel } from './agent-status'
import { sessionIdOf } from './hub-agents'
import { claimOpening } from './opening-reads'
import { AGENT_SNAPSHOT_QUERY_KEY } from './use-hub-agent-sessions'
import {
  type AgentTarget,
  interruptAgent,
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
  /**
   * Names this opening of the task (stable while the page that opened it stays open):
   * the task is marked read once per opening, however often the panel remounts.
   * Omitted: once per mount.
   */
  openingKey?: string
  /**
   * The phone's task page: it lays out the page from the agent (`AgentNav`) and the
   * agent's body (the chat or the terminal, to be kept mounted). The panel then draws
   * no bar, ⋯ or menu of its own, and a chat's controls are the page's (`controls`).
   * Omitted (iPad): the panel's own bar.
   */
  phone?: (agent: AgentNav, body: ReactNode) => ReactNode
  renderWide?: (body: ReactNode) => ReactNode
}

/** Something to do with the agent (the agent card lists them). */
export interface AgentAction {
  /** What it is (`Start`, `Stop`, `Copy screen text` …); stable, for keys. */
  name: string
  /** Its words. */
  label: string
  destructive?: boolean
  /** `lifecycle`: start, stop and the like; `terminal`: the terminal's text. */
  kind: 'lifecycle' | 'terminal'
  onPress: () => void
}

/** What the phone's task page shows of the agent, and what it can do with it. */
export interface AgentNav {
  /** The provider. */
  provider: string
  /** Its state and what else to know ("Idle · Unread"). */
  status: string
  /** Its state in a word or two (desktop's words: "Active", "Idle" …), or why not known. */
  stateLabel: string
  dot: AgentDotKind | null
  /** It works (starting, running, subagents): Stop is up front. */
  working: boolean
  /** A chat's agent waits for the user's answer. */
  waiting: boolean
  /** An action runs, or the agents' states are still loading. */
  busy: boolean
  /** Start, up front while offered (the agent isn't running); null otherwise. */
  start: (() => void) | null
  /** Stop (asks first), up front while the agent works; null otherwise. */
  stop: (() => void) | null
  /** Everything that can be done with it, Start and Stop included. */
  actions: AgentAction[]
  /** The providers to switch to (the task's first), and the switch (asks first). */
  providers: ReadonlyArray<{ id: string; label: string }>
  providerId: string
  switchProvider: (id: string) => void
  /** A chat's mode / model / effort (null: a terminal, or not loaded yet). */
  controls: ChatChrome | null
  /** The agent card opens: what its actions say is read now (the terminal's text size). */
  onOpen: () => void
  /** What failed (loading the state, an action), with Retry; null when nothing did. */
  problems: ReactNode
}

/** A tab as `taskTerminals.list` returns it (the main one: the only one shown). */
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
  row,
  openingKey,
  phone,
  renderWide
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

  // Until the tabs load, the main tab (its id is the task's; its mode the task's).
  const main: Tab = tabRows?.find((t) => t.isMain) ?? {
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
  const target: AgentTarget = { taskId, tabId: main.id, mode: main.mode }
  const chat = isChatSupported(main.mode)
  const sessionId = sessionIdOf(taskId, main.id)
  const state: TerminalState | undefined = feed.agents.state.byId[sessionId]
  const jobs = feed.agents.state.jobsById[sessionId] ?? 0
  // Until the first snapshot is in, no state means "not known yet", not "not started".
  const loaded = feed.agents.loaded
  const loadError = loaded ? null : feed.agents.error
  const live = state !== undefined && isAliveTerminalState(state)
  const working = state !== undefined && WORKING.has(state)
  const restarts = useRestarts(state)
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
  // A chat's controls and whether it waits for the user (the phone page shows them).
  const [chatChrome, setChatChrome] = useState<ChatChrome | null>(null)
  const [actionError, setActionError] = useState<{
    name: string
    detail: string
    retry: () => void
  } | null>(null)
  const [picking, setPicking] = useState(false)
  const [menu, setMenu] = useState(false)
  // The terminal's text size when ⋯ (or the agent card) opened: what its switch offers
  // is the other one.
  const [menuTextSize, setMenuTextSize] = useState<'readable' | 'fit'>('readable')
  const readTextSize = (): void => setMenuTextSize(terminal.get()?.textSize() ?? 'readable')
  const openMenu = (): void => {
    readTextSize()
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

  const stateLabel = state
    ? agentStateLabel(state)
    : loadError
      ? 'Couldn’t load'
      : loaded
        ? 'Not started'
        : 'Loading…'
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

  const actions: Array<{
    name: string
    /** Its words in the agent card (phone), when not its name. */
    label?: string
    /** One of the terminal's own (its text): the agent card lists them apart. */
    terminal?: boolean
    destructive?: boolean
    onPress: () => void
    more?: boolean
  }> = []
  // Nothing to act on until the agent's state is known.
  if (!live && loaded)
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
      label: 'Stop agent',
      destructive: true,
      more: !working,
      onPress: () =>
        confirmThen(
          'Stop',
          'Stop the agent?',
          'Its process ends; Start resumes the conversation.',
          () => stopAgent(client, target)
        )
    })
  if (live)
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
  actions.push({
    name: 'Reset',
    label: 'New conversation',
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
        terminal: true,
        onPress: () => terminal.get()?.exportText('screen', 'copy')
      },
      {
        name: 'Copy all output',
        more: true,
        terminal: true,
        onPress: () => terminal.get()?.exportText('all', 'copy')
      },
      {
        name: 'Share all output…',
        more: true,
        terminal: true,
        onPress: () => terminal.get()?.exportText('all', 'share')
      },
      {
        name: menuTextSize === 'fit' ? 'Readable text size' : 'Fit text to width',
        more: true,
        terminal: true,
        onPress: () => terminal.get()?.toggleTextSize()
      }
    )
  }

  const inline = actions.filter((a) => !a.more)
  const more = actions.filter((a) => a.more)
  const start = actions.find((a) => a.name === 'Start')
  const providerLabel = modeLabel(task.agent_id)
  const providers = (modesQ.data ?? []).filter((m) => m.enabled).sort((a, b) => a.order - b.order)

  const problems = (
    <>
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
    </>
  )

  const body = (
    <View style={styles.body}>
      {chat ? (
        <ChatSession
          hubId={hubId}
          taskId={taskId}
          tabId={main.id}
          mode={main.mode}
          {...(phone ? { controls: 'page' as const, onChrome: setChatChrome } : {})}
        />
      ) : (
        <ChromeInsets>
          <TerminalView
            onHandle={terminal.attach}
            key={`${sessionId}#${restarts}`}
            sessionId={sessionId}
            taskId={taskId}
            live={live}
            stateLoading={!loaded}
            computerName={taskComputer}
            notRunningHint="Tap Start to run it."
          />
        </ChromeInsets>
      )}
    </View>
  )

  const panel = (
    <View style={styles.screen}>
      {phone ? null : (
        <>
          <View style={styles.bar}>
            <View style={styles.identity}>
              {dot ? <AgentDot kind={dot} /> : <View style={styles.noDot} />}
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
          {problems}
        </>
      )}
      {body}
      {phone ? null : (
        <>
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
            {providers.map((m) => (
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
        </>
      )}
    </View>
  )

  if (phone) {
    const stop = actions.find((a) => a.name === 'Stop')
    return phone(
      {
        provider: providerLabel,
        status: statusParts.join(' · '),
        stateLabel,
        dot,
        working,
        waiting: chat && (chatChrome?.waiting ?? false),
        busy: busy !== null || (!loaded && !loadError),
        start: start && busy === null ? start.onPress : null,
        stop: working && stop && busy === null ? stop.onPress : null,
        actions: actions.map((a) => ({
          name: a.name,
          label: a.label ?? a.name,
          ...(a.destructive ? { destructive: true } : {}),
          kind: a.terminal ? 'terminal' : 'lifecycle',
          onPress: a.onPress
        })),
        providers: providers.map((m) => ({ id: m.id, label: m.label })),
        providerId: task.agent_id,
        switchProvider: switchTo,
        controls: chat ? chatChrome : null,
        onOpen: readTextSize,
        problems: loadError || actionError ? problems : null
      },
      panel
    )
  }

  return renderWide ? renderWide(panel) : panel
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
