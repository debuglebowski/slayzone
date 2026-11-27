import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatScrollAnchor, ChatTabState } from '@slayzone/terminal-contracts'
import { useTRPC, useTRPCClient } from '../../trpc'
import type { CallbackRef } from '../useFollowBottom'

const SAVE_DELAY_MS = 500
/**
 * Frames to wait for the anchor's row to render after revealing it (a paged
 * history may load its page first: ~2 s).
 */
const MAX_RESTORE_FRAMES = 120

/**
 * Frames to keep putting a restored anchor back once its row rendered (~0.5 s).
 * The rows around it are measured over the next frames — the anchor's own row
 * among them — and the virtualizer's compensation for a row the view's top is
 * inside of keeps that row's bottom in place, not its top: the restored offset
 * would be off by however much the row's estimate was.
 */
const HOLD_FRAMES = 30

/** What the user does to move the view: the restore yields to it at once. */
const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

/**
 * Try to restore `anchor` each frame until its row is rendered (the window was
 * just widened to include it) or the frame budget runs out, then hold it there
 * while the rows around it settle. Any user input on `el` ends both. Returns a
 * cancel.
 */
function restoreWhenRendered(
  anchor: ChatScrollAnchor,
  restoreAnchor: (anchor: ChatScrollAnchor) => boolean,
  el: HTMLElement | null
): () => void {
  let frames = 0
  let held = 0
  let frame: number | null = null
  const stop = (): void => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    for (const type of USER_INPUT) el?.removeEventListener(type, stop)
  }
  const attempt = (): void => {
    frame = null
    if (held > 0) {
      restoreAnchor(anchor)
      held += 1
      if (held > HOLD_FRAMES) return stop()
    } else {
      frames += 1
      if (restoreAnchor(anchor)) held = 1
      else if (frames >= MAX_RESTORE_FRAMES) return stop()
    }
    frame = requestAnimationFrame(attempt)
  }
  for (const type of USER_INPUT) el?.addEventListener(type, stop, { passive: true })
  frame = requestAnimationFrame(attempt)
  return stop
}

/** Call `onPause` once scrolling of `el` pauses; the returned stop also runs a pending one. */
function watchScrollPauses(el: HTMLElement, onPause: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const onScroll = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onPause()
    }, SAVE_DELAY_MS)
  }
  el.addEventListener('scroll', onScroll, { passive: true })
  return () => {
    el.removeEventListener('scroll', onScroll)
    if (timer) {
      clearTimeout(timer)
      onPause()
    }
  }
}

/**
 * Keeps where a chat tab's timeline was scrolled across remounts and reloads
 * (plan item 4.2), saved per tab next to the draft (`chat.tabState`). The
 * position is an anchor on a row with a stable key, not a pixel offset: rows
 * above it may load or page differently after a reload.
 */
export function useChatScrollMemory({
  tabId,
  mode,
  enabled,
  ready,
  scrollRef,
  captureAnchor,
  restoreAnchor,
  revealKey
}: {
  tabId: string
  mode?: string
  /** The mode's `restoreComposerState` capability. */
  enabled: boolean
  /** The timeline has its history (hydration done). */
  ready: boolean
  scrollRef: CallbackRef<HTMLElement>
  captureAnchor: () => ChatScrollAnchor | null
  restoreAnchor: (anchor: ChatScrollAnchor) => boolean
  /** Make the anchor's row part of the rendered window. */
  /** Bring the anchor's row into the list (`row`: its timeline index, to load its page). */
  revealKey: (key: string, row?: number) => void
}): void {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const queryOptions = trpc.chat.tabState.get.queryOptions(
    { tabId, ...(mode ? { expectedMode: mode } : {}) },
    { enabled }
  )
  const { data, isSuccess, isFetchedAfterMount } = useQuery({
    ...queryOptions,
    staleTime: 0,
    refetchOnMount: 'always'
  })
  const ownershipRef = useRef<ChatTabState['ownership']>(undefined)

  // Written in effects only (React Compiler).
  const restoredRef = useRef(false)
  const lastSavedRef = useRef<string | null>(null)
  const cancelRestoreRef = useRef<(() => void) | null>(null)

  // Restore once, when both the timeline and the saved anchor are there.
  useEffect(() => {
    if (!enabled || !ready || !isSuccess || (mode && !isFetchedAfterMount) || restoredRef.current)
      return
    ownershipRef.current = data?.ownership
    restoredRef.current = true
    const anchor = (data as ChatTabState | null | undefined)?.scroll ?? null
    lastSavedRef.current = anchor ? JSON.stringify(anchor) : null
    // At the bottom is where a timeline opens anyway.
    if (!anchor || anchor.atBottom) return
    revealKey(anchor.key, anchor.row)
    cancelRestoreRef.current = restoreWhenRendered(anchor, restoreAnchor, scrollRef.current)
  }, [
    enabled,
    ready,
    isSuccess,
    isFetchedAfterMount,
    mode,
    data,
    restoreAnchor,
    revealKey,
    scrollRef
  ])

  useEffect(() => () => cancelRestoreRef.current?.(), [])

  // Save where the user scrolled, once scrolling pauses (and on leaving). The
  // listener lives for the mount; what a pause does is refreshed every render.
  const onPauseRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    onPauseRef.current = () => {
      if (!restoredRef.current) return
      const anchor = captureAnchor()
      if (!anchor) return
      const key = JSON.stringify(anchor)
      if (key === lastSavedRef.current) return
      lastSavedRef.current = key
      trpcClient.chat.tabState.saveScroll
        .mutate({
          tabId,
          anchor,
          ...(mode ? { expectedMode: mode } : {}),
          ...(ownershipRef.current ? { expectedOwnership: ownershipRef.current } : {})
        })
        .catch((err: unknown) => {
          lastSavedRef.current = null
          console.error('[chat] saving the scroll position failed:', err)
        })
      queryClient.setQueryData(queryOptions.queryKey, (old: ChatTabState | null | undefined) =>
        old ? { ...old, scroll: anchor } : old
      )
    }
  })
  useEffect(() => {
    const el = scrollRef.current
    if (!enabled || !el) return
    return watchScrollPauses(el, () => onPauseRef.current())
  }, [enabled, scrollRef])
}
