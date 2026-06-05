import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast, type AgentEffort } from '@slayzone/ui'
import type { ArtifactRef } from '@slayzone/editor/hooks'
import { useChatQueue } from './useChatQueue'
import { useAutocomplete } from './autocomplete/useAutocomplete'
import { createSkillsSource } from './autocomplete/sources/skills'
import { createCommandsSource } from './autocomplete/sources/commands'
import { createAgentsSource } from './autocomplete/sources/agents'
import { createBuiltinsSource } from './autocomplete/sources/builtins'
import { createFilesSource } from './autocomplete/sources/files'
import type { AutocompleteSource, ChatActions, NavigateActions } from './autocomplete/types'

export interface UseChatComposerOpts {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  providerFlagsOverride?: string | null
  isActive: boolean
  sendMessage: (text: string) => Promise<void>
  inFlight: boolean
  sessionEnded: boolean
  abortAndPop: () => Promise<{ popped: boolean; text: string | null }>
  chatApi: ChatActions
  navigate: NavigateActions
  getArtifactFilePath: (id: string) => Promise<string | null>
  scrollToBottom: () => void
  handleEffortChange: (next: AgentEffort) => Promise<void>
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
  handleEffortChange
}: UseChatComposerOpts) {
  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  // Forward-declared ref — wired to autocomplete.bumpUsageFromMessage further
  // down once the autocomplete hook has run. The drain callback closes over
  // this ref, so the assignment lands before the first onDrained fires.
  const bumpUsageRef = useRef<(text: string) => Promise<void> | void>(() => {})
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
    clear: clearQueue
  } = useChatQueue(tabId, (original) => {
    void bumpUsageRef.current(original)
  })
  const [attachments, setAttachments] = useState<ArtifactRef[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Snapshot of the in-flight turn's raw input + attachments. Used by Stop/Esc
  // to restore the chips + clean text (without inline image markdown) when the
  // main side pops the turn. Updated only on user submits that go straight to
  // the wire — queued submits don't overwrite it, so the snapshot stays aligned
  // with the in-flight turn even when a queue exists.
  const lastSentRef = useRef<{ text: string; attachments: ArtifactRef[] } | null>(null)

  // Auto-focus composer when this task tab becomes active (mount-while-active
  // or inactive→active transition). Tab content stays mounted with display:none
  // when inactive, so a mount-only autoFocus would miss tab switches.
  useEffect(() => {
    if (isActive) textareaRef.current?.focus()
  }, [isActive])

  const sources = useMemo(
    () => [
      createFilesSource(),
      createCommandsSource((text) => sendMessage(text).then(() => true)),
      createAgentsSource(),
      createBuiltinsSource(),
      createSkillsSource()
    ],
    [sendMessage]
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
      toast: (msg) => toast(msg)
    }
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
  const wasDraftEmptyRef = useRef(true)
  useEffect(() => {
    const empty = draft.length === 0
    if (wasDraftEmptyRef.current && !empty) {
      void scrollToBottom()
    }
    wasDraftEmptyRef.current = empty
  }, [draft, scrollToBottom])

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (sessionEnded) return
    if (!text && attachments.length === 0) return

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

    // Allow sources (e.g. commands) to transform `/cmdname args` into expanded template.
    const transform = autocomplete.transformSubmit(text)
    let toSend = transform?.send ?? text

    // Materialize image attachments to abs filesystem paths and prepend to message.
    if (attachments.length > 0) {
      const resolved = await Promise.all(
        attachments.map(async (a) => {
          const p = await getArtifactFilePath(a.id)
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
        .filter((r): r is { ref: ArtifactRef; path: string } => r.path !== null)
        .map((r) => `![${r.ref.title}](${r.path})`)
        .join('\n')
      toSend = imageRefs + (toSend ? `\n\n${toSend}` : '')
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
  }, [
    draft,
    attachments,
    getArtifactFilePath,
    inFlight,
    queuedMessages.length,
    pushQueue,
    sessionEnded,
    sendMessage,
    autocomplete,
    chatApi,
    tabId,
    taskId,
    mode,
    cwd,
    providerFlagsOverride,
    scrollToBottom
  ])

  // Wire the forward-declared bumpUsageRef now that autocomplete is in scope.
  // `autocomplete` is a fresh object every render (useAutocomplete returns
  // an object literal); reading via ref keeps the backend drain callback
  // stable so onDrained subscribers don't churn.
  bumpUsageRef.current = autocomplete.bumpUsageFromMessage

  // Stop button + Esc shared path. Clears the queue (intentional: queued msgs
  // are abandoned alongside the in-flight turn — the main side wipes
  // chat_queue inside chat:abortAndPop too, this client-side clear is a
  // belt-and-suspenders for instant UI feedback before the broadcast lands).
  // Aborts the turn on the main side and — if no progress had arrived —
  // restores the popped text + attachments to the composer for editing.
  // Skips restore when the user has already started typing again (draft
  // non-empty).
  const handleStop = useCallback(async () => {
    void clearQueue()
    const result = await abortAndPop()
    if (!result.popped) return
    if (draft.trim() !== '') return
    const snap = lastSentRef.current
    if (snap) {
      setDraft(snap.text)
      setAttachments(snap.attachments)
    } else if (result.text) {
      setDraft(result.text)
    }
    lastSentRef.current = null
    textareaRef.current?.focus()
  }, [abortAndPop, draft, clearQueue])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (autocomplete.handleKeyDown(e)) return
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        void handleSend()
      }
    },
    [handleSend, autocomplete]
  )

  return {
    draft,
    setDraft,
    setCursorPos,
    attachments,
    setAttachments,
    queuedMessages,
    removeQueue,
    clearQueue,
    autocomplete,
    handleSend,
    handleStop,
    onKeyDown,
    textareaRef
  }
}
