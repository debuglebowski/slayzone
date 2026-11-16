// @vitest-environment jsdom
// Production React/Compiler/DiffPreview/DiffView/TanStack; jsdom has no layout.
// Geometry and ResizeObserver delivery are supplied explicitly, not browser proof.
import { Activity, StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DiffView, parseUnifiedDiff } from '@slayzone/diff-view'
vi.mock('../../../../shared/diff-view/src/highlight', () => ({ tokenizeContent: async () => [] }))
import { DiffPreview } from './DiffPreview'
import { observeListLayout } from '../../../../shared/diff-view/src/DiffView.layout'

const file = (name: string, count = 200) =>
  `diff --git a/${name}.txt b/${name}.txt\nnew file mode 100644\n--- /dev/null\n+++ b/${name}.txt\n@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+${name} line ${i}`).join('\n')}\n`
const b = parseUnifiedDiff(file('b'))[0]
let viewportHeight = 200
let variable = false
let intrinsicHeights = new WeakMap<HTMLElement, number>()
const observers = new Set<FakeResizeObserver>()
class FakeResizeObserver {
  readonly targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this)
  }
  observe = (target: Element) => {
    this.targets.add(target)
  }
  unobserve = (target: Element) => {
    this.targets.delete(target)
  }
  disconnect = () => {
    this.targets.clear()
    observers.delete(this)
  }
}
const viewport = (el: Element) =>
  el.classList.contains('overflow-auto') || el.hasAttribute('data-viewport')
const absolute = (el: HTMLElement) =>
  el.style.position === 'absolute' || el.classList.contains('absolute')
function height(el: HTMLElement): number {
  if (viewport(el)) return viewportHeight
  const intrinsic = intrinsicHeights.get(el)
  if (intrinsic !== undefined) return intrinsic
  if (el.hasAttribute('data-index')) return variable && Number(el.dataset.index) % 3 === 0 ? 40 : 20
  if (el.style.height) return Number.parseFloat(el.style.height)
  if (el.classList.contains('text-[11px]') || el.tagName === 'HEADER') return 20
  const children = [...el.children].filter(
    (child) => !absolute(child as HTMLElement)
  ) as HTMLElement[]
  if (!children.length) return 0
  const heights = children.map(height)
  return el.classList.contains('flex') && !el.classList.contains('flex-col')
    ? Math.max(...heights)
    : heights.reduce((a, n) => a + n, 0)
}
function top(el: HTMLElement): number {
  if (viewport(el)) return 100
  const parent = el.parentElement
  if (!parent || parent === document.body) return 0
  const base = top(parent) + (viewport(parent) ? 2 : 0) - parent.scrollTop
  if (absolute(el))
    return base + Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0)
  if (parent.classList.contains('flex') && !parent.classList.contains('flex-col')) return base
  let offset = 0
  for (const sibling of parent.children) {
    if (sibling === el) break
    if (!absolute(sibling as HTMLElement)) offset += height(sibling as HTMLElement)
  }
  return base + offset
}
function rect(el: HTMLElement): DOMRect {
  return {
    x: 0,
    y: top(el),
    top: top(el),
    bottom: top(el) + height(el),
    left: 0,
    right: 800,
    width: 800,
    height: height(el),
    toJSON: () => ({})
  }
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function resized(target?: Element) {
  await act(async () => {
    for (const observer of [...observers]) {
      const entries = [...observer.targets]
        .filter((element) => !target || target === element)
        .map((target) => ({
          target,
          contentRect: rect(target as HTMLElement),
          borderBoxSize: [{ blockSize: height(target as HTMLElement), inlineSize: 800 }]
        })) as unknown as ResizeObserverEntry[]
      if (entries.length) observer.callback(entries, observer as unknown as ResizeObserver)
    }
    await frame()
  })
}
beforeEach(() => {
  viewportHeight = 200
  variable = false
  intrinsicHeights = new WeakMap()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (element) =>
      new Proxy(computed(element), {
        get(target, key) {
          if (
            key === 'overflowY' &&
            (viewport(element) || element.classList.contains('overflow-x-auto'))
          )
            return 'auto'
          if (key === 'position' && element.classList.contains('absolute')) return 'absolute'
          return Reflect.get(target, key, target)
        }
      })
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return height(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return height(this)
  })
  vi.spyOn(HTMLElement.prototype, 'clientTop', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return viewport(this) ? 2 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return viewport(this)
      ? [...this.children].reduce((n, child) => n + height(child as HTMLElement), 0)
      : height(this)
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return rect(this)
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observers.clear()
})

async function scrollTo(vp: HTMLElement, offset: number) {
  act(() => {
    vp.scrollTop = offset
    fireEvent.scroll(vp)
  })
  await act(frame)
}
async function expectLine(vp: HTMLElement, index: number) {
  await waitFor(() => expect(screen.queryAllByText(`b line ${index}`).length).toBeGreaterThan(0))
  const row = screen.getAllByText(`b line ${index}`)[0].closest<HTMLElement>('[data-index]')!
  // Correct transforms as well as correct range; mounted overscan alone is insufficient.
  expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(100)
  expect(row.getBoundingClientRect().top).toBeLessThan(102 + viewportHeight)
  expect(vp.querySelectorAll('[data-index]').length).toBeLessThan(100)
}

test.each([0, 100, 199])(
  'actual artifact DiffPreview reaches later file row %s at its physical offset',
  async (index) => {
    const view = render(<DiffPreview content={file('a') + file('b')} />)
    const vp = view.container.firstElementChild as HTMLElement
    await resized()
    await scrollTo(vp, 4040 + index * 20)
    await expectLine(vp, index)
  }
)

function Shared({
  count = 200,
  expanded = true,
  header = 20,
  sideBySide = false,
  wrap = false
}: {
  count?: number
  expanded?: boolean
  header?: number
  sideBySide?: boolean
  wrap?: boolean
}) {
  return (
    <div data-viewport style={{ overflowY: 'auto' }}>
      <section>{expanded && <DiffView diff={parseUnifiedDiff(file('a', count))[0]} />}</section>
      <section>
        <header style={{ height: header }}>Second file</header>
        <DiffView diff={b} sideBySide={sideBySide} wrap={wrap} />
      </section>
    </div>
  )
}

test.each([false, true])(
  'stash-style shared viewport keeps later unified/sbs rows reachable (sbs=%s)',
  async (sideBySide) => {
    const view = render(<Shared sideBySide={sideBySide} />)
    const vp = view.container.firstElementChild as HTMLElement
    await resized()
    for (const index of [0, 100, 199]) {
      await scrollTo(vp, 4020 + index * 20)
      await expectLine(vp, index)
    }
  }
)

test('preceding Load rest, collapse, expansion and header reflow move a memoized later list', async () => {
  const view = render(<Shared />)
  const vp = view.container.firstElementChild as HTMLElement
  for (const [count, expanded, header, origin] of [
    [400, true, 20, 8020],
    [400, false, 20, 20],
    [200, true, 60, 4060],
    [200, true, 20, 4020]
  ] as const) {
    view.rerender(<Shared count={count} expanded={expanded} header={header} />)
    await resized()
    await scrollTo(vp, origin)
    await expectLine(vp, 0)
  }
})

test('container resize and variable wrapped row measurements retain later content', async () => {
  variable = true
  const view = render(<Shared wrap />)
  const vp = view.container.firstElementChild as HTMLElement
  await resized()
  // Measurements replace estimates. Reach a visible row using the list's actual current height.
  const first = vp.children[0] as HTMLElement
  await scrollTo(vp, height(first) + 20)
  await resized()
  await expectLine(vp, 0)
  viewportHeight = 360
  await resized()
  await scrollTo(vp, height(first) + 20)
  await expectLine(vp, 0)
})

test('Activity return measures new offsets and StrictMode replay releases observers', async () => {
  const draw = (visible: boolean, count: number) => (
    <StrictMode>
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <Shared count={count} />
      </Activity>
    </StrictMode>
  )
  const view = render(draw(true, 200))
  view.rerender(draw(false, 200))
  view.rerender(draw(true, 400))
  await resized()
  const vp = view.container.querySelector<HTMLElement>('[data-viewport]')!
  await scrollTo(vp, 8020)
  await expectLine(vp, 0)
  view.unmount()
  expect([...observers].some((o) => o.targets.size)).toBe(false)
})

test('intrinsic preceding header growth refreshes offsets without a scroll event or React render', async () => {
  const view = render(<Shared />)
  const vp = view.container.firstElementChild as HTMLElement
  await resized()
  await scrollTo(vp, 6020)
  await expectLine(vp, 100)
  const header = vp.querySelector('header')!
  intrinsicHeights.set(header, 1020)
  await resized(header)
  await expectLine(vp, 50)
})

test('structural mutation alone refreshes preceding offsets before the next scroll', async () => {
  const view = render(<Shared />)
  const vp = view.container.firstElementChild as HTMLElement
  await resized()
  await scrollTo(vp, 6020)
  await expectLine(vp, 100)
  await act(async () => {
    vp.querySelector('header')!.style.height = '1020px'
    await frame()
    await frame()
  })
  await expectLine(vp, 50)
})

test.each([false, true])(
  'wrapped variable rows in later files stay reachable from start through end (sbs=%s)',
  async (sideBySide) => {
    variable = true
    const view = render(<Shared sideBySide={sideBySide} wrap />)
    const vp = view.container.firstElementChild as HTMLElement
    await resized()
    for (const index of [0, 100, 199]) {
      // Follow physical scrolling through measured/estimated rows as a user does;
      // never assume fixed wrapped-row height or a fixed preceding file height.
      let found = false
      for (let step = 0; step < 30; step++) {
        const origin = height(vp.children[0] as HTMLElement) + 20
        await scrollTo(vp, origin + index * 20 + step * 160)
        await resized()
        const line = screen.queryAllByText(`b line ${index}`)[0]
        if (!line) continue
        const delta = line.closest<HTMLElement>('[data-index]')!.getBoundingClientRect().top - 102
        await scrollTo(vp, vp.scrollTop + delta)
        await expectLine(vp, index)
        found = true
        break
      }
      expect(found).toBe(true)
    }
  }
)

test('side-by-side horizontal synchronization survives Activity reactivation', async () => {
  const draw = (show: boolean) => (
    <Activity mode={show ? 'visible' : 'hidden'}>
      <Shared sideBySide />
    </Activity>
  )
  const view = render(draw(true))
  await resized()
  view.rerender(draw(false))
  view.rerender(draw(true))
  await resized()
  const section = screen.getByText('Second file').parentElement!
  const columns = section.querySelectorAll<HTMLElement>('.overflow-x-auto')
  expect(columns).toHaveLength(2)
  fireEvent.scroll(columns[0], { target: { scrollLeft: 123 } })
  expect(columns[1].scrollLeft).toBe(123)
  fireEvent.scroll(columns[1], { target: { scrollLeft: 71 } })
  expect(columns[0].scrollLeft).toBe(71)
})

test('absolute outer virtualizer retains row ownership', async () => {
  const view = render(
    <div data-viewport style={{ overflowY: 'auto' }}>
      <div style={{ height: 4000, position: 'relative' }}>
        <div style={{ position: 'absolute' }}>
          <DiffView diff={b} />
        </div>
      </div>
    </div>
  )
  await resized()
  expect(view.container.querySelectorAll('[data-index]')).toHaveLength(0)
  expect(screen.getByText('b line 0')).toBeDefined()
  expect(screen.getByText('b line 199')).toBeDefined()
})

test('queued old observer callbacks cannot measure after effect cleanup', async () => {
  const view = render(<Shared />)
  await resized()
  const stale = [...observers]
  view.unmount()
  const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length
  await act(async () => {
    for (const observer of stale) observer.callback([], observer as unknown as ResizeObserver)
    await frame()
  })
  expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls).toHaveLength(reads)
  expect([...observers].some((observer) => observer.targets.size)).toBe(false)
})

const single = (show = true) => (
  <StrictMode>
    <Activity mode={show ? 'visible' : 'hidden'}>
      <div data-viewport style={{ overflowY: 'auto' }}>
        <DiffView diff={b} />
      </div>
    </Activity>
  </StrictMode>
)

test.each(['initial no-overflow', 'bounded then fallback'] as const)(
  'ancestor-only resize restores bounded rows after %s, without window resize or render',
  async (start) => {
    if (start === 'initial no-overflow') viewportHeight = 5000
    const view = render(single())
    const vp = view.container.querySelector<HTMLElement>('[data-viewport]')!
    await resized()
    if (start === 'bounded then fallback') {
      expect(vp.querySelectorAll('[data-index]').length).toBeLessThan(100)
      viewportHeight = 5000
      await resized(vp)
      await act(frame)
    }
    expect(vp.querySelectorAll('[data-index]')).toHaveLength(200)
    viewportHeight = 200
    // Deliver only boxes that changed: the full-height wrapper/list stay4000px.
    await resized(vp)
    await scrollTo(vp, 2000)
    await expectLine(vp, 100)
  }
)

test.each(['style', 'scroll'] as const)(
  'fallback recovers from ancestor %s alone',
  async (signal) => {
    viewportHeight = 5000
    const view = render(single())
    const vp = view.container.querySelector<HTMLElement>('[data-viewport]')!
    await resized()
    expect(vp.querySelectorAll('[data-index]')).toHaveLength(200)
    viewportHeight = 200
    if (signal === 'style') {
      await act(async () => {
        vp.style.height = '200px'
        await frame()
        await frame()
      })
      // The ancestor's own style mutation must rediscover the root BEFORE scroll.
      expect(vp.querySelectorAll('[data-index]').length).toBeLessThan(100)
    }
    await scrollTo(vp, 2000)
    await expectLine(vp, 100)
  }
)

test('window resize remains a recovery signal', async () => {
  viewportHeight = 5000
  const view = render(single())
  const vp = view.container.querySelector<HTMLElement>('[data-viewport]')!
  await resized()
  viewportHeight = 200
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
    await frame()
  })
  await scrollTo(vp, 2000)
  await expectLine(vp, 100)
})

test('fallback root follows ancestor replacement and releases old ancestor listeners', async () => {
  viewportHeight = 5000
  const oldVp = document.createElement('div')
  oldVp.setAttribute('data-viewport', '')
  oldVp.style.overflowY = 'auto'
  const wrapper = document.createElement('div')
  wrapper.className = 'overflow-x-auto'
  const list = document.createElement('div')
  list.style.height = '4000px'
  wrapper.append(list)
  oldVp.append(wrapper)
  document.body.append(oldVp)
  const updates: Array<{ parent: HTMLElement | null; offset: number }> = []
  const release = observeListLayout(list, (layout) => updates.push(layout))
  await act(frame)
  const newVp = document.createElement('div')
  try {
    expect(updates.at(-1)?.parent).toBe(wrapper)
    newVp.setAttribute('data-viewport', '')
    newVp.style.overflowY = 'auto'
    document.body.append(newVp)
    viewportHeight = 200
    await act(async () => {
      newVp.append(wrapper)
      await frame()
      await frame()
    })
    expect(updates.at(-1)?.parent).toBe(newVp)
    await act(frame)
    const before = updates.length
    oldVp.dispatchEvent(new Event('scroll'))
    await act(frame)
    expect(updates).toHaveLength(before)
  } finally {
    release()
    oldVp.remove()
    newVp.remove()
  }
})

test('ancestor recovery and Activity replay retain no detached resource generation', async () => {
  const view = render(single())
  await resized()
  viewportHeight = 5000
  const vp = view.container.querySelector<HTMLElement>('[data-viewport]')!
  await resized(vp)
  view.rerender(single(false))
  const stale = [...observers]
  viewportHeight = 200
  view.rerender(single())
  await resized(vp)
  await scrollTo(vp, 2000)
  await expectLine(vp, 100)
  view.unmount()
  const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length
  await act(async () => {
    for (const observer of stale) observer.callback([], observer as unknown as ResizeObserver)
    vp.dispatchEvent(new Event('scroll'))
    await frame()
  })
  expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls).toHaveLength(reads)
  expect([...observers].filter((observer) => observer.targets.size)).toEqual([])
})

test('120 lists share coalesced structural observation, ignore unrelated subtree churn, and fully release', async () => {
  const root = document.createElement('div')
  root.setAttribute('data-viewport', '')
  root.style.overflowY = 'auto'
  const unrelated = document.createElement('section')
  unrelated.style.height = '20px'
  const sibling = document.createElement('div')
  unrelated.append(sibling)
  document.body.append(root, unrelated)
  const lists = Array.from({ length: 120 }, () => {
    const section = document.createElement('section')
    const list = document.createElement('div')
    list.style.height = '4000px'
    for (let i = 0; i < 20; i++) {
      const row = document.createElement('div')
      row.setAttribute('data-index', String(i))
      list.append(row)
    }
    section.append(list)
    root.append(section)
    return list
  })
  let publications = 0
  const releases = lists.map((list) =>
    observeListLayout(list, () => {
      publications++
    })
  )
  await act(frame)
  expect(observers.size).toBe(1)
  const native = [...observers][0]
  const inside = () => [...native.targets].filter((node) => root.contains(node))
  expect(inside()).toHaveLength(241)
  expect([...native.targets].some((node) => node.hasAttribute('data-index'))).toBe(false)
  expect([...native.targets].every((node) => root.contains(node) || node.contains(root))).toBe(true)
  let before = publications
  for (let i = 0; i < 10; i++) root.dispatchEvent(new Event('scroll'))
  await act(frame)
  expect(publications - before).toBe(120)
  before = publications
  await act(async () => {
    sibling.style.color = 'red'
    sibling.textContent = 'unrelated fixed-size subtree'
    sibling.dispatchEvent(new Event('scroll'))
    await frame()
    await frame()
  })
  expect(publications).toBe(before)
  releases.splice(0, 60).forEach((release) => release())
  before = publications
  await act(frame)
  expect(publications - before).toBe(60)
  expect(inside()).toHaveLength(181)
  releases.forEach((release) => release())
  before = publications
  native.callback([], native as unknown as ResizeObserver)
  root.dispatchEvent(new Event('scroll'))
  document.body.dispatchEvent(new Event('scroll'))
  await act(frame)
  expect(publications).toBe(before)
  expect(observers.size).toBe(0)
  root.remove()
  unrelated.remove()
})

test('preceding Load rest invalidates fallback lists when only a sibling box grows', async () => {
  viewportHeight = 7000
  const view = render(<Shared count={100} />)
  const vp = view.container.firstElementChild as HTMLElement
  await resized()
  expect(vp.children[1].querySelectorAll('[data-index]')).toHaveLength(200)
  // Only the preceding file grows; the ancestor viewport and later file keep
  // their box sizes. Later DiffView's props stay memoized.
  view.rerender(<Shared count={400} />)
  await resized(vp.children[0])
  await act(frame)
  expect(vp.children[1].querySelectorAll('[data-index]').length).toBeLessThan(100)
  await scrollTo(vp, 8020)
  await waitFor(() => expect(screen.queryByText('b line 0')).not.toBeNull())
  expect(
    screen.getByText('b line 0').closest<HTMLElement>('[data-index]')!.getBoundingClientRect().top
  ).toBe(102)
})
