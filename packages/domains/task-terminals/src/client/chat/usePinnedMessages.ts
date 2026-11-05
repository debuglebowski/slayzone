import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { toast, useStableCallback } from '@slayzone/ui'
import type { TimelineItem, TimelinePageSummary } from '@slayzone/terminal/client'
import type { ChatPinnedMessage } from '@slayzone/terminal-contracts'
import { useTRPC, useTRPCClient } from '../trpc'
import { pinnableRow, pinnedMessageToJumpTo, pinPlace } from './pinned-messages'
import { flashRow, type RevealTimelineItem } from './timeline-reveal'
import type { VirtualTimelineController } from './virtual-timeline'

const NO_PINS: ChatPinnedMessage[] = []

/** What the rows read (`ChatViewState.pinnedMessages`). */
export interface PinnedMessagesView {
  isPinned: (key: string) => boolean
  /** Pin the row, or unpin it when it is pinned. A row that can't be pinned is ignored. */
  toggle: (item: TimelineItem) => void
}

/** The timeline the pins point into (`useChatDisplay`). */
export interface PinnedMessagesTimeline {
  displayedTimeline: readonly TimelineItem[]
  rowOf: (item: TimelineItem) => number | undefined
  revealItem: RevealTimelineItem
  virtual: Pick<VirtualTimelineController, 'topIndex'>
  summary: Pick<TimelinePageSummary, 'branches'>
  conversationFolded: ReadonlySet<number>
  branches: { isOpen: (id: string) => boolean; toggle: (id: string) => void }
}

/**
 * The pinned messages of the conversation on screen: listed from the computer
 * (live — another window's pin shows here), pinned / unpinned at once in the
 * view (the server's list replaces it), and "go to" one — through its page
 * when not loaded, opening the fold a rewind put it in.
 */
export function usePinnedMessages({
  target,
  conversationId,
  timeline
}: {
  target: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }
  /** The provider conversation on screen (null: none yet — nothing to pin). */
  conversationId: string | null
  timeline: PinnedMessagesTimeline
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const enabled = !!conversationId
  const listInput = { ...target, conversationId }
  const listOptions = trpc.chat.pinnedMessages.list.queryOptions(listInput, { enabled })
  const listKey = listOptions.queryKey
  const query = useQuery(listOptions)
  const pins = (enabled ? query.data : undefined) ?? NO_PINS
  useSubscription(
    trpc.chat.pinnedMessages.onChanged.subscriptionOptions(
      { tabId: target.tabId },
      {
        enabled,
        onData: () => {
          void query.refetch()
        }
      }
    )
  )
  const keys = useMemo(() => new Set(pins.map((p) => p.key)), [pins])

  const setPins = (update: (pins: ChatPinnedMessage[]) => ChatPinnedMessage[]): void => {
    queryClient.setQueryData(listKey, (old: ChatPinnedMessage[] | undefined) => update(old ?? []))
  }
  const failed = (verb: string) => (err: unknown) => {
    toast(`Couldn't ${verb} the message: ${err instanceof Error ? err.message : String(err)}`)
    void query.refetch()
  }
  const toggle = useStableCallback((item: TimelineItem): void => {
    const row = pinnableRow(item)
    if (!row || !conversationId) return
    if (keys.has(row.key)) {
      setPins((list) => list.filter((p) => p.key !== row.key))
      client.chat.pinnedMessages.unpin
        .mutate({ ...target, conversationId, key: row.key })
        .catch(failed('unpin'))
      return
    }
    const at = timeline.rowOf(item)
    const input = { ...row, conversationId, ...(at !== undefined ? { row: at } : {}) }
    setPins((list) => [
      ...list.filter((p) => p.key !== row.key),
      { ...input, pinnedAt: Date.now() }
    ])
    client.chat.pinnedMessages.pin.mutate({ ...target, pin: input }).catch(failed('pin'))
  })
  const unpin = useStableCallback((pin: ChatPinnedMessage): void => {
    setPins((list) => list.filter((p) => p.key !== pin.key))
    client.chat.pinnedMessages.unpin
      .mutate({ ...target, conversationId: pin.conversationId, key: pin.key })
      .catch(failed('unpin'))
  })

  // Going to a pin in a fold that is closed: the fold opens, the row is
  // revealed once it is displayed.
  const pendingRef = useRef<ChatPinnedMessage | null>(null)
  const reveal = (pin: ChatPinnedMessage): void => {
    timeline.revealItem(pin.key, {
      align: 'center',
      ...(pin.row !== undefined ? { row: pin.row } : {})
    })
    flashRow(pin.key)
  }
  const inBranchOf = (pin: ChatPinnedMessage): string | null =>
    pinPlace(pin, timeline.conversationFolded, timeline.summary.branches).inBranch
  const go = useStableCallback((pin: ChatPinnedMessage): void => {
    const branch = inBranchOf(pin)
    if (branch && !timeline.branches.isOpen(branch)) {
      pendingRef.current = pin
      timeline.branches.toggle(branch)
      return
    }
    reveal(pin)
  })
  const { displayedTimeline } = timeline
  useEffect(() => {
    const pin = pendingRef.current
    if (!pin) return
    pendingRef.current = null
    reveal(pin)
  })
  const jump = useStableCallback((dir: -1 | 1): void => {
    const top = displayedTimeline[Math.max(0, timeline.virtual.topIndex())]
    const topRow = top ? (timeline.rowOf(top) ?? (top.kind === 'history-gap' ? top.from : 0)) : 0
    const pin = pinnedMessageToJumpTo(pins, topRow, dir)
    if (pin) go(pin)
  })

  const view = useMemo<PinnedMessagesView | undefined>(
    () => (enabled ? { isPinned: (key) => keys.has(key), toggle } : undefined),
    [enabled, keys, toggle]
  )
  return { pins, view, go, jump, unpin, inBranchOf }
}
