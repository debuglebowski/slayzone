// @vitest-environment jsdom
// Pins useFollowBottom's stick-to-bottom contract: scroll events only ever re-stick,
// explicit user input (wheel up / touch / ArrowUp·PageUp·Home) is the only release,
// and content growth follows the bottom while stuck — unless the user is selecting
// text inside the content.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { useFollowBottom } from './useFollowBottom'

type ResizeCallback = (entries: Array<{ contentRect: { height: number } }>) => void
interface FakeObserver {
  cb: ResizeCallback
  observed: Element[]
  disconnect: ReturnType<typeof vi.fn<() => void>>
}
const observers: FakeObserver[] = []

beforeEach(() => {
  observers.length = 0
  // jsdom has no ResizeObserver: record each one so the test drives its callback.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly rec: FakeObserver
      constructor(cb: ResizeCallback) {
        this.rec = { cb, observed: [], disconnect: vi.fn() }
        observers.push(this.rec)
      }
      observe(el: Element): void {
        this.rec.observed.push(el)
      }
      disconnect(): void {
        this.rec.disconnect()
      }
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

interface Dims {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

/** A scroll container with hand-set layout (jsdom has none). `scrollTop` clamps like a browser. */
function scrollBox(init: Partial<Dims> = {}) {
  const dims: Dims = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600, ...init }
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => dims.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => dims.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => dims.scrollTop,
    set: (v: number) => {
      dims.scrollTop = Math.max(0, Math.min(v, dims.scrollHeight - dims.clientHeight))
    }
  })
  document.body.appendChild(el)
  return { el, dims }
}

function contentBox(parent: HTMLElement, height = 1000) {
  const el = document.createElement('div')
  el.textContent = 'streamed assistant text'
  el.getBoundingClientRect = () => ({ height }) as DOMRect
  parent.appendChild(el)
  return el
}

/** Scroll container + content, both attached; the box starts at the bottom. */
function setup(init: Partial<Dims> = {}) {
  const hook = renderHook(() => useFollowBottom())
  const { el, dims } = scrollBox(init)
  const content = contentBox(el)
  act(() => {
    hook.result.current.scrollRef(el)
    hook.result.current.contentRef(content)
  })
  return { ...hook, el, dims, content }
}

/** Content grew to `height`; the box's scrollHeight grows with it. */
function grow(dims: Dims, height: number, observer = observers.at(-1)) {
  dims.scrollHeight = height
  act(() => observer?.cb([{ contentRect: { height } }]))
}

function scrollTo(el: HTMLElement, dims: Dims, top: number) {
  dims.scrollTop = top
  fireEvent.scroll(el)
}

const bottom = (dims: Dims) => dims.scrollHeight - dims.clientHeight

describe('useFollowBottom isAtBottom', () => {
  it('starts at the bottom', () => {
    const { result } = renderHook(() => useFollowBottom())
    expect(result.current.isAtBottom).toBe(true)
  })

  it('counts a scroll position within 70px of the bottom as at bottom', () => {
    const { result, el, dims } = setup()
    // 1000 - 530 - 400 = 70px from the bottom.
    scrollTo(el, dims, 530)
    expect(result.current.isAtBottom).toBe(true)
  })

  it('reads 71px from the bottom as not at bottom', () => {
    const { result, el, dims } = setup()
    scrollTo(el, dims, 529)
    expect(result.current.isAtBottom).toBe(false)
  })

  it('goes back to at bottom when the user scrolls down again', () => {
    const { result, el, dims } = setup()
    scrollTo(el, dims, 0)
    scrollTo(el, dims, bottom(dims))
    expect(result.current.isAtBottom).toBe(true)
  })
})

describe('useFollowBottom stick', () => {
  it('follows content growth while stuck', () => {
    const { dims } = setup()
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('does not release on a scroll event alone (a stale streaming scroll)', () => {
    const { el, dims } = setup()
    scrollTo(el, dims, 0)
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('ignores a resize that did not grow the content', () => {
    const { dims } = setup()
    dims.scrollTop = 0
    grow(dims, 900)
    expect(dims.scrollTop).toBe(0)
  })

  it('releases on a wheel up and stops following growth', () => {
    const { result, el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.wheel(el, { deltaY: -40 })
    expect(result.current.isAtBottom).toBe(false)
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(0)
  })

  it('keeps the stick on a wheel down', () => {
    const { el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.wheel(el, { deltaY: 40 })
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('releases on a touch move', () => {
    const { el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.touchMove(el)
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(0)
  })

  it.each(['ArrowUp', 'PageUp', 'Home'])('releases on the %s key', (key) => {
    const { el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.keyDown(el, { key })
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(0)
  })

  it.each(['ArrowDown', 'PageDown', 'End', 'a'])('keeps the stick on the %s key', (key) => {
    const { el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.keyDown(el, { key })
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('does not release while the content fits the box', () => {
    const { el, dims } = setup({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 })
    fireEvent.wheel(el, { deltaY: -40 })
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('re-sticks when the user scrolls back to the bottom', () => {
    const { el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.wheel(el, { deltaY: -40 })
    scrollTo(el, dims, bottom(dims))
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('does not follow growth while the user selects text inside the content', () => {
    const { dims, content } = setup()
    dims.scrollTop = 0
    const range = document.createRange()
    range.selectNodeContents(content)
    window.getSelection()?.addRange(range)
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(0)
  })

  it('still follows growth when the selection is outside the content', () => {
    const { dims } = setup()
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.appendChild(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    window.getSelection()?.addRange(range)
    dims.scrollTop = 0
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })
})

describe('useFollowBottom scrollToBottom', () => {
  it('scrolls to the bottom and reports at bottom', () => {
    const { result, el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.wheel(el, { deltaY: -40 })
    act(() => result.current.scrollToBottom())
    expect(dims.scrollTop).toBe(bottom(dims))
    expect(result.current.isAtBottom).toBe(true)
  })

  it('re-engages the stick after a release', () => {
    const { result, el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.wheel(el, { deltaY: -40 })
    act(() => result.current.scrollToBottom())
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('is a no-op without a scroll element', () => {
    const { result } = renderHook(() => useFollowBottom())
    act(() => result.current.scrollToBottom())
    expect(result.current.isAtBottom).toBe(true)
  })
})

describe('useFollowBottom refs', () => {
  it('exposes the attached elements on .current', () => {
    const { result, el, content } = setup()
    expect(result.current.scrollRef.current).toBe(el)
    expect(result.current.contentRef.current).toBe(content)
  })

  it('keeps ref and scrollToBottom identity across renders', () => {
    const { result, rerender } = renderHook(() => useFollowBottom())
    const first = result.current
    rerender()
    expect(result.current.scrollRef).toBe(first.scrollRef)
    expect(result.current.contentRef).toBe(first.contentRef)
    expect(result.current.scrollToBottom).toBe(first.scrollToBottom)
  })

  it('scrolls to the bottom when content attaches while stuck', () => {
    const { result } = renderHook(() => useFollowBottom())
    const { el, dims } = scrollBox({ scrollTop: 0 })
    act(() => {
      result.current.scrollRef(el)
      result.current.contentRef(contentBox(el))
    })
    expect(dims.scrollTop).toBe(bottom(dims))
  })

  it('does not scroll when content attaches after a release', () => {
    const { result, el, dims } = setup()
    dims.scrollTop = 0
    fireEvent.wheel(el, { deltaY: -40 })
    act(() => result.current.contentRef(contentBox(el)))
    expect(dims.scrollTop).toBe(0)
  })

  it('compares growth against the attached height', () => {
    const { result } = renderHook(() => useFollowBottom())
    const { el, dims } = scrollBox()
    act(() => {
      result.current.scrollRef(el)
      result.current.contentRef(contentBox(el, 1200))
    })
    dims.scrollTop = 0
    // 1100 < the 1200 measured at attach: a shrink, not growth.
    grow(dims, 1100)
    expect(dims.scrollTop).toBe(0)
  })

  it('stops listening to the old scroll element after a re-attach', () => {
    const { result, el: oldEl, dims: oldDims } = setup()
    const { el: newEl } = scrollBox()
    act(() => result.current.scrollRef(newEl))
    scrollTo(oldEl, oldDims, 0)
    expect(result.current.isAtBottom).toBe(true)
    expect(result.current.scrollRef.current).toBe(newEl)
  })

  it('listens to the new scroll element after a re-attach', () => {
    const { result } = setup()
    const { el: newEl, dims: newDims } = scrollBox()
    act(() => result.current.scrollRef(newEl))
    scrollTo(newEl, newDims, 0)
    expect(result.current.isAtBottom).toBe(false)
  })

  it('stops listening once the scroll element detaches', () => {
    const { result, el, dims } = setup()
    act(() => result.current.scrollRef(null))
    scrollTo(el, dims, 0)
    expect(result.current.isAtBottom).toBe(true)
    expect(result.current.scrollRef.current).toBeNull()
  })

  it('disconnects the old observer and observes the new content on re-attach', () => {
    const { result, el, content } = setup()
    const next = contentBox(el)
    act(() => result.current.contentRef(next))
    expect(observers).toHaveLength(2)
    expect(observers[0].observed).toEqual([content])
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(observers[1].observed).toEqual([next])
  })

  it('disconnects the observer when the content detaches', () => {
    const { result } = setup()
    act(() => result.current.contentRef(null))
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(result.current.contentRef.current).toBeNull()
  })

  it('does not re-observe when the same content element re-attaches', () => {
    const { result, content } = setup()
    act(() => result.current.contentRef(content))
    expect(observers).toHaveLength(1)
    expect(observers[0].disconnect).not.toHaveBeenCalled()
  })

  it('disconnects the observer on unmount', () => {
    const { unmount } = setup()
    unmount()
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('useFollowBottom scroll anchor', () => {
  /** Rows of 100px each, keyed `r0…`, laid out under the scroller's top (at y=0). */
  function rows(el: HTMLElement, dims: Dims, count: number) {
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div')
      row.dataset.anchorKey = `r${i}`
      row.getBoundingClientRect = () =>
        ({ top: i * 100 - dims.scrollTop, bottom: (i + 1) * 100 - dims.scrollTop }) as DOMRect
      el.appendChild(row)
    }
    el.getBoundingClientRect = () => ({ top: 0, bottom: dims.clientHeight }) as DOMRect
  }

  it('at the bottom (stuck): the anchor says so', () => {
    const { result, el, dims } = setup()
    rows(el, dims, 10)
    expect(result.current.captureAnchor()).toEqual({ atBottom: true })
  })

  it('scrolled up: the first row showing at the top, and how far into it', () => {
    const { result, el, dims } = setup()
    rows(el, dims, 10)
    fireEvent.wheel(el, { deltaY: -50 })
    scrollTo(el, dims, 230)
    expect(result.current.captureAnchor()).toEqual({ atBottom: false, key: 'r2', offsetPx: 30 })
  })

  it('a hidden scroller (no height) gives no anchor', () => {
    const { result, el, dims } = setup()
    rows(el, dims, 10)
    fireEvent.wheel(el, { deltaY: -50 })
    dims.clientHeight = 0
    expect(result.current.captureAnchor()).toBeNull()
  })

  it('restoring puts that row back at the top and stops following the bottom', () => {
    const { result, el, dims } = setup()
    rows(el, dims, 10)
    let ok = false
    act(() => {
      ok = result.current.restoreAnchor({ atBottom: false, key: 'r3', offsetPx: 40 })
    })
    expect(ok).toBe(true)
    expect(dims.scrollTop).toBe(340)
    expect(result.current.isAtBottom).toBe(false)
    // Content growth no longer pulls it down.
    grow(dims, 1500)
    expect(dims.scrollTop).toBe(340)
  })

  it('a row that is not rendered: not restored (the caller retries or gives up)', () => {
    const { result, el, dims } = setup()
    rows(el, dims, 3)
    let ok = true
    act(() => {
      ok = result.current.restoreAnchor({ atBottom: false, key: 'r9', offsetPx: 0 })
    })
    expect(ok).toBe(false)
  })
})
