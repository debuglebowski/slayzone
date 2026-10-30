import { useMemo, useRef, useState } from 'react'
import { toast, useStableCallback } from '@slayzone/ui'
import { selectActiveUserIds, type TimelineItem } from '@slayzone/terminal/client'
import {
  chatCapabilitiesForMode,
  type RewindFilesPreview,
  type RewindResult,
  type RewindScope
} from '@slayzone/terminal-contracts'

/** What a past user message offers (chat A, plan 3.3). */
export type ConversationActionKind = 'edit' | 'rewind' | 'fork'

/** What the confirm dialog restores: both, or one of them. */
export type RewindChoice = 'both' | 'conversation' | 'code'

export interface PendingConversationAction {
  kind: ConversationActionKind
  messageId: string
  text: string
}

export type FilesPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: RewindFilesPreview }
  | { status: 'error'; error: string }

/** What the message bubbles read (through `ChatViewContext.conversation`). */
export interface ConversationActionsView {
  canRewind: boolean
  canFork: boolean
  /** Messages the conversation still holds (folded / failed ones offer nothing). */
  activeIds: ReadonlySet<string>
  /** The newest of them: "rewind to here" has nothing after it to drop. */
  lastActiveId: string | null
  /** An action is running (buttons wait). */
  busy: boolean
  begin(kind: ConversationActionKind, message: { id: string; text: string }): void
}

export interface ConversationActionsDialog {
  pending: PendingConversationAction | null
  preview: FilesPreviewState
  busy: boolean
  confirm(choice: RewindChoice): void
  cancel(): void
}

const SCOPE: Record<'edit' | 'rewind', RewindScope> = { edit: 'before', rewind: 'after' }
const LABEL: Record<ConversationActionKind, string> = {
  edit: 'Edit & resend',
  rewind: 'Rewind',
  fork: 'Fork'
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Edit & resend, rewind to here and fork from here on past messages: the
 * message bubbles' actions, and the confirm dialog's state (a dry run of the
 * files first, then the action). Edit & resend puts the message's text back
 * into the composer once the conversation forgot it — the TUI's double-Esc.
 */
export function useConversationActions(opts: {
  mode: string
  timeline: readonly TimelineItem[]
  rewindPreview: (messageId: string, scope: RewindScope) => Promise<RewindFilesPreview>
  rewind: (args: {
    messageId: string
    scope: RewindScope
    conversation: boolean
    files: boolean
  }) => Promise<RewindResult>
  fork?: (messageId: string) => Promise<void>
  /** Put text into the composer to edit (and focus it). */
  prefill: (text: string) => void
}): { view: ConversationActionsView; dialog: ConversationActionsDialog } {
  const caps = chatCapabilitiesForMode(opts.mode)
  const active = useMemo(() => selectActiveUserIds(opts.timeline), [opts.timeline])
  const activeIds = useMemo(() => new Set(active), [active])
  const lastActiveId = active.at(-1) ?? null
  const [pending, setPending] = useState<PendingConversationAction | null>(null)
  const [preview, setPreview] = useState<FilesPreviewState>({ status: 'idle' })
  const [busy, setBusy] = useState(false)
  // A dry run that answers after its dialog closed (or another opened) is dropped.
  const previewSeq = useRef(0)

  const begin = useStableCallback(
    (kind: ConversationActionKind, message: { id: string; text: string }): void => {
      if (busy) return
      setPending({ kind, messageId: message.id, text: message.text })
      const seq = ++previewSeq.current
      if (kind === 'fork') {
        setPreview({ status: 'idle' })
        return
      }
      setPreview({ status: 'loading' })
      opts.rewindPreview(message.id, SCOPE[kind]).then(
        (value) => {
          if (previewSeq.current === seq) setPreview({ status: 'ready', value })
        },
        (err: unknown) => {
          if (previewSeq.current === seq) setPreview({ status: 'error', error: messageOf(err) })
        }
      )
    }
  )

  const cancel = useStableCallback((): void => {
    if (busy) return
    previewSeq.current++
    setPending(null)
  })

  const confirm = useStableCallback((choice: RewindChoice): void => {
    if (!pending || busy) return
    const action = pending
    setBusy(true)
    const run: Promise<RewindResult | null> =
      action.kind === 'fork'
        ? (
            opts.fork?.(action.messageId) ?? Promise.reject(new Error('Fork is not available'))
          ).then(() => null)
        : opts.rewind({
            messageId: action.messageId,
            scope: SCOPE[action.kind],
            conversation: choice !== 'code',
            files: choice !== 'conversation'
          })
    run
      .then(
        (result) => {
          if (result?.files && !result.files.restored) {
            toast(`Code not restored: ${result.files.error ?? 'no checkpoint'}`)
          }
          if (action.kind === 'edit' && choice !== 'code') {
            opts.prefill(result?.prefillText ?? action.text)
          }
          previewSeq.current++
          setPending(null)
        },
        (err: unknown) => {
          toast(`${LABEL[action.kind]} failed: ${messageOf(err)}`)
        }
      )
      .then(() => setBusy(false))
  })

  return {
    view: {
      canRewind: caps.rewind,
      canFork: caps.fork && opts.fork !== undefined,
      activeIds,
      lastActiveId,
      busy,
      begin
    },
    dialog: { pending, preview, busy, confirm, cancel }
  }
}
