import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatScrollAnchor, ChatTabState } from '@slayzone/terminal-contracts'
import { useTRPC, useTRPCClient } from '../../trpc'
import type { CallbackRef } from '../useFollowBottom'

const SAVE_DELAY_MS = 500
/** Frames to wait for the anchor's row to render after widening the window. */
const MAX_RESTORE_FRAMES = 20

/**
 * Try to restore `anchor` each frame until its row is rendered (the window was
 * just widened to include it) or the frame budget runs out. Returns a cancel.
 */
function restoreWhenRendered(
  anchor: ChatScrollAnchor,
  restoreAnchor: (anchor: ChatScrollAnchor) => boolean
): () => void {
  let frames = 0
  let frame: number | null = null
  const attempt = (): void => {
    frame = null
    frames += 1
    if (restoreAnchor(anchor) || frames >= MAX_RESTORE_FRAMES) return
    frame = requestAnimationFrame(attempt)
  }
  frame = requestAnimationFrame(attempt)
  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
  }
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
  enabled,
  ready,
  scrollRef,
  captureAnchor,
  restoreAnchor,
  revealKey
}: {
  tabId: string
  /** The mode's `restoreComposerState` capability. */
  enabled: boolean
  /** The timeline has its history (hydration done). */
  ready: boolean
  scrollRef: CallbackRef<HTMLElement>
  captureAnchor: () => ChatScrollAnchor | null
  restoreAnchor: (anchor: ChatScrollAnchor) => boolean
  /** Make the anchor's row part of the rendered window. */
  revealKey: (key: string) => void
}): void {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const queryOptions = trpc.chat.tabState.get.queryOptions({ tabId }, { enabled })
  const { data, isSuccess } = useQuery(queryOptions)

  // Written in effects only (React Compiler).
  const restoredRef = useRef(false)
  const lastSavedRef = useRef<string | null>(null)
  const cancelRestoreRef = useRef<(() => void) | null>(null)

  // Restore once, when both the timeline and the saved anchor are there.
  useEffect(() => {
    if (!enabled || !ready || !isSuccess || restoredRef.current) return
    restoredRef.current = true
    const anchor = (data as ChatTabState | null | undefined)?.scroll ?? null
    lastSavedRef.current = anchor ? JSON.stringify(anchor) : null
    // At the bottom is where a timeline opens anyway.
    if (!anchor || anchor.atBottom) return
    revealKey(anchor.key)
    cancelRestoreRef.current = restoreWhenRendered(anchor, restoreAnchor)
  }, [enabled, ready, isSuccess, data, restoreAnchor, revealKey])

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
      trpcClient.chat.tabState.saveScroll.mutate({ tabId, anchor }).catch((err: unknown) => {
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
