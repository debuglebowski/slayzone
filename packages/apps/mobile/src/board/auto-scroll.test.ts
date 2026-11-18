import {
  type AutoScroll,
  boardScrollPlan,
  createAutoScroll,
  createScrollRegistry,
  type DragLayout,
  type FrameClock
} from './auto-scroll'

/** Frames run by hand. */
function manualClock(): FrameClock & { step: () => void } {
  let queued: (() => void) | null = null
  return {
    request: (run) => {
      queued = run
      return 1
    },
    cancel: () => {
      queued = null
    },
    step: () => {
      const run = queued
      queued = null
      run?.()
    }
  }
}

const scrollEvent = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as never
const layoutEvent = (height: number) =>
  ({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } }) as never

describe('createScrollRegistry', () => {
  it('scrolls a list by a delta within its content (plus its end inset)', () => {
    const scroll = createScrollRegistry()
    const list = { scrollToOffset: jest.fn() }
    const props = scroll.props('page:todo', 'y', 76)
    props.ref(list)
    props.onLayout(layoutEvent(400))
    props.onContentSizeChange(300, 1000)
    props.onScroll(scrollEvent(600))

    expect(scroll.scrollBy('page:todo', 20)).toBe(true)
    expect(list.scrollToOffset).toHaveBeenLastCalledWith({ offset: 620, animated: false })
    // 1000 + 76 − 400 = 676 at most.
    expect(scroll.scrollBy('page:todo', 100)).toBe(true)
    expect(list.scrollToOffset).toHaveBeenLastCalledWith({ offset: 676, animated: false })
    expect(scroll.scrollBy('page:todo', 10)).toBe(false)
  })

  it('a horizontal ScrollView scrolls on x; an unknown or unmounted one does nothing', () => {
    const scroll = createScrollRegistry()
    const view = { scrollTo: jest.fn() }
    const props = scroll.props('columns', 'x')
    props.ref(view)
    props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 500, height: 800 } } } as never)
    props.onContentSizeChange(1500, 800)
    expect(scroll.scrollBy('columns', 30)).toBe(true)
    expect(view.scrollTo).toHaveBeenLastCalledWith({ x: 30, animated: false })
    expect(scroll.scrollBy('columns', -40)).toBe(true)
    expect(view.scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false })
    props.ref(null)
    expect(scroll.scrollBy('columns', 30)).toBe(false)
    expect(scroll.scrollBy('nope', 30)).toBe(false)
  })

  it('hands back the same props per key (refs stay attached across renders)', () => {
    const scroll = createScrollRegistry()
    expect(scroll.props('list', 'y')).toBe(scroll.props('list', 'y'))
  })
})

describe('createAutoScroll', () => {
  const layout: DragLayout = { mode: 'pages', columns: [], root: null, shownId: 'todo' }

  function setup(speed: number, canMove = true) {
    const clock = manualClock()
    const scrollBy = jest.fn(() => canMove)
    const onScrolled = jest.fn()
    const auto: AutoScroll = createAutoScroll(
      { scrollBy },
      (l, point) => [{ key: `page:${l.shownId}`, speed: point.y > 500 ? speed : 0 }],
      clock
    )
    return { clock, scrollBy, onScrolled, auto }
  }

  it('scrolls every frame while the finger is in an edge zone, and stops with the drag', () => {
    const { clock, scrollBy, onScrolled, auto } = setup(8)
    auto.start({ x: 10, y: 100 }, layout, onScrolled)
    clock.step()
    expect(scrollBy).not.toHaveBeenCalled()
    auto.move({ x: 10, y: 600 })
    clock.step()
    clock.step()
    expect(scrollBy).toHaveBeenCalledTimes(2)
    expect(scrollBy).toHaveBeenLastCalledWith('page:todo', 8)
    expect(onScrolled).toHaveBeenCalledTimes(2)
    auto.update({ shownId: 'done' })
    clock.step()
    expect(scrollBy).toHaveBeenLastCalledWith('page:done', 8)
    auto.stop()
    clock.step()
    expect(scrollBy).toHaveBeenCalledTimes(3)
  })

  it('targets are stale after a scroll, until a measurement taken after it is in', () => {
    const { clock, onScrolled, auto } = setup(8)
    auto.start({ x: 10, y: 600 }, layout, onScrolled)
    expect(auto.stale()).toBe(false)
    const before = auto.snapshot()
    clock.step()
    expect(auto.stale()).toBe(true)
    // A measurement started before that scroll doesn't make the targets current.
    auto.measured(before)
    expect(auto.stale()).toBe(true)
    auto.measured(auto.snapshot())
    expect(auto.stale()).toBe(false)
    auto.markStale()
    expect(auto.stale()).toBe(true)
  })

  it('a scroller at its end is not "scrolled"', () => {
    const { clock, onScrolled, auto } = setup(8, false)
    auto.start({ x: 10, y: 600 }, layout, onScrolled)
    clock.step()
    expect(onScrolled).not.toHaveBeenCalled()
    expect(auto.stale()).toBe(false)
  })
})

describe('boardScrollPlan', () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

  it("a phone scrolls its shown column when the finger nears the page's top or bottom", () => {
    const layout: DragLayout = {
      mode: 'pages',
      shownId: 'todo',
      root: rect(0, 100, 390, 700),
      columns: [
        { id: 'todo', rect: rect(0, 150, 390, 650) },
        // Its chip in the strip above the page.
        { id: 'todo', rect: rect(10, 110, 80, 30), atEnd: true }
      ]
    }
    expect(boardScrollPlan(layout, { x: 100, y: 790 })).toEqual([
      { key: 'page:todo', speed: expect.any(Number) }
    ])
    expect(boardScrollPlan(layout, { x: 100, y: 790 })[0]?.speed).toBeGreaterThan(0)
    expect(boardScrollPlan(layout, { x: 100, y: 160 })[0]?.speed).toBeLessThan(0)
    // Over the strip: no scroll (the finger aims at a chip).
    expect(boardScrollPlan(layout, { x: 30, y: 120 })[0]?.speed).toBe(0)
  })

  it('the list scrolls as a whole', () => {
    const layout: DragLayout = {
      mode: 'list',
      shownId: undefined,
      root: rect(0, 100, 390, 700),
      columns: []
    }
    expect(boardScrollPlan(layout, { x: 100, y: 795 })).toEqual([
      { key: 'list', speed: expect.any(Number) }
    ])
    expect(boardScrollPlan(layout, { x: 100, y: 795 })[0]?.speed).toBeGreaterThan(0)
  })

  it('an iPad scrolls its columns sideways near the left/right edge, and the column under the finger', () => {
    const layout: DragLayout = {
      mode: 'columns',
      shownId: undefined,
      root: rect(68, 60, 900, 700),
      columns: [
        { id: 'todo', rect: rect(80, 60, 288, 700) },
        { id: 'done', rect: rect(380, 60, 288, 700) }
      ]
    }
    const steps = boardScrollPlan(layout, { x: 960, y: 400 })
    expect(steps.find((s) => s.key === 'columns')?.speed).toBeGreaterThan(0)
    const down = boardScrollPlan(layout, { x: 400, y: 750 })
    expect(down.find((s) => s.key === 'col:done')?.speed).toBeGreaterThan(0)
    expect(down.find((s) => s.key === 'columns')?.speed).toBe(0)
  })
})
