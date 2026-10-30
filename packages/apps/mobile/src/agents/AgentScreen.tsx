/**
 * A task's agents on the phone, `/agent/<hub address>/<task id>?tab=<tab id>`: the
 * task's terminal tabs (`taskTerminals.list`, live via `taskTerminals.onChanged`;
 * the main tab is created when the task has none yet, as desktop does on open), the
 * selected tab's agent — a chat tab in the chat view (`ChatSession`), any other in
 * the terminal (`TerminalView`) — its state, and what can be done with it (Start,
 * Interrupt, Stop, Restart, Reset, provider; `lifecycle.ts`; destructive ones ask
 * first). Opening it marks the task read, as opening it on desktop does.
 *
 * Rendered inside the HubScope of the hub that owns the task (`feed`'s hub): every
 * call here goes to that hub.
 */
import { findTaskRow, type HubFeed, type TaskRow } from '../hub-board'
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
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { ChatSession } from '../chat'
import { TerminalView } from '../terminal/TerminalView'
import { type ChromeColors, useTheme } from '../theme'
import { type RouterOutputs, useTRPC, useTRPCClient } from '../trpc'
import { groupColor } from './AgentList'
import { agentGroup, agentStateLabel } from './agent-status'
import { sessionIdOf } from './hub-agents'
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

export interface AgentScreenProps {
  hubId: string
  /** The feed of the hub that owns the task. */
  feed: HubFeed
  /** Several hubs are signed in: say which one this is. */
  showHub: boolean
  taskId: string
  /** The tab to show; undefined = the main tab. */
  tabId: string | undefined
  onBack: () => void
  onSelectTab: (tabId: string) => void
}

export function AgentScreen(props: AgentScreenProps) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const row = findTaskRow(props.feed, props.taskId)
  if (row) return <AgentBody {...props} row={row} />
  return (
    <View style={styles.screen}>
      <Header title="" onBack={props.onBack} />
      {props.feed.board.pending ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.foreground} />
        </View>
      ) : (
        <Text style={styles.note}>No such task on {props.feed.hub.label}</Text>
      )}
    </View>
  )
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
    </View>
  )
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

function AgentBody({
  hubId,
  feed,
  showHub,
  taskId,
  tabId,
  onBack,
  onSelectTab,
  row
}: AgentScreenProps & { row: TaskRow }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const task = row.task

  const tabsQ = useQuery(trpc.taskTerminals.list.queryOptions({ taskId }))
  useSubscription(
    trpc.taskTerminals.onChanged.subscriptionOptions(undefined, {
      onData: (change) => {
        if (change.taskId === taskId)
          void queryClient.invalidateQueries(trpc.taskTerminals.list.queryFilter({ taskId }))
      }
    })
  )
  const modesQ = useQuery(trpc.pty.modesList.queryOptions())

  // A task with no main tab row yet (never opened on desktop): create it, as
  // desktop's terminal does when it opens the task.
  const ensured = useRef(false)
  const tabRows = tabsQ.data
  const taskMode = task.terminal_mode
  useEffect(() => {
    if (!tabRows || ensured.current || tabRows.some((t) => t.isMain)) return
    ensured.current = true
    client.taskTerminals.ensureMain
      .mutate({ taskId, mode: taskMode })
      .then(() => queryClient.invalidateQueries(trpc.taskTerminals.list.queryFilter({ taskId })))
      .catch(() => undefined)
  }, [tabRows, client, queryClient, trpc, taskId, taskMode])

  // Opened: the user has seen it (desktop clears it when a task becomes the active
  // tab, once per opening — "Mark as unread" afterwards sticks).
  const markedRead = useRef(false)
  const unread = Boolean(task.needs_attention)
  useEffect(() => {
    if (markedRead.current) return
    markedRead.current = true
    if (unread)
      client.task.update.mutate({ id: taskId, needsAttention: false }).catch(() => undefined)
  }, [unread, client, taskId])

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
    agentState: 'new'
  }
  const selected = tabs.find((t) => t.id === tabId) ?? main
  const target: AgentTarget = { taskId, tabId: selected.id, mode: selected.mode }
  const chat = isChatSupported(selected.mode)
  const sessionId = sessionIdOf(taskId, selected.id)
  const state: TerminalState | undefined = feed.agents.state.byId[sessionId]
  const jobs = feed.agents.state.jobsById[sessionId] ?? 0
  const live = state !== undefined && isAliveTerminalState(state)
  const restarts = useRestarts(state)
  const onMain = isMainTab(target)

  const modeLabel = (mode: string): string =>
    modesQ.data?.find((m) => m.id === mode)?.label ?? getModeLabel(mode)

  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  const run = (name: string, action: () => Promise<unknown>): void => {
    setBusy(name)
    setActionError(null)
    action()
      .catch((error: unknown) => setActionError(`${name}: ${messageOf(error)}`))
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
    if (mode === task.terminal_mode) return
    confirmThen(
      'Switch',
      `Switch to ${modeLabel(mode)}?`,
      'The agent is stopped and starts again with a new conversation.',
      () =>
        switchAgentMode(
          client,
          { id: taskId, terminal_mode: task.terminal_mode, provider_config: task.provider_config },
          mode
        )
    )
  }

  const statusParts = [state ? agentStateLabel(state) : 'Not started']
  if (unread) statusParts.push('Unread')
  if (jobs > 0) statusParts.push(`${jobs} background ${jobs === 1 ? 'job' : 'jobs'}`)
  if (showHub) statusParts.push(feed.hub.label)
  const dotColor = state ? groupColor(theme, agentGroup(state, unread)) : theme.mutedForeground

  const tabLabels = numberDuplicateLabels(new Map(tabs.map((t) => [t.id, getTabLabel(t)])))

  const actions: Array<{ name: string; onPress: () => void }> = []
  if (onMain && !live)
    actions.push({ name: 'Start', onPress: () => run('Start', () => startAgent(client, taskId)) })
  if (live && !chat)
    actions.push({
      name: 'Interrupt',
      onPress: () => run('Interrupt', () => interruptAgent(client, target))
    })
  if (live)
    actions.push({
      name: 'Stop',
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
      onPress: () =>
        confirmThen(
          'Restart',
          'Restart the agent?',
          'It stops and starts again in the same conversation.',
          () => restartAgent(client, target)
        )
    })
  if (onMain)
    actions.push({
      name: 'Reset',
      onPress: () =>
        confirmThen(
          'Reset',
          'Start a new conversation?',
          'The agent stops and starts fresh; this conversation is left behind.',
          () => resetAgent(client, target)
        )
    })

  return (
    <View style={styles.screen}>
      <Header title={task.title} onBack={onBack} />
      <View style={styles.status}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.statusText} numberOfLines={1}>
          {statusParts.join(' · ')}
        </Text>
        {onMain ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change provider"
            onPress={() => setPicking(true)}
            disabled={busy !== null}
            hitSlop={8}
          >
            <Text style={styles.link}>{modeLabel(task.terminal_mode)} ▾</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.actions}>
        {actions.map((a) => (
          <Pressable
            key={a.name}
            accessibilityRole="button"
            onPress={a.onPress}
            disabled={busy !== null}
            style={styles.action}
          >
            <Text style={[styles.actionText, busy !== null && styles.disabled]}>{a.name}</Text>
          </Pressable>
        ))}
        {busy ? <ActivityIndicator color={theme.foreground} /> : null}
      </View>
      {actionError ? <Text style={styles.problem}>{actionError}</Text> : null}
      {tabs.length > 1 ? (
        <ScrollView horizontal style={styles.tabs} contentContainerStyle={styles.tabsContent}>
          {tabs.map((t) => (
            <Pressable
              key={t.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: t.id === selected.id }}
              onPress={() => onSelectTab(t.id)}
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
          <TerminalView key={`${sessionId}#${restarts}`} sessionId={sessionId} live={live} />
        )}
      </View>
      <Modal
        visible={picking}
        transparent
        animationType="fade"
        onRequestClose={() => setPicking(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setPicking(false)}>
          <View testID="mode-picker" style={styles.picker}>
            <Text style={styles.pickerTitle}>Provider</Text>
            {(modesQ.data ?? [])
              .filter((m) => m.enabled)
              .sort((a, b) => a.order - b.order)
              .map((m) => (
                <Pressable
                  key={m.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: m.id === task.terminal_mode }}
                  onPress={() => switchTo(m.id)}
                  style={styles.pickerRow}
                >
                  <Text style={styles.pickerText}>{m.label}</Text>
                  {m.id === task.terminal_mode ? <Text style={styles.pickerText}>✓</Text> : null}
                </Pressable>
              ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    title: { flex: 1, fontSize: 17, fontWeight: '600', color: t.foreground },
    link: { fontSize: 15, color: t.foreground, fontWeight: '500' },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' },
    status: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 10
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    statusText: { flex: 1, fontSize: 13, color: t.mutedForeground },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10
    },
    action: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: t.muted
    },
    actionText: { fontSize: 14, fontWeight: '500', color: t.foreground },
    disabled: { color: t.mutedForeground },
    problem: { color: t.destructive, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
    tabs: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border },
    tabsContent: { paddingHorizontal: 12, gap: 6, paddingBottom: 8 },
    tab: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
    tabActive: { backgroundColor: t.accent },
    tabText: { fontSize: 13, color: t.mutedForeground },
    tabTextActive: { color: t.foreground, fontWeight: '600' },
    body: { flex: 1 },
    backdrop: { flex: 1, justifyContent: 'flex-end' },
    picker: {
      backgroundColor: t.popover,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      paddingBottom: 24,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    pickerTitle: {
      fontSize: 12,
      fontWeight: '600',
      color: t.mutedForeground,
      textTransform: 'uppercase',
      padding: 16
    },
    pickerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    pickerText: { fontSize: 16, color: t.popoverForeground }
  })
