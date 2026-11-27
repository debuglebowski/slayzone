/**
 * A full chat view for one chat tab (`claude-chat` / `codex-chat`) of a task, built on
 * desktop's shared chat logic, not its DOM components: the timeline (desktop's reducer),
 * the composer with the `/` menu and the queue, the "waiting for you" dock, the mode /
 * model / effort chips (or, `controls="page"`, none: the page shows them, `onChrome`),
 * and the background jobs.
 * On the phone's task page (`useTaskChrome`) the timeline scrolls under the page's top
 * bar and the composer floats on its tab bar. Rendered inside the `HubScope` of the
 * hub that owns the task (every call goes to that hub).
 *
 * First the tab's folder is resolved (`useChatCwd`): the hub keys a chat tab by it, so
 * the view mounts only once it is known — keyed by tab and folder, so nothing of one
 * session can leak into another.
 */
import { useHubId } from '@slayzone/transport/client'
import {
  chatCapabilitiesForMode,
  chatAvailabilityMessage,
  type ChatModelsView,
  chatProviderForMode,
  type PermissionDecision
} from '@slayzone/terminal-contracts'
import {
  useChatAvailability,
  useResumeHibernatedChat
} from '@slayzone/terminal/client/chat-availability'
import { hasPendingPrompt } from '@slayzone/terminal/chat-prompts'
import { LiveBlockStore, LiveBlockStoreContext } from '@slayzone/terminal/live-blocks'
import { isAwaitingUserQuestion } from '@slayzone/terminal/reducer'
import { selectCodexPlanReview } from '@slayzone/terminal/reducer'
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
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTaskChrome } from '../task/task-chrome'
import type { ChromeColors } from '../theme'
import { BackgroundJobs } from './BackgroundJobs'
import { ChatControls } from './ChatControls'
import { CodexPlanPrompt } from './CodexPlanPrompt'
import { ChatTimeline } from './ChatTimeline'
import { ChatViewContext, type ChatViewValue } from './ChatViewContext'
import { Composer } from './Composer'
import { PromptDock } from './PromptDock'
import { MONO, useThemedStyles } from './styles'
import { useTRPCClient } from '../trpc'
import { useKeyboardOverlap } from './use-keyboard'
import { useChatAttach } from './useChatAttach'
import { useChatComposer } from './useChatComposer'
import { useChatCwd } from './useChatCwd'
import { useChatQueue } from './useChatQueue'
import { type ChatTarget, useChatSession } from './useChatSession'
import { useChatModels } from './useChatModels'
import { type ChatSettings, useChatSettings } from './useChatSettings'

/** What a chat hands the page that shows its controls (`controls="page"`). */
export interface ChatChrome {
  /** The chat's agent mode (`claude-chat`, `codex-chat`). */
  mode: string
  settings: ChatSettings
  models: ChatModelsView
  /** The agent waits for the user's answer (a permission, a question, a plan). */
  waiting: boolean
}
import { useSlashCommands } from './useSlashCommands'
import { useStableCallback } from './useStableCallback'

export function ChatSession({
  hubId,
  taskId,
  tabId,
  mode,
  controls = 'chips',
  onChrome
}: {
  hubId: string
  taskId: string
  tabId: string
  mode: string
  /**
   * The mode / model / effort controls: `chips`, a row above the timeline; `page`,
   * none — the page shows them from what `onChrome` hands it (the phone task page's
   * agent card).
   */
  controls?: 'chips' | 'page'
  /** `controls="page"`: the chat's controls and whether it waits, whenever they change. */
  onChrome?: (chrome: ChatChrome | null) => void
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
          <ActivityIndicator accessibilityLabel="Loading chat" color={theme.foreground} />
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
          key={JSON.stringify([tabId, mode, cwd.cwd])}
          target={{ tabId, taskId, mode, cwd: cwd.cwd, providerFlagsOverride: null }}
          controls={controls}
          {...(onChrome ? { onChrome } : {})}
        />
      )
  }
}

function ChatView({
  target,
  controls,
  onChrome
}: {
  target: ChatTarget
  controls: 'chips' | 'page'
  onChrome?: (chrome: ChatChrome | null) => void
}) {
  const { s } = useThemedStyles(makeStyles)
  const chrome = useTaskChrome()
  const caps = chatCapabilitiesForMode(target.mode)
  const provider = chatProviderForMode(target.mode)
  const notice = useNotice()
  const { show: notify } = notice
  const session = useChatSession(target)
  const storage = useChatAvailability({
    tabId: target.tabId,
    active: true,
    historyReady: !session.hydrating && !session.loadError,
    onReady: session.reload
  })
  const storageMessage = storage.status ? chatAvailabilityMessage(storage.status) : null
  const storageError = session.loadError ?? storage.error
  const { state } = session
  const settings = useChatSettings(target, state.permissionMode, notify)
  const models = useChatModels({
    taskId: target.taskId,
    mode: target.mode,
    sessionKey: state.sessionId
  })
  // `/effort`'s description: the levels the composer's check (`planSend`) accepts.
  const effortLevels = useMemo(() => models.effortChoices(settings.model), [models, settings.model])
  const slash = useSlashCommands({
    taskId: target.taskId,
    mode: target.mode,
    cwd: target.cwd,
    caps,
    liveCliList: state.cliCommands,
    liveCliDetails: state.cliCommandDetails,
    effortLevels
  })
  const queue = useChatQueue(
    target.tabId,
    (original) => {
      const token = /^\/([a-zA-Z0-9_:-]+)/.exec(original.trim())?.[1]
      const hit = token ? slash.items.find((i) => i.name === token) : undefined
      if (hit) slash.bump({ source: hit.source, name: hit.name })
    },
    target.mode
  )
  const codexPlanReview = useMemo(
    () =>
      target.mode === 'codex-chat'
        ? selectCodexPlanReview(
            state.timeline,
            settings.collaboration === 'plan' ? 'plan' : 'default'
          )
        : null,
    [target.mode, state.timeline, settings.collaboration]
  )

  const [restarting, setRestarting] = useState(false)
  const ended = state.sessionEnded && !state.notStarted && !restarting
  const composer = useChatComposer({
    target,
    caps,
    session,
    queue,
    settings,
    models,
    slash,
    notify,
    sessionEnded: ended
  })

  const attach = useChatAttach({
    taskId: target.taskId,
    caps,
    onAttached: composer.addAttachments,
    notify
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
  useResumeHibernatedChat({
    tabId: target.tabId,
    active: true,
    ready: !session.hydrating && !session.loadError && storage.status?.state === 'ready',
    hibernated: storage.status?.hibernated === true,
    resume: restart
  })

  const { respondPermission, sendMessage, retryMessage } = session
  const answer = useCallback(
    (requestId: string, optionId: string, decision: PermissionDecision) =>
      respondPermission({ requestId, decision, optionId }).then(
        (ok) => {
          if (!ok)
            notify(`This request is no longer active — ${provider.agent} stopped waiting for it.`)
          return ok
        },
        (err: unknown) => {
          notify(`Could not send the answer: ${err instanceof Error ? err.message : String(err)}`)
          return false
        }
      ),
    [respondPermission, notify, provider.agent]
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

  const { readToolDetail } = session
  const view = useMemo<ChatViewValue>(
    () => ({
      tabId: target.tabId,
      readToolDetail,
      retryMessage: (id) => void retryMessage(id),
      prompts: state.prompts,
      restartAgent: restart,
      takeOver,
      agentName: provider.agent
    }),
    [target.tabId, readToolDetail, retryMessage, state.prompts, restart, takeOver, provider.agent]
  )

  // The keyboard lifts the composer by what it covers of THIS view, measured where the
  // view sits in the window — on its own layout and once the keyboard has moved — so
  // the parent need not know or pass an offset, and a screen above that moves (the task
  // page's title line steps aside while typing) never leaves it stale.
  const rootRef = useRef<ComponentRef<typeof View>>(null)
  const keyboard = useKeyboardOverlap(rootRef)

  const awaitingUser = caps.promptCards ? hasPendingPrompt(state) : isAwaitingUserQuestion(state)

  // The page shows the controls: hand them over when what they show changes — a value
  // the tiles show, not the settings object's identity (new every render).
  const { changing } = settings
  const shown = [
    target.mode,
    settings.mode,
    settings.model,
    settings.effort,
    settings.collaboration,
    settings.autoEligible,
    settings.autoOptedIn,
    changing.mode,
    changing.model,
    changing.effort,
    changing.collaboration,
    awaitingUser
  ].join('\u0000')
  const handOver = useStableCallback(() =>
    onChrome?.({ mode: target.mode, settings, models, waiting: awaitingUser })
  )
  useEffect(() => {
    handOver()
  }, [handOver, shown, models])
  useEffect(() => () => onChrome?.(null), [onChrome])
  const agentName = provider.agent
  const placeholder = chrome
    ? session.inFlight
      ? `Queue for ${agentName}…`
      : state.timeline.length > 0
        ? `Reply to ${agentName}…`
        : `Message ${agentName}…`
    : session.inFlight
      ? 'Queue a message…'
      : 'Message'
  return (
    <ChatViewContext.Provider value={view}>
      <LiveBlockStoreContext.Provider value={liveStore}>
        <View
          ref={rootRef}
          onLayout={keyboard.onLayout}
          style={[
            s.root,
            keyboard.bottom > 0
              ? { paddingBottom: keyboard.bottom }
              : chrome
                ? { paddingBottom: chrome.composer.bottom }
                : null
          ]}
          testID="chat-session"
        >
          {controls === 'chips' && (
            <ChatControls mode={target.mode} settings={settings} models={models} />
          )}
          <BackgroundJobs state={state} tabId={target.tabId} onError={notify} />
          {storage.status?.hibernated && !restarting && (
            <Text style={s.note}>Hibernated · resumes on open</Text>
          )}
          <ChatTimeline
            state={state}
            agentName={agentName}
            productName={provider.product}
            hydrating={session.hydrating}
            working={session.inFlight && !awaitingUser}
            inFlight={session.inFlight}
            reconnecting={session.reconnecting}
            olderHistory={session.olderHistory}
            loadHistoryRows={session.loadHistoryRows}
            emptyText="Send a message to start."
            {...(chrome
              ? { topInset: chrome.top, onScrollFromNewest: chrome.onTimelineScroll }
              : {})}
          />
          {codexPlanReview && (
            <CodexPlanPrompt
              key={codexPlanReview.planId}
              review={codexPlanReview}
              target={target}
              onResolved={settings.syncCollaboration}
              notify={notify}
            />
          )}
          {(storageMessage || storageError) && (
            <View style={s.bar}>
              <Text style={s.barText} accessibilityLiveRegion="polite">
                {storageMessage
                  ? `${storageMessage.title}\n${storageMessage.detail}`
                  : `Couldn't load the chat: ${storageError}`}
              </Text>
              {storage.status?.state !== 'deleted' && (
                <Pressable
                  onPress={() => {
                    void storage.retry()
                  }}
                  accessibilityRole="button"
                >
                  <Text style={s.link}>Retry</Text>
                </Pressable>
              )}
            </View>
          )}
          {caps.promptCards && (
            <PromptDock
              prompts={state.prompts}
              submitting={session.submittingPrompts}
              answer={answer}
              autoModeAvailable={settings.autoOptedIn}
              permissionMode={settings.mode}
              cwd={target.cwd}
              timeline={state.timeline}
              sendMessage={(text) => void sendMessage(text).catch(() => undefined)}
              agent={provider.agent}
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
            {...(caps.steerQueued && session.inFlight && state.prompts.length === 0
              ? {
                  onSteerQueued: (id: string) =>
                    void queue
                      .steer(id)
                      .then(
                        (result) => (result.ok ? null : result.reason),
                        (err: unknown) => (err instanceof Error ? err.message : String(err))
                      )
                      .then((reason) => {
                        if (reason !== null) {
                          notice.show(`Could not send it now: ${reason}`)
                        }
                      })
                }
              : {})}
            withdrawSteered={caps.withdrawSteered}
            cliLabel={provider.product}
            attach={attach}
            inFlight={session.inFlight}
            disabled={session.hydrating || ended}
            placeholder={placeholder}
            {...(chrome
              ? {
                  floating: {
                    start: chrome.composer.start,
                    end: chrome.composer.end,
                    keyboardUp: chrome.keyboardUp
                  }
                }
              : {})}
          />
        </View>
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
