/**
 * Scrolling the board while a card is dragged (no React): the board's scrollers register
 * here (`createScrollRegistry`: each one's node, offset, viewport and content size, kept
 * from its own events), and while a drag lasts `createAutoScroll` runs a frame loop that
 * asks the board which scrollers the finger is near the edge of (`plan`, from
 * `edgeScrollSpeed`) and scrolls them — a long column under the finger, an iPad's row of
 * columns sideways — so every drop place is reachable. A scroll moves the rows under the
 * finger: `onScrolled` lets the board measure its drop targets again.
 */
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { clampScroll, edgeScrollSpeed, type Rect } from './drag'

export type Axis = 'x' | 'y'

/** What a ScrollView (`scrollTo`) or a FlatList (`scrollToOffset`) offers. */
export interface Scrollable {
  scrollTo?: (options: { x?: number; y?: number; animated?: boolean }) => void
  scrollToOffset?: (params: { offset: number; animated?: boolean }) => void
}

interface ScrollerState {
  axis: Axis
  node: Scrollable | null
  offset: number
  content: number
  viewport: number
  /** Room after the content (an iOS `contentInset` at its end). */
  endInset: number
}

/** The props that wire a scroller in (stable per key: refs don't re-attach each render). */
export interface ScrollerProps {
  ref: (node: Scrollable | null) => void
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
  onLayout: (e: LayoutChangeEvent) => void
  onContentSizeChange: (width: number, height: number) => void
  scrollEventThrottle: number
}

export interface ScrollRegistry {
  props: (key: string, axis: Axis, endInset?: number) => ScrollerProps
  /** Scrolls `key` by `delta` within its content; false = it could not move. */
  scrollBy: (key: string, delta: number) => boolean
}

export function createScrollRegistry(): ScrollRegistry {
  const scrollers = new Map<string, ScrollerState>()
  const wired = new Map<string, ScrollerProps>()
  const stateOf = (key: string, axis: Axis, endInset: number): ScrollerState => {
    let state = scrollers.get(key)
    if (!state) {
      state = { axis, node: null, offset: 0, content: 0, viewport: 0, endInset }
      scrollers.set(key, state)
    }
    return state
  }
  return {
    props(key, axis, endInset = 0) {
      const known = wired.get(key)
      if (known) return known
      const state = stateOf(key, axis, endInset)
      const props: ScrollerProps = {
        ref: (node) => {
          state.node = node
        },
        onScroll: (e) => {
          const { x, y } = e.nativeEvent.contentOffset
          state.offset = axis === 'x' ? x : y
        },
        onLayout: (e) => {
          const { width, height } = e.nativeEvent.layout
          state.viewport = axis === 'x' ? width : height
        },
        onContentSizeChange: (width, height) => {
          state.content = axis === 'x' ? width : height
        },
        scrollEventThrottle: 16
      }
      wired.set(key, props)
      return props
    },
    scrollBy(key, delta) {
      const state = scrollers.get(key)
      if (!state?.node || delta === 0) return false
      const next = clampScroll(state.offset, delta, {
        content: state.content + state.endInset,
        viewport: state.viewport
      })
      if (Math.abs(next - state.offset) < 0.5) return false
      state.offset = next
      if (state.node.scrollToOffset) state.node.scrollToOffset({ offset: next, animated: false })
      else
        state.node.scrollTo?.(
          state.axis === 'x' ? { x: next, animated: false } : { y: next, animated: false }
        )
      return true
    }
  }
}

/** One scroller to move this frame, and how fast (points per frame, signed). */
export interface ScrollStep {
  key: string
  speed: number
}

/**
 * The board as a drag sees it: how it lays out columns (`pages`: a phone's one column at a
 * time; `list`: one list of sections; `columns`: an iPad's columns side by side), where
 * its drop targets and itself are (window coordinates), and the phone's shown column.
 */
export interface DragLayout {
  mode: 'pages' | 'list' | 'columns'
  columns: readonly { id: string; rect: Rect; atEnd?: boolean }[]
  root: Rect | null
  shownId: string | undefined
}

export type ScrollPlan = (layout: DragLayout, point: { x: number; y: number }) => ScrollStep[]

/**
 * The board's scrollers a finger near an edge moves (keys as the board registers them):
 * a phone's shown column (`page:<id>`) up/down; the list (`list`) up/down; an iPad's row
 * of columns (`columns`) sideways and the column under the finger (`col:<id>`) up/down.
 */
export const boardScrollPlan: ScrollPlan = (layout, point) => {
  const area = (id: string | undefined) => layout.columns.find((c) => !c.atEnd && c.id === id)?.rect
  switch (layout.mode) {
    case 'pages': {
      const page = area(layout.shownId)
      return page && layout.shownId
        ? [{ key: `page:${layout.shownId}`, speed: edgeScrollSpeed(point.y, page.y, page.height) }]
        : []
    }
    case 'list': {
      const root = layout.root
      return root ? [{ key: 'list', speed: edgeScrollSpeed(point.y, root.y, root.height) }] : []
    }
    case 'columns': {
      const steps: ScrollStep[] = []
      const root = layout.root
      if (root) steps.push({ key: 'columns', speed: edgeScrollSpeed(point.x, root.x, root.width) })
      const column = layout.columns.find(
        (c) => !c.atEnd && point.x >= c.rect.x && point.x < c.rect.x + c.rect.width
      )
      if (column) {
        steps.push({
          key: `col:${column.id}`,
          speed: edgeScrollSpeed(point.y, column.rect.y, column.rect.height)
        })
      }
      return steps
    }
  }
}

export interface AutoScroll {
  /** `onScrolled`: something scrolled this frame (the rows under the finger moved). */
  start: (point: { x: number; y: number }, layout: DragLayout, onScrolled: () => void) => void
  move: (point: { x: number; y: number }) => void
  /** Newly measured targets, or a page turned. */
  update: (layout: Partial<DragLayout>) => void
  layout: () => DragLayout
  /** Something scrolled (or a page turned) since the targets last measured were taken. */
  stale: () => boolean
  markStale: () => void
  /** Before measuring: what `measured` is handed once the measurement is in. */
  snapshot: () => number
  measured: (snapshot: number) => void
  stop: () => void
}

export interface FrameClock {
  request: (run: () => void) => number
  cancel: (handle: number) => void
}

const animationFrames: FrameClock = {
  request: (run) => requestAnimationFrame(run),
  cancel: (handle) => cancelAnimationFrame(handle)
}

/**
 * A frame loop for one drag at a time: each frame, `plan` says which scrollers to move
 * for the finger where it is; any that moved → the drag's `onScrolled` (once per frame).
 */
export function createAutoScroll(
  scrollers: Pick<ScrollRegistry, 'scrollBy'>,
  plan: ScrollPlan = boardScrollPlan,
  clock: FrameClock = animationFrames
): AutoScroll {
  let active = false
  let point = { x: 0, y: 0 }
  let layout: DragLayout = { mode: 'pages', columns: [], root: null, shownId: undefined }
  let onScrolled: () => void = () => {
    // No drag yet.
  }
  let frame: number | null = null
  // Every scroll (or page turn) bumps `moves`; targets taken at `measuredAt` are current
  // while nothing moved since (a scroll during a measurement leaves them stale).
  let moves = 0
  let measuredAt = 0
  const tick = () => {
    frame = null
    if (!active) return
    let moved = false
    for (const step of plan(layout, point)) {
      if (step.speed !== 0 && scrollers.scrollBy(step.key, step.speed)) moved = true
    }
    if (moved) {
      moves++
      onScrolled()
    }
    if (active) frame = clock.request(tick)
  }
  const stop = () => {
    active = false
    if (frame !== null) clock.cancel(frame)
    frame = null
  }
  return {
    start(at, initial, scrolled) {
      stop()
      active = true
      point = at
      layout = initial
      onScrolled = scrolled
      moves = 0
      measuredAt = 0
      frame = clock.request(tick)
    },
    move(at) {
      point = at
    },
    update(next) {
      layout = { ...layout, ...next }
    },
    layout: () => layout,
    stale: () => moves !== measuredAt,
    markStale() {
      moves++
    },
    snapshot: () => moves,
    measured(snapshot) {
      measuredAt = Math.max(measuredAt, snapshot)
    },
    stop
  }
}
