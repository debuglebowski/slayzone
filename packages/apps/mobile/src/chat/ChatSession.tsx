/**
 * A full chat view for one chat tab (`claude-chat` / `codex-chat`) of a task, built on
 * desktop's shared chat logic, not its DOM components: the timeline (desktop's reducer),
 * the composer with the `/` menu and the queue, the "waiting for you" dock, the mode /
 * model / effort chips, and the background jobs. Rendered inside the `HubScope` of the
 * hub that owns the task (every call goes to that hub).
 *
 * First the tab's folder is resolved (`useChatCwd`): the hub keys a chat tab by it, so
 * the view mounts only once it is known — keyed by tab and folder, so nothing of one
 * session can leak into another.
 */
import { useHubId } from '@slayzone/transport/client'
import { chatCapabilitiesForMode, type PermissionDecision } from '@slayzone/terminal-contracts'
import { hasPendingPrompt } from '@slayzone/terminal/chat-prompts'
import { LiveBlockStore, LiveBlockStoreContext } from '@slayzone/terminal/live-blocks'
import { isAwaitingUserQuestion } from '@slayzone/terminal/reducer'
import {
  type ComponentRef,
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import type { ChromeColors } from '../theme'
import { BackgroundJobs } from './BackgroundJobs'
import { ChatControls } from './ChatControls'
import { ChatTimeline } from './ChatTimeline'
import { ChatViewContext, type ChatViewValue } from './ChatViewContext'
import { Composer } from './Composer'
import { PromptDock } from './PromptDock'
import { MONO, useThemedStyles } from './styles'
import { useTRPCClient } from '../trpc'
import { useChatComposer } from './useChatComposer'
import { useChatCwd } from './useChatCwd'
import { useChatQueue } from './useChatQueue'
import { type ChatTarget, useChatSession } from './useChatSession'
import { useChatSettings } from './useChatSettings'
import { useSlashCommands } from './useSlashCommands'

export function ChatSession({
  hubId,
  taskId,
  tabId,
  mode
}: {
  hubId: string
  taskId: string
  tabId: string
  mode: string
}): JSX.Element {
  const { s, theme } = useThemedStyles(makeStyles)
  // Fail loud when mounted in another hub's scope: every call would go to that hub.
  const scopedHub = useHubId()
  const cwd = useChatCwd(taskId, tabId)
  if (scopedHub !== null && scopedHub !== hubId) {
    return <Text style={s.note}>This chat belongs to another hub.</Text>
  }
  switch (cwd.status) {
    case 'loading':
      return (
        <View style={s.center} testID="chat-resolving">
          <ActivityIndicator color={theme.foreground} />
        </View>
      )
    case 'none':
      // A chosen folder that is gone is "not found" (desktop's task page words).
      return cwd.notFound ? (
        <View style={s.notFound}>
          <Text style={s.notFoundText}>Folder not found on this task’s machine</Text>
          <Text style={s.notFoundPath} selectable>
            {cwd.notFound}
          </Text>
          <Text style={s.notFoundText}>
            It may have moved or been deleted. Pick it again in project settings.
          </Text>
        </View>
      ) : (
        <Text style={s.note}>
          This task has no folder to run in: set the project's folder or the task's base dir.
        </Text>
      )
    case 'error':
      return (
        <View style={s.center}>
          <Text style={s.note}>{cwd.message}</Text>
          <Pressable onPress={cwd.retry} accessibilityRole="button">
            <Text style={s.link}>Retry</Text>
          </Pressable>
        </View>
      )
    case 'ready':
      return (
        <ChatView
          key={`${tabId}\n${cwd.cwd}`}
          target={{ tabId, taskId, mode, cwd: cwd.cwd, providerFlagsOverride: null }}
        />
      )
  }
}

function ChatView({ target }: { target: ChatTarget }) {
  const { s } = useThemedStyles(makeStyles)
  const caps = chatCapabilitiesForMode(target.mode)
  const notice = useNotice()
  const { show: notify } = notice
  const session = useChatSession(target)
  const { state } = session
  const slash = useSlashCommands({
    taskId: target.taskId,
    mode: target.mode,
    cwd: target.cwd,
    caps,
    liveCliList: state.cliCommands,
    liveCliDetails: state.cliCommandDetails
  })
  const queue = useChatQueue(target.tabId, (original) => {
    const token = /^\/([a-zA-Z0-9_:-]+)/.exec(original.trim())?.[1]
    const hit = token ? slash.items.find((i) => i.name === token) : undefined
    if (hit) slash.bump({ source: hit.source, name: hit.name })
  })
  const settings = useChatSettings(target, state.permissionMode, notify)

  const [restarting, setRestarting] = useState(false)
  const ended = state.sessionEnded && !state.notStarted && !restarting
  const composer = useChatComposer({
    target,
    caps,
    session,
    queue,
    settings,
    slash,
    notify,
    sessionEnded: ended
  })

  // A session that ended clears its queue (desktop does the same).
  const { clear: clearQueue } = queue
  useEffect(() => {
    if (state.sessionEnded) void clearQueue().catch(() => undefined)
  }, [state.sessionEnded, clearQueue])

  const client = useTRPCClient()
  const restart = useCallback(() => {
    setRestarting(true)
    client.chat.start
      .mutate({ ...target, reason: 'user' })
      .catch((err: unknown) =>
        notify(`Restart failed: ${err instanceof Error ? err.message : String(err)}`)
      )
      .finally(() => setRestarting(false))
  }, [client, target, notify])

  const { respondPermission, sendMessage, retryMessage } = session
  const answer = useCallback(
    (requestId: string, optionId: string, decision: PermissionDecision) =>
      respondPermission({ requestId, decision, optionId }).then(
        (ok) => {
          if (!ok) notify('This request is no longer active — Claude stopped waiting for it.')
          return ok
        },
        (err: unknown) => {
          notify(`Could not send the answer: ${err instanceof Error ? err.message : String(err)}`)
          return false
        }
      ),
    [respondPermission, notify]
  )

  // What streams right now reaches only the rows that stream (desktop's live store).
  const [liveStore] = useState(() => new LiveBlockStore())
  useLayoutEffect(() => {
    liveStore.publish(state.live)
  }, [liveStore, state.live])

  const takeOver = useCallback(() => {
    client.chat.takeOver
      .mutate(target)
      .catch((err: unknown) =>
        notify(`Couldn't continue here: ${err instanceof Error ? err.message : String(err)}`)
      )
  }, [client, target, notify])

  const view = useMemo<ChatViewValue>(
    () => ({
      tabId: target.tabId,
      retryMessage: (id) => void retryMessage(id),
      prompts: state.prompts,
      restartAgent: restart,
      takeOver
    }),
    [target.tabId, retryMessage, state.prompts, restart, takeOver]
  )

  // The keyboard lifts the composer by what it covers of THIS view: its offset is how
  // far the view sits below the top of the window (the screen's header, safe area…),
  // measured, so the parent need not know or pass it.
  const rootRef = useRef<ComponentRef<typeof View>>(null)
  const [top, setTop] = useState(0)
  const measure = useCallback(() => {
    rootRef.current?.measureInWindow((_x: number, y: number) =>
      setTop((prev) => (prev === y ? prev : y))
    )
  }, [])

  const awaitingUser = caps.promptCards ? hasPendingPrompt(state) : isAwaitingUserQuestion(state)
  return (
    <ChatViewContext.Provider value={view}>
      <LiveBlockStoreContext.Provider value={liveStore}>
        <KeyboardAvoidingView
          style={s.root}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={top}
          testID="chat-session"
        >
          <View ref={rootRef} onLayout={measure} style={s.probe} />
          <ChatControls mode={target.mode} settings={settings} />
          <BackgroundJobs state={state} tabId={target.tabId} onError={notify} />
          <ChatTimeline
            state={state}
            hydrating={session.hydrating}
            working={session.inFlight && !awaitingUser}
            emptyText="Send a message to start."
          />
          {session.loadError && (
            <View style={s.bar}>
              <Text style={s.barText} numberOfLines={2}>
                Couldn't load the chat: {session.loadError}
              </Text>
              <Pressable onPress={session.reload} accessibilityRole="button">
                <Text style={s.link}>Retry</Text>
              </Pressable>
            </View>
          )}
          {caps.promptCards && (
            <PromptDock
              prompts={state.prompts}
              submitting={session.submittingPrompts}
              answer={answer}
              autoModeAvailable={settings.autoOptedIn}
              cwd={target.cwd}
              timeline={state.timeline}
              sendMessage={(text) => void sendMessage(text).catch(() => undefined)}
            />
          )}
          {ended && (
            <View style={s.bar}>
              <Text style={s.barText}>Session ended</Text>
              <Pressable onPress={restart} accessibilityRole="button" disabled={restarting}>
                <Text style={s.link}>Restart</Text>
              </Pressable>
            </View>
          )}
          {notice.text && (
            <Text style={s.notice} accessibilityLiveRegion="polite">
              {notice.text}
            </Text>
          )}
          <Composer
            composer={composer}
            queued={queue.items}
            onRemoveQueued={(id) => void queue.remove(id).catch(() => undefined)}
            inFlight={session.inFlight}
            disabled={session.hydrating || ended}
            placeholder={session.inFlight ? 'Queue a message…' : 'Message'}
          />
        </KeyboardAvoidingView>
      </LiveBlockStoreContext.Provider>
    </ChatViewContext.Provider>
  )
}

const NOTICE_MS = 4_000

/** A short message above the composer (desktop's toasts), gone after a few seconds. */
function useNotice(): { text: string | null; show: (message: string) => void } {
  const [text, setText] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((message: string) => {
    setText(message)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setText(null), NOTICE_MS)
  }, [])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return { text, show }
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    probe: { height: 0 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' },
    notFound: { padding: 24, gap: 8 },
    notFoundText: { color: t.mutedForeground, textAlign: 'center' },
    notFoundPath: { color: t.mutedForeground, textAlign: 'center', fontFamily: MONO, fontSize: 12 },
    link: { color: t.infoForeground, fontSize: 14, fontWeight: '600' },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginHorizontal: 8,
      marginBottom: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: t.surface2
    },
    barText: { flex: 1, color: t.foreground, fontSize: 13 },
    notice: { color: t.mutedForeground, fontSize: 13, marginHorizontal: 16, marginBottom: 6 }
  })
}
