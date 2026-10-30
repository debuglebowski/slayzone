import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction
} from 'react'
import { toast, useStableCallback, type AgentEffort, type AgentModel } from '@slayzone/ui'
import {
  attachmentEncodedBytes,
  chatCapabilitiesForMode,
  conversationBudgetError,
  isValidModelForMode,
  modelLabelForMode,
  modelsForMode,
  userMessageAttachments,
  type ChatAttachment,
  type CliCommandList,
  type StopResult,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import { useTRPCClient } from '../trpc'
import { useChatQueue } from './useChatQueue'
import { useAutocomplete } from './autocomplete/useAutocomplete'
import { createSkillsSource } from './autocomplete/sources/skills'
import { createCommandsSource } from './autocomplete/sources/commands'
import { createCliCustomCommandsSource } from './autocomplete/sources/cli-custom-commands'
import { createAgentsSource } from './autocomplete/sources/agents'
import { createBuiltinsSource } from './autocomplete/sources/builtins'
import { createFilesSource } from './autocomplete/sources/files'
import { cliCommandItems, createCliCommandsSource } from './autocomplete/sources/cli-commands'
import { usePromptHistory } from './usePromptHistory'
import { useChatDraftPersistence } from './composer-state/useChatDraftPersistence'
import { HISTORY_IDLE, historyStep, isBrowsingHistory, type HistoryNav } from './prompt-history'
import type {
  AutocompleteSource,
  ChatActions,
  ChatListApi,
  NavigateActions
} from './autocomplete/types'

export interface UseChatComposerOpts {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
  isActive: boolean
  /** Text alone as a string; files (and text) as content blocks. */
  sendMessage: (input: string | UserContentBlock[]) => Promise<void>
  inFlight: boolean
  sessionEnded: boolean
  /** Stop; a popped message comes back whole (`id`, `content`, `text`). */
  abortAndPop: () => Promise<StopResult>
  chatApi: ChatActions
  navigate: NavigateActions
  getArtifactFilePath: (id: string) => Promise<string | null>
  scrollToBottom: () => void
  handleEffortChange: (next: AgentEffort) => Promise<void>
  handleModelChange: (next: AgentModel) => Promise<void>
  /** The chat CLI's slash commands (live or last known); null when unknown / not offered. */
  cliCommands: CliCommandList | null
  /** Encoded bytes of the files the conversation already carries (its attachment budget). */
  attachmentsUsedBytes?: number
  /**
   * Stop the running turn WITHOUT dropping the queue (so the next queued
   * message goes next). Provided → queued messages get "Send now".
   */
  interruptTurn?: () => Promise<void>
}

/**
 * Owns the chat composer: the draft + attachment state, the autocomplete it
 * feeds, the "Up next" queue, and the full submit/stop pipeline.
 *
 * Why these live together: `useAutocomplete` reads `draft`/`cursorPos` and
 * mutates via `setDraft`, while `handleSend`/`onKeyDown` read back from the
 * autocomplete (transformSubmit, bumpUsageFromMessage, handleKeyDown). The
 * chain is draft-state → queue → autocomplete → send/key handlers, so keeping
 * it in one hook avoids handing the autocomplete object back into its own
 * creator. The component just consumes the returned values + callbacks.
 *
 * `bumpUsageRef` is forward-declared so the queue's drain callback can bump
 * autocomplete usage counts with the raw `original` text; it's wired to
 * `autocomplete.bumpUsageFromMessage` once that hook has run.
 */
export function useChatComposer({
  tabId,
  taskId,
  mode,
  cwd,
  providerFlagsOverride,
  isActive,
  sendMessage,
  inFlight,
  sessionEnded,
  abortAndPop,
  chatApi,
  navigate,
  getArtifactFilePath,
  scrollToBottom,
  handleEffortChange,
  handleModelChange,
  cliCommands,
  attachmentsUsedBytes = 0,
  interruptTurn
}: UseChatComposerOpts) {
  const trpcClient = useTRPCClient()
  const capabilities = chatCapabilitiesForMode(mode)
  const [draft, setDraftState] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  // Anything (typing, Stop's restore, Reset, a history pick, a send) set the
  // draft: a saved draft that arrives later must not overwrite it.
  const [touched, setTouched] = useState(false)
  const setDraft = useStableCallback((next: SetStateAction<string>) => {
    setTouched(true)
    setDraftState(next)
  })
  // Prompt history (↑/↓ recall, Ctrl+R search) — modes with `promptHistory` only.
  const { entries: historyEntries, record: recordHistory } = usePromptHistory({
    taskId,
    enabled: capabilities.promptHistory
  })
  const [historyNav, setHistoryNav] = useState<HistoryNav>(HISTORY_IDLE)
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const browsingHistory = isBrowsingHistory(historyNav, draft, historyEntries)
  // Forward-declared like bumpUsageRef: the autocomplete sends a picked command
  // through `handleSend`, which is defined after (and reads) the autocomplete.
  const submitRef = useRef<(text: string) => void>(() => {
    // Placeholder until the insertion effect below wires `handleSend`.
  })
  const submitFromMenu = useStableCallback((text: string) => submitRef.current(text))
  // Forward-declared ref — wired to autocomplete.bumpUsageFromMessage further
  // down once the autocomplete hook has run. The drain callback closes over
  // this ref, so the assignment lands before the first onDrained fires.
  const bumpUsageRef = useRef<(text: string) => Promise<void> | void>(() => {
    // Placeholder until the assignment below swaps in the real bump. A drain that
    // somehow fires first has no usage counts to bump yet anyway.
  })
  /**
   * "Up next" queue lives in SQLite (table `chat_queue`) — survives reload,
   * sync's across windows, drained main-side on session→idle. Hook is a
   * subscriber + thin RPC facade. `onDrained` fires after the main process
   * pops + dispatches; carry the raw `original` text into the autocomplete
   * usage hook so /-token tiebreak counts bump exactly as the pre-backend
   * implementation did.
   */
  const {
    items: queuedMessages,
    push: pushQueue,
    remove: removeQueue,
    clear: clearQueue,
    update: updateQueue,
    move: moveQueue,
    hold: holdQueue,
    release: releaseQueue
  } = useChatQueue(
    tabId,
    useStableCallback((original: string) => {
      void bumpUsageRef.current(original)
    })
  )
  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>([])
  const setAttachments = useStableCallback((next: SetStateAction<ChatAttachment[]>) => {
    setTouched(true)
    setAttachmentsState(next)
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The tab's draft survives remounts and reloads (`restoreComposerState`).
  const persistence = useChatDraftPersistence({
    tabId,
    enabled: capabilities.restoreComposerState,
    text: draft,
    attachments,
    paused: browsingHistory
  })
  // Restore once, as soon as the saved draft is known — adjusted during render,
  // so the first painted frame already shows it.
  const [restore, setRestore] = useState<{ done: boolean; text: string | null }>({
    done: false,
    text: null
  })
  if (!restore.done && persistence.loaded) {
    const saved = capabilities.restoreComposerState && !touched ? persistence.saved : null
    setRestore({ done: true, text: saved?.text ?? null })
    if (saved) {
      setDraftState(saved.text)
      setAttachmentsState(saved.attachments)
      setCursorPos(saved.text.length)
    }
  }
  // Snapshot of the in-flight turn's raw input + attachments. Used by Stop/Esc
  // to restore the chips + clean text (without inline image markdown) when the
  // main side pops the turn. Updated only on user submits that go straight to
  // the wire — queued submits don't overwrite it, so the snapshot stays aligned
  // with the in-flight turn even when a queue exists.
  const lastSentRef = useRef<{ text: string; attachments: ChatAttachment[] } | null>(null)

  // Auto-focus composer when this task tab becomes active (mount-while-active
  // or inactive→active transition). Tab content stays mounted with display:none
  // when inactive, so a mount-only autoFocus would miss tab switches.
  useEffect(() => {
    if (isActive) textareaRef.current?.focus()
  }, [isActive])

  // Project-metadata facade for the autocomplete sources. tRPC client is a stable
  // context singleton, so this object identity is fixed across renders.
  const listApi = useMemo<ChatListApi>(
    () => ({
      listSkills: (cwd) => trpcClient.chat.listSkills.query({ cwd }),
      listCommands: (cwd, opts) => trpcClient.chat.listCommands.query({ cwd, ...opts }),
      listAgents: (cwd) => trpcClient.chat.listAgents.query({ cwd }),
      listFiles: (cwd, query, limit) => trpcClient.chat.listFiles.query({ cwd, query, limit })
    }),
    [trpcClient]
  )

  // Send a prompt the way the composer does: behind a running turn it waits in
  // the queue (FIFO, survives reload), otherwise it goes now. Commands that send
  // a prompt (custom commands, /init, /review) use this — they used to skip the
  // queue and could land in the middle of a turn.
  const submitPrompt = useStableCallback(async (toSend: string, original: string) => {
    if (inFlight || queuedMessages.length > 0) {
      await pushQueue(toSend, original)
      return
    }
    await sendMessage(toSend)
  })

  // The CLI's own commands — only where the provider runs slash commands itself.
  const cliList = capabilities.nativeSlashCommands ? cliCommands : null
  // TUI parity: right after a parked `/name ` the command's argument hint shows
  // as ghost text (from the CLI's `initialize` reply).
  const parked = /^\/(\S+) $/.exec(draft)
  const argumentHint =
    parked && cursorPos === draft.length
      ? cliList?.details?.[parked[1]]?.argumentHint || null
      : null
  const sources = useMemo(
    () => [
      createFilesSource(listApi),
      // A CLI that runs slash commands expands custom-command templates itself:
      // send the typed `/name args`. Otherwise expand them here.
      capabilities.nativeSlashCommands
        ? createCliCustomCommandsSource(listApi, cliList)
        : createCommandsSource((text) => submitPrompt(text, text).then(() => true), listApi),
      createAgentsSource(listApi),
      createBuiltinsSource({
        cliCommandNames: new Set(cliCommandItems(cliList).map((c) => c.name)),
        capabilities
      }),
      createSkillsSource(listApi),
      createCliCommandsSource(cliList)
    ],
    [submitPrompt, listApi, cliList, capabilities]
  ) as AutocompleteSource[]

  const autocomplete = useAutocomplete({
    sources,
    draft,
    setDraft,
    cursorPos,
    fetchCtx: { cwd },
    acceptCtx: {
      session: { tabId, taskId, mode, cwd, providerFlagsOverride: providerFlagsOverride ?? null },
      chat: chatApi,
      navigate,
      toast: (msg) => toast(msg),
      submit: (text) => submitPrompt(text, text)
    },
    enterPolicy: capabilities.nativeSlashCommands ? 'native-commands' : 'accept-selected',
    submit: submitFromMenu,
    // A recalled `/command` prompt must not reopen the menu and steal ↑/↓.
    suppressed: browsingHistory
  })

  // Autosize textarea. Height follows scrollHeight up to 240px; no artificial min —
  // an empty draft renders as a single-line input.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  // Snap timeline to bottom when user starts composing — empty→non-empty edge.
  // Stick-to-bottom only auto-sticks when already at bottom; this forces re-stick
  // so the latest history is visible while typing.
  // A restored draft is not "starting to compose": the timeline keeps its place.
  const wasDraftEmptyRef = useRef(true)
  useEffect(() => {
    const empty = draft.length === 0
    if (wasDraftEmptyRef.current && !empty && draft !== restore.text) {
      void scrollToBottom()
    }
    wasDraftEmptyRef.current = empty
  }, [draft, scrollToBottom, restore.text])

  // `textOverride`: a command the `/` menu resolved on Enter (sent instead of the draft).
  const handleSend = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? draft).trim()
      if (sessionEnded) return
      if (!text && attachments.length === 0) return
      setHistoryNav(HISTORY_IDLE)
      if (text) recordHistory(text)

      // Builtin `/effort <level>` — write enum to provider_config; setEffort
      // handler kill+respawns. Mirrors the AgentEffortPill path; both UIs go
      // through the same canonical field, no flag-string mutation.
      const effortMatch = /^\/effort\s+(\S+)\s*$/.exec(text)
      if (effortMatch) {
        const raw = effortMatch[1].toLowerCase()
        const valid = ['low', 'medium', 'high', 'xhigh', 'max'] as const
        if (!(valid as readonly string[]).includes(raw)) {
          toast(`Invalid effort level "${raw}". Use: ${valid.join(', ')}`)
          return
        }
        setDraft('')
        await handleEffortChange(raw as (typeof valid)[number])
        toast(`Effort set to ${raw}`)
        return
      }

      // Builtin `/model <id>` — where the CLI runs slash commands itself, its own
      // /model would switch only the running process (the pill and the next
      // respawn's --model would not follow). Route through the model pill's path.
      const modelMatch = capabilities.nativeSlashCommands ? /^\/model\s+(\S+)\s*$/.exec(text) : null
      if (modelMatch) {
        const id = modelMatch[1]
        if (!isValidModelForMode(mode, id)) {
          toast(
            `Unknown model "${id}". Use: ${modelsForMode(mode)
              .map((m) => m.id)
              .join(', ')}`
          )
          return
        }
        setDraft('')
        await handleModelChange(id)
        toast(`Model set to ${modelLabelForMode(mode, id)}`)
        return
      }

      // Allow sources (e.g. commands) to transform `/cmdname args` into expanded template.
      const transform = autocomplete.transformSubmit(text)
      let toSend = transform?.send ?? text

      if (capabilities.attachments === 'blocks') {
        // Files travel as references (the server reads them at write time). The
        // typed text goes LAST: Claude Code reads the last text block as the
        // input, so a `/command` there still runs with the files attached.
        const files = attachments
        if (files.length > 0) {
          let used = attachmentsUsedBytes
          for (const q of queuedMessages) {
            for (const a of userMessageAttachments(q.content ?? []))
              used += attachmentEncodedBytes(a)
          }
          const overBudget = conversationBudgetError(used, files)
          if (overBudget) {
            toast(overBudget)
            return
          }
        }
        const content: UserContentBlock[] = [
          ...files.map((attachment) => ({ type: 'attachment' as const, attachment })),
          ...(toSend ? [{ type: 'text' as const, text: toSend }] : [])
        ]
        // Clear BEFORE anything is awaited: the draft is saved per tab, and a
        // save in between would bring the sent text back.
        setDraft('')
        setAttachments([])
        void scrollToBottom()
        if (inFlight || queuedMessages.length > 0) {
          await (files.length > 0 ? pushQueue(toSend, text, content) : pushQueue(toSend, text))
          return
        }
        lastSentRef.current = { text, attachments: [...files] }
        await sendMessage(files.length > 0 ? content : toSend)
        void bumpUsageRef.current(text)
        return
      }

      // Materialize image attachments to abs filesystem paths and prepend to message.
      if (attachments.length > 0) {
        const resolved = await Promise.all(
          attachments.map(async (a) => {
            const p = await getArtifactFilePath(a.artifactId)
            return { ref: a, path: p }
          })
        )
        const missing = resolved.filter((r) => r.path === null)
        if (missing.length > 0) {
          toast(
            `${missing.length} image${missing.length === 1 ? '' : 's'} no longer available — skipping`
          )
        }
        const imageRefs = resolved
          .filter((r): r is { ref: ChatAttachment; path: string } => r.path !== null)
          .map((r) => `![${r.ref.name}](${r.path})`)
          .join('\n')
        // Join only what is there: no attachment left means just the text (it
        // used to start with a blank line).
        toSend = [imageRefs, toSend].filter(Boolean).join('\n\n')
      }

      // Capture raw input + attachments BEFORE clearing — used by Stop/Esc to
      // restore them if the turn is popped. Skip when queueing: lastSentRef must
      // remain aligned with the in-flight turn, not the queued one.
      const snapshot = { text, attachments: [...attachments] }
      setDraft('')
      setAttachments([])
      void scrollToBottom()
      if (!toSend) return
      // Queue when a turn is in flight OR a queue already exists (preserve FIFO
      // even after reload — the renderer's `inFlight` mirror could be `false`
      // while persisted queue items still need to flush in order). Backend
      // drainer pops on session→idle.
      if (inFlight || queuedMessages.length > 0) {
        await pushQueue(toSend, text)
        return
      }
      lastSentRef.current = snapshot
      await sendMessage(toSend)
      // Bump usage from the ORIGINAL `text` — slash tokens may not survive template
      // expansion. Only fires after sendMessage resolves (closest signal we have to
      // a successful send; sendMessage doesn't throw on failure). Read fn via ref
      // so we don't add `autocomplete` to deps — its returned object is a fresh
      // ref each render and would over-fire dependent effects.
      void bumpUsageRef.current(text)
    },
    [
      draft,
      attachments,
      getArtifactFilePath,
      inFlight,
      pushQueue,
      sessionEnded,
      sendMessage,
      autocomplete,
      scrollToBottom,
      handleEffortChange,
      handleModelChange,
      capabilities.nativeSlashCommands,
      capabilities.attachments,
      attachmentsUsedBytes,
      queuedMessages,
      mode,
      recordHistory,
      setDraft,
      setAttachments
    ]
  )

  // Wire the forward-declared bumpUsageRef now that autocomplete is in scope.
  // `autocomplete` is a fresh object every render (useAutocomplete returns
  // an object literal); reading via ref keeps the backend drain callback
  // stable so onDrained subscribers don't churn. Written in an insertion effect
  // (not during render) — every reader (drain events, post-send bump) runs
  // after commit, so it always sees this commit's function.
  const bumpUsageFromMessage = autocomplete.bumpUsageFromMessage
  useInsertionEffect(() => {
    bumpUsageRef.current = bumpUsageFromMessage
    submitRef.current = (text) => {
      void handleSend(text)
    }
  })

  // Stop button + Esc shared path. Clears the queue (intentional: queued msgs
  // are abandoned alongside the in-flight turn — the main side wipes
  // chat_queue inside chat:abortAndPop too, this client-side clear is a
  // belt-and-suspenders for instant UI feedback before the broadcast lands).
  // Aborts the turn on the main side and — if no progress had arrived —
  // restores the popped text + attachments to the composer for editing.
  // Skips restore when the user has already started typing again (draft
  // non-empty). The result carries the popped message whole (`id`, `content`
  // with its attachment blocks), not only its text.
  const handleStop = useCallback(async () => {
    void clearQueue()
    const result = await abortAndPop()
    if (!result.popped) return
    if (draft.trim() !== '') return
    const snap = lastSentRef.current
    if (snap) {
      setDraft(snap.text)
      setAttachments(snap.attachments)
    } else {
      // Remounted since it was sent (no local snapshot): the popped message's
      // own content brings its files back too.
      const files = userMessageAttachments(result.content ?? [])
      if (result.text) setDraft(result.text)
      if (files.length > 0) setAttachments(files)
    }
    lastSentRef.current = null
    textareaRef.current?.focus()
  }, [abortAndPop, draft, clearQueue, setDraft, setAttachments])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+R (physical Ctrl, also on macOS) searches the prompt history.
      // Windows/Linux: the app's reload-browser shortcut (mod+r) takes Ctrl+R first.
      if (
        capabilities.promptHistory &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'r'
      ) {
        e.preventDefault()
        setHistorySearchOpen(true)
        return
      }
      if (autocomplete.handleKeyDown(e)) return
      if (
        capabilities.promptHistory &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const el = e.currentTarget
        const step = historyStep({
          nav: historyNav,
          key: e.key === 'ArrowUp' ? 'up' : 'down',
          draft,
          caretAtStart: el.selectionStart === 0 && el.selectionEnd === 0,
          entries: historyEntries
        })
        if (step) {
          e.preventDefault()
          setHistoryNav(step.nav)
          setDraft(step.draft)
          setCursorPos(step.draft.length)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        void handleSend()
      }
    },
    [
      handleSend,
      autocomplete,
      capabilities.promptHistory,
      historyNav,
      draft,
      historyEntries,
      setDraft
    ]
  )

  // A command run from elsewhere (the palette's Compact): sent — or queued behind
  // a running turn — without touching the draft the user is writing.
  const sendCommand = useStableCallback(async (text: string): Promise<void> => {
    if (sessionEnded) return
    void scrollToBottom()
    if (inFlight || queuedMessages.length > 0) {
      await pushQueue(text, text)
      return
    }
    lastSentRef.current = { text, attachments: [] }
    await sendMessage(text)
  })

  // Editing a queued message: its files first, its text last (as a send).
  const saveQueued = useStableCallback(
    (id: string, text: string, files: ChatAttachment[]): Promise<boolean> =>
      updateQueue(id, text, text, [
        ...files.map((attachment) => ({ type: 'attachment' as const, attachment })),
        ...(text ? [{ type: 'text' as const, text }] : [])
      ])
  )
  // An edit whose message went out meanwhile: into the composer, never lost.
  const restoreQueuedEdit = useStableCallback((text: string, files: ChatAttachment[]) => {
    setDraft((prev) => (prev.trim() ? `${prev}\n\n${text}` : text))
    if (files.length > 0) setAttachments((prev) => [...prev, ...files])
  })
  // "Send now" = this one first, then stop the turn: the queue drains it next.
  const sendQueuedNow = useStableCallback(async (id: string): Promise<void> => {
    if (!interruptTurn) return
    await moveQueue(id, 0)
    await interruptTurn()
  })
  const queueApi = {
    editable: capabilities.editableQueue,
    onMove: moveQueue,
    onHold: holdQueue,
    onRelease: releaseQueue,
    onSave: saveQueued,
    onSaveGone: restoreQueuedEdit,
    ...(interruptTurn ? { onSendNow: (id: string) => void sendQueuedNow(id) } : {})
  }

  // Ctrl+R search → the picked prompt goes into the composer for editing (not sent).
  const pickHistoryPrompt = useCallback(
    (text: string) => {
      setHistorySearchOpen(false)
      setHistoryNav(HISTORY_IDLE)
      setDraft(text)
      setCursorPos(text.length)
      textareaRef.current?.focus()
    },
    [setDraft]
  )
  const closeHistorySearch = useCallback(() => {
    setHistorySearchOpen(false)
    textareaRef.current?.focus()
  }, [])

  return {
    draft,
    setDraft,
    setCursorPos,
    attachments,
    setAttachments,
    queuedMessages,
    removeQueue,
    clearQueue,
    queueApi,
    autocomplete,
    handleSend,
    handleStop,
    sendCommand,
    onKeyDown,
    textareaRef,
    argumentHint,
    historySearch: {
      open: historySearchOpen,
      entries: historyEntries,
      pick: pickHistoryPrompt,
      close: closeHistorySearch
    }
  }
}
