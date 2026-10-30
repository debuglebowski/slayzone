import {
  Virtualizer,
  elementScroll,
  measureElement as measureRow,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
  type VirtualizerOptions
} from '@tanstack/virtual-core'
import type { Key } from 'react'
import type { TimelineItem } from '@slayzone/terminal/client'
import type { RevealTimelineItem } from './timeline-reveal'
import type { CallbackRef, FollowBottomApi } from './useFollowBottom'

/** Space above the first row (what `pt-4` was before the list was virtual). */
export const TIMELINE_PADDING_TOP = 16
/** Rows rendered beyond each edge of the view: room for a fast wheel flick. */
const OVERSCAN = 8
/** How long a reveal keeps re-aiming while rows around it get measured. */
const REVEAL_SETTLE_MS = 5_000

export interface VirtualTimelineView {
  /** The rows to render, in order: `index` into the items, `start` = top in px. */
  items: VirtualItem[]
  /** Height of the whole list, measured rows and estimates for the rest. */
  totalSize: number
}

export interface VirtualTimelineController {
  /**
   * The scroll container's ref callback (`ref={virtual.bindScroller}`): binds the
   * virtualizer and the follow-bottom lock. Not named `…Ref`: the React
   * Compiler treats a `…Ref` property read during render as a ref read.
   */
  bindScroller: CallbackRef<HTMLElement>
  /** Ref for each rendered row (needs `data-index`): measures it while mounted. */
  measureElement: (el: HTMLElement | null) => void
  subscribe: (listener: () => void) => () => void
  /** Changes whenever what `view` returns may have (scroll range, a row's size). */
  getVersion: () => number
  /**
   * Point the list at `items` and read what to render. Called while rendering:
   * the result depends only on its arguments (`version` stands for the scroll
   * state), so memoizing it on them is exact.
   */
  view: (
    items: readonly TimelineItem[],
    itemKey: (item: TimelineItem, index: number) => Key,
    version: number
  ) => VirtualTimelineView
  /** After each commit of the rows: rebinds a replaced scroller, settles anchors. */
  afterRender: () => void
  /** Scroll so row `index` is at the top (or centred) — mounted or not. */
  revealIndex: (index: number, opts?: { align?: 'start' | 'center' }) => void
  /** `revealIndex` by the row's `itemKey` (the timeline reveal seam). */
  revealKey: RevealTimelineItem
  /** A reveal still re-aiming stops here (the user scrolled, or a position was set). */
  cancelReveal: () => void
  /** Index of the row at the top of the view (-1 when there are none). */
  topIndex: () => number
  dispose: () => void
}

/**
 * A first guess at a row's height before it has rendered. Only rows that have
 * never been on screen use it (and only for the scrollbar's size and where a
 * reveal lands first): a mounted row is measured. Close guesses mean less
 * correction while scrolling up into history.
 */
export function estimateRowSize(item: TimelineItem | undefined): number {
  if (!item) return 40
  const lines = (text: string | undefined): number => {
    if (!text) return 1
    let n = 0
    for (const line of text.split('\n')) n += Math.max(1, Math.ceil(line.length / 90))
    return n
  }
  switch (item.kind) {
    case 'user-text':
      return 56 + 20 * Math.min(lines(item.text), 12)
    case 'text':
      return 16 + 22 * Math.min(lines(item.text), 200)
    case 'thinking':
      return 28
    case 'tool':
      return 44
    case 'result':
      return 36
    case 'session-start':
      return 44
    case 'sub-agent':
      return 48
    case 'hook':
    case 'notice':
    case 'turn-error':
    case 'agent-problem':
      return 56
    default:
      return 40
  }
}

/**
 * The chat timeline's virtualizer (`@tanstack/virtual-core`), wrapped for React
 * the way `useFollowBottom` wraps its scroll lock: a plain object created once,
 * read during render through `useSyncExternalStore` (`subscribe`/`getVersion`).
 * Not `useVirtualizer`: the React Compiler can't memoize its return value and
 * skips any component that calls it.
 *
 * Follow-bottom stays `useFollowBottom`'s job (it releases only on user input);
 * this owns which rows exist and where. Two things a browser does to a tab hidden
 * with `display:none` are undone here: its rows would measure 0 tall (the sizes
 * are kept instead) and its scroller can lose its offset (put back on show).
 */
export function createVirtualTimelineController(
  follow: Pick<FollowBottomApi, 'scrollRef' | 'isStuck' | 'unstick'>
): VirtualTimelineController {
  let items: readonly TimelineItem[] = []
  let itemKey: (item: TimelineItem, index: number) => Key = (_item, index) => index
  let version = 0
  const listeners = new Set<() => void>()
  let hidden = false
  let offsetWhenHidden = 0
  /** The rows last rendered while visible: kept as they are while hidden. */
  let lastIndexes: number[] = []
  let keyIndex: Map<Key, number> | null = null
  let revealTimer: ReturnType<typeof setTimeout> | null = null
  let detachInput: (() => void) | null = null

  const bump = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }

  const getScrollElement = (): HTMLElement | null => follow.scrollRef.current

  const restoreAfterShow = (): void => {
    const el = getScrollElement()
    if (!el) return
    const offset = follow.isStuck() ? el.scrollHeight : offsetWhenHidden
    if (Math.abs(el.scrollTop - offset) > 1) el.scrollTop = offset
    virtualizer.scrollOffset = el.scrollTop
  }

  const options = (): VirtualizerOptions<HTMLElement, HTMLElement> => ({
    count: items.length,
    getScrollElement,
    estimateSize: (index) => estimateRowSize(items[index]),
    getItemKey: (index) => itemKey(items[index], index),
    overscan: OVERSCAN,
    paddingStart: TIMELINE_PADDING_TOP,
    scrollToFn: elementScroll,
    observeElementOffset,
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        const nowHidden = rect.height === 0
        if (nowHidden && !hidden) {
          hidden = true
          offsetWhenHidden = instance.scrollOffset ?? 0
        } else if (!nowHidden && hidden) {
          hidden = false
          restoreAfterShow()
        }
        cb(rect)
      }),
    measureElement: (el, entry, instance) => {
      // Not laid out (an ancestor is display:none): it is not 0 tall, it is
      // not shown — keep what it measured last.
      if (el.getClientRects().length === 0) {
        const index = instance.indexFromElement(el)
        return (
          instance.itemSizeCache.get(instance.options.getItemKey(index)) ??
          instance.options.estimateSize(index)
        )
      }
      return measureRow(el, entry, instance)
    },
    onChange: bump
  })

  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(options())

  const cancelReveal = (): void => {
    if (revealTimer === null) return
    clearTimeout(revealTimer)
    revealTimer = null
    // A new target where the view IS now ends the old one's re-aiming. Read
    // the scroller itself: a position set just now (an anchor restore) has not
    // reached the virtualizer yet (its scroll event comes later), and its
    // offset would put the view back where the reveal had it.
    const at = getScrollElement()?.scrollTop ?? virtualizer.scrollOffset ?? 0
    virtualizer.scrollOffset = at
    virtualizer.scrollToOffset(at)
  }

  /** Wheel, touch and keys mean the user is moving the view: a reveal yields. */
  const watchUserInput = (el: HTMLElement): (() => void) => {
    const onInput = (): void => cancelReveal()
    el.addEventListener('wheel', onInput, { passive: true })
    el.addEventListener('touchstart', onInput, { passive: true })
    el.addEventListener('keydown', onInput)
    return () => {
      el.removeEventListener('wheel', onInput)
      el.removeEventListener('touchstart', onInput)
      el.removeEventListener('keydown', onInput)
    }
  }

  /** (Re)bind to the scroller in `scrollRef.current`: idempotent. */
  const bind = (): void => {
    if (detachInput === null && scrollRef.current) detachInput = watchUserInput(scrollRef.current)
    virtualizer._willUpdate()
  }

  const scrollRef = ((el: HTMLElement | null) => {
    if (scrollRef.current === el) return
    detachInput?.()
    detachInput = null
    follow.scrollRef(el)
    scrollRef.current = el
    // Opening while following (the default): start at the bottom. The rows'
    // container already has its height; the content's own growth comes later.
    if (el && follow.isStuck()) el.scrollTop = el.scrollHeight
    // Rendering before this read the offset as 0 (no scroller yet): binding
    // would scroll there. Start from where the scroller is.
    if (el) virtualizer.scrollOffset = el.scrollTop
    // Bind now: refs attach after the rows' layout effects in the same commit.
    bind()
  }) as CallbackRef<HTMLElement>
  scrollRef.current = null

  const view: VirtualTimelineController['view'] = (nextItems, nextItemKey) => {
    if (nextItems !== items || nextItemKey !== itemKey) {
      items = nextItems
      itemKey = nextItemKey
      keyIndex = null
      virtualizer.setOptions(options())
    }
    const totalSize = virtualizer.getTotalSize()
    let rows = virtualizer.getVirtualItems()
    if (rows.length === 0 && hidden) {
      rows = lastIndexes
        .filter((i) => i < items.length)
        .map((i) => virtualizer.measurementsCache[i])
        .filter((row): row is VirtualItem => row !== undefined)
    } else if (rows.length > 0) {
      lastIndexes = rows.map((row) => row.index)
    }
    return { items: rows, totalSize }
  }

  const revealIndex: VirtualTimelineController['revealIndex'] = (index, opts) => {
    if (index < 0 || index >= items.length) return
    follow.unstick()
    if (revealTimer !== null) clearTimeout(revealTimer)
    revealTimer = setTimeout(() => {
      revealTimer = null
    }, REVEAL_SETTLE_MS)
    virtualizer.scrollToIndex(index, { align: opts?.align ?? 'start' })
  }

  const revealKey: RevealTimelineItem = (key, opts) => {
    if (keyIndex === null) {
      keyIndex = new Map()
      for (let i = 0; i < items.length; i++) keyIndex.set(itemKey(items[i], i), i)
    }
    const index = keyIndex.get(key)
    if (index !== undefined) revealIndex(index, opts)
  }

  return {
    bindScroller: scrollRef,
    measureElement: virtualizer.measureElement,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    view,
    afterRender: bind,
    revealIndex,
    revealKey,
    cancelReveal,
    topIndex: () => {
      if (items.length === 0) return -1
      // The scroller's own offset: right after a programmatic scroll the
      // virtualizer's lags until the scroll event (a held key repeats faster).
      const offset = getScrollElement()?.scrollTop ?? virtualizer.scrollOffset ?? 0
      return virtualizer.getVirtualItemForOffset(offset)?.index ?? -1
    },
    dispose: () => {
      if (revealTimer !== null) clearTimeout(revealTimer)
      revealTimer = null
      detachInput?.()
      detachInput = null
      virtualizer._didMount()()
    }
  }
}
