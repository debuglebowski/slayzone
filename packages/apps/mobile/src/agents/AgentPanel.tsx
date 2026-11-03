/**
 * A task's agents — the Agent panel of the task page (desktop's Agent panel): the
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
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { TerminalView } from '../terminal/TerminalView'
import { type ChromeColors, useTheme } from '../theme'
import { type RouterOutputs, useTRPC, useTRPCClient } from '../trpc'
import { agentDotOf } from '../board/card-model'
import { BottomSheet } from '../ui-kit/Chrome'
import { AgentDot } from '../ui-kit/TaskGlyphs'
import { agentStateLabel } from './agent-status'
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

export function AgentPanel({ hubId, feed, showHub, tabId, onSelectTab, row }: AgentPanelProps) {
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
  const [menu, setMenu] = useState(false)

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
      () => switchAgentMode(client, taskId, mode)
    )
  }

  const statusParts = [state ? agentStateLabel(state) : 'Not started']
  if (unread) statusParts.push('Unread')
  if (jobs > 0) statusParts.push(`${jobs} background ${jobs === 1 ? 'job' : 'jobs'}`)
  if (showHub) statusParts.push(feed.hub.label)
  const dot = agentDotOf(state, unread)

  const tabLabels = numberDuplicateLabels(new Map(tabs.map((t) => [t.id, getTabLabel(t)])))

  const actions: Array<{ name: string; onPress: () => void; more?: boolean }> = []
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
      more: true,
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
      more: true,
      onPress: () =>
        confirmThen(
          'Reset',
          'Start a new conversation?',
          'The agent stops and starts fresh; this conversation is left behind.',
          () => resetAgent(client, target)
        )
    })

  const inline = actions.filter((a) => !a.more)
  const more = actions.filter((a) => a.more)

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        {dot ? <AgentDot kind={dot} /> : <View style={styles.noDot} />}
        {onMain ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change provider"
            onPress={() => setPicking(true)}
            disabled={busy !== null}
            hitSlop={8}
          >
            <Text style={styles.mode}>{modeLabel(task.terminal_mode)} ▾</Text>
          </Pressable>
        ) : (
          <Text style={styles.mode}>{modeLabel(selected.mode)}</Text>
        )}
        <Text style={styles.statusText} numberOfLines={1}>
          {statusParts.join(' · ')}
        </Text>
        {busy ? <ActivityIndicator color={theme.foreground} /> : null}
        {inline.map((a) => (
          <Pressable
            key={a.name}
            accessibilityRole="button"
            onPress={a.onPress}
            disabled={busy !== null}
            style={[styles.action, a.name === 'Start' && styles.actionPrimary]}
          >
            <Text
              style={[
                styles.actionText,
                a.name === 'Start' && styles.actionPrimaryText,
                busy !== null && styles.disabled
              ]}
            >
              {a.name}
            </Text>
          </Pressable>
        ))}
        {more.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More agent actions"
            onPress={() => setMenu(true)}
            disabled={busy !== null}
            hitSlop={8}
            style={styles.action}
          >
            <Text style={styles.actionText}>⋯</Text>
          </Pressable>
        ) : null}
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
              accessibilityState={{ selected: m.id === task.terminal_mode }}
              onPress={() => switchTo(m.id)}
              style={styles.pickerRow}
            >
              <Text style={styles.pickerText}>{m.label}</Text>
              {m.id === task.terminal_mode ? <Text style={styles.pickerText}>✓</Text> : null}
            </Pressable>
          ))}
      </BottomSheet>
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 8
    },
    noDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: t.muted },
    mode: { fontSize: 14, fontWeight: '600', color: t.foreground },
    statusText: { flex: 1, fontSize: 12, color: t.mutedForeground },
    action: {
      paddingHorizontal: 11,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    actionPrimary: { backgroundColor: t.primary, borderColor: t.primary },
    actionText: { fontSize: 13, fontWeight: '500', color: t.foreground },
    actionPrimaryText: { color: t.primaryForeground, fontWeight: '600' },
    disabled: { color: t.mutedForeground },
    problem: { color: t.destructive, fontSize: 12, paddingHorizontal: 14, paddingBottom: 6 },
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
