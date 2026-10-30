/**
 * A tiny layout engine for the virtualized chat timeline under jsdom, which has
 * none: every box measures 0 there, so the virtualizer would render no rows.
 *
 * Models just what the timeline reads: the scroller
 * (`data-testid="chat-timeline-scroller"`) has a fixed viewport height, a
 * `scrollTop` clamped to its content and scroll events; a virtual row
 * (`[data-index]` with `translateY(...)`) has the height `rowHeight` gives it;
 * the list (`[data-virtual-list]`) is as tall as its inline height. A scroller
 * whose ancestor is `display:none` (a hidden tab) measures 0, as in a browser.
 */
const SCROLLER = '[data-testid="chat-timeline-scroller"]'

export interface TimelineLayout {
  /** Set the viewport height. */
  setViewport(height: number): void
  /** Deliver a ResizeObserver round: every observed box with its current size. */
  flushResize(): void
  scroller(): HTMLElement | null
  /** Scroll like a user would (fires a scroll event). */
  scrollTo(top: number): void
  restore(): void
}

function hiddenByAncestor(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if ((n as HTMLElement).style?.display === 'none') return true
  }
  return false
}

export function installTimelineLayout(opts: {
  viewport?: number
  rowHeight?: (row: HTMLElement) => number
}): TimelineLayout {
  let viewport = opts.viewport ?? 600
  const rowHeight = opts.rowHeight ?? (() => 50)
  const scrollTops = new WeakMap<HTMLElement, number>()

  const isScroller = (el: Element): boolean => el.matches(SCROLLER)
  const isRow = (el: Element): boolean =>
    el.hasAttribute('data-index') && !!el.closest('[data-virtual-list]')
  const viewportOf = (el: HTMLElement) => (hiddenByAncestor(el) ? 0 : viewport)
  const contentHeight = (scroller: HTMLElement): number => {
    const list = scroller.querySelector<HTMLElement>('[data-virtual-list]')
    const listHeight = list ? parseFloat(list.style.height) || 0 : 0
    // Whatever follows the list (typing indicator) is ignored: 0 tall here.
    return Math.max(viewportOf(scroller), listHeight)
  }
  const rowTop = (row: HTMLElement): number => {
    const m = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform)
    return m ? parseFloat(m[1]) : 0
  }
  const rect = (top: number, height: number): DOMRect =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 800,
      width: 800,
      height,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  // jsdom has no ResizeObserver: observers are recorded and `flushResize` runs them.
  const observers = new Set<{
    cb: ResizeObserverCallback
    targets: Set<Element>
    self: ResizeObserver
  }>()
  class FakeResizeObserver {
    private entry: { cb: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver }
    constructor(cb: ResizeObserverCallback) {
      this.entry = { cb, targets: new Set(), self: this as unknown as ResizeObserver }
      observers.add(this.entry)
    }
    observe(target: Element) {
      this.entry.targets.add(target)
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target)
    }
    disconnect() {
      this.entry.targets.clear()
      observers.delete(this.entry)
    }
  }
  const savedResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver

  const proto = HTMLElement.prototype
  const saved = {
    getBoundingClientRect: proto.getBoundingClientRect,
    getClientRects: proto.getClientRects,
    offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
    scrollTo: (proto as { scrollTo?: unknown }).scrollTo
  }

  const setScrollTop = (el: HTMLElement, top: number): void => {
    const max = Math.max(0, contentHeight(el) - viewportOf(el))
    const next = Math.max(0, Math.min(max, Math.round(top)))
    if (next === (scrollTops.get(el) ?? 0)) return
    scrollTops.set(el, next)
    queueMicrotask(() => el.dispatchEvent(new Event('scroll')))
  }

  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (isScroller(this)) return rect(0, viewportOf(this))
    if (isRow(this)) {
      const scroller = this.closest<HTMLElement>(SCROLLER)
      if (!scroller || hiddenByAncestor(this)) return rect(0, 0)
      return rect(rowTop(this) - (scrollTops.get(scroller) ?? 0), rowHeight(this))
    }
    // The scroller's content (the box the follow-bottom lock watches grow).
    const scroller = this.parentElement?.closest<HTMLElement>(SCROLLER)
    if (scroller && this.parentElement === scroller) {
      if (hiddenByAncestor(this)) return rect(0, 0)
      return rect(-(scrollTops.get(scroller) ?? 0), contentHeight(scroller))
    }
    return saved.getBoundingClientRect.call(this)
  }
  proto.getClientRects = function (this: HTMLElement) {
    if ((isRow(this) || isScroller(this)) && !hiddenByAncestor(this)) {
      return [this.getBoundingClientRect()] as unknown as DOMRectList
    }
    return saved.getClientRects.call(this)
  }
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (hiddenByAncestor(this)) return 0
      if (isRow(this)) return rowHeight(this)
      if (isScroller(this)) return viewport
      return 0
    }
  })
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? viewportOf(this as HTMLElement) : 0
    }
  })
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? contentHeight(this as HTMLElement) : 0
    }
  })
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? (scrollTops.get(this as HTMLElement) ?? 0) : 0
    },
    set(this: Element, v: number) {
      if (isScroller(this)) setScrollTop(this as HTMLElement, v)
    }
  })
  ;(proto as { scrollTo: unknown }).scrollTo = function (
    this: HTMLElement,
    arg: ScrollToOptions | number,
    y?: number
  ) {
    const top = typeof arg === 'number' ? (y ?? 0) : (arg.top ?? scrollTops.get(this) ?? 0)
    if (isScroller(this)) setScrollTop(this, top)
  }

  return {
    setViewport(height) {
      viewport = height
    },
    flushResize() {
      for (const o of [...observers]) {
        const entries = [...o.targets].map((target) => {
          const box = (target as HTMLElement).getBoundingClientRect()
          const height = box.height
          return {
            target,
            contentRect: box,
            borderBoxSize: [{ blockSize: height, inlineSize: box.width }],
            contentBoxSize: [{ blockSize: height, inlineSize: box.width }],
            devicePixelContentBoxSize: []
          } as unknown as ResizeObserverEntry
        })
        if (entries.length > 0) o.cb(entries, o.self)
      }
    },
    scroller: () => document.querySelector<HTMLElement>(SCROLLER),
    scrollTo(top) {
      const el = document.querySelector<HTMLElement>(SCROLLER)
      if (el) setScrollTop(el, top)
    },
    restore() {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = savedResizeObserver
      observers.clear()
      proto.getBoundingClientRect = saved.getBoundingClientRect
      proto.getClientRects = saved.getClientRects
      const put = (target: object, key: string, d: PropertyDescriptor | undefined) => {
        if (d) Object.defineProperty(target, key, d)
        else delete (target as Record<string, unknown>)[key]
      }
      put(proto, 'offsetHeight', saved.offsetHeight)
      put(Element.prototype, 'clientHeight', saved.clientHeight)
      put(Element.prototype, 'scrollHeight', saved.scrollHeight)
      put(Element.prototype, 'scrollTop', saved.scrollTop)
      ;(proto as { scrollTo: unknown }).scrollTo = saved.scrollTo
    }
  }
}
