// @vitest-environment jsdom
// Pins useSharedCardHeights: on mount it water-fills the open cards into
// `grid-template-rows` (closed cards `auto`) and floors the grid's min-height; it
// re-measures when the caller's deps change — and only then, not on a plain re-render —
// and tears its observers down on unmount.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useSharedCardHeights } from './useSharedCardHeights'

// jsdom has no layout: element boxes come from data attributes (cards) or `avail` (grid).
let avail = 0
let observers: Array<{ disconnected: boolean }> = []
const protoDescs: Array<[string, PropertyDescriptor | undefined]> = []
const RO = globalThis.ResizeObserver
beforeAll(() => {
  const box = (attr: string) =>
    function (this: HTMLElement) {
      if (this.dataset.grid) return avail
      return Number(this.dataset[attr] ?? 0)
    }
  for (const [prop, attr] of [
    ['clientHeight', 'ch'],
    ['scrollHeight', 'sh'],
    ['offsetHeight', 'oh']
  ] as const) {
    protoDescs.push([prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)])
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: box(attr) })
  }
  globalThis.ResizeObserver = class {
    entry = { disconnected: false }
    constructor() {
      observers.push(this.entry)
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.entry.disconnected = true
    }
  } as unknown as typeof ResizeObserver
})
afterAll(() => {
  for (const [prop, d] of protoDescs)
    if (d) Object.defineProperty(HTMLElement.prototype, prop, d)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
  globalThis.ResizeObserver = RO
})

type Card = { open: boolean; natural: number }
type P = { cards: Card[]; deps: unknown[]; tick: number }
function Grid({ cards, deps }: P) {
  const ref = useRef<HTMLDivElement>(null)
  useSharedCardHeights(ref, deps)
  return (
    <div ref={ref} data-grid="1" data-testid="grid">
      {cards.map((c, i) => (
        <div
          key={i}
          data-card=""
          data-card-open={c.open ? 'true' : 'false'}
          data-sh={c.natural}
          data-oh={30}
        />
      ))}
    </div>
  )
}
function setup(p: P) {
  const r = render(<Grid {...p} />)
  const grid = () => r.getByTestId('grid')
  return { grid, rerender: (n: P) => r.rerender(<Grid {...n} />), unmount: r.unmount }
}

beforeEach(() => {
  avail = 300
  observers = []
})
afterEach(cleanup)

describe('useSharedCardHeights', () => {
  it('water-fills open cards on mount; closed cards are auto', () => {
    const cards = [
      { open: true, natural: 100 },
      { open: false, natural: 0 },
      { open: true, natural: 400 }
    ]
    const { grid } = setup({ cards, deps: [1], tick: 0 })
    // avail 300 − closed header 30 = 270; short card keeps 100 → level 170.
    expect(grid().style.gridTemplateRows).toBe('fit-content(170px) auto fit-content(170px)')
    // floor: min(100,144) + min(400,144) + 30
    expect(grid().style.minHeight).toBe('274px')
  })

  it('no cap when everything fits', () => {
    const { grid } = setup({ cards: [{ open: true, natural: 100 }], deps: [1], tick: 0 })
    expect(grid().style.gridTemplateRows).toBe('max-content')
  })

  it('re-measures when deps change, not on a plain re-render', () => {
    const cards = [
      { open: true, natural: 100 },
      { open: true, natural: 400 }
    ]
    const { grid, rerender } = setup({ cards, deps: [1], tick: 0 })
    expect(grid().style.gridTemplateRows).toBe('fit-content(200px) fit-content(200px)')
    expect(observers).toHaveLength(1)

    avail = 400
    rerender({ cards, deps: [1], tick: 1 })
    expect(observers).toHaveLength(1)
    expect(grid().style.gridTemplateRows).toBe('fit-content(200px) fit-content(200px)')

    rerender({ cards, deps: [2], tick: 1 })
    expect(observers).toHaveLength(2)
    expect(observers[0].disconnected).toBe(true)
    expect(grid().style.gridTemplateRows).toBe('fit-content(300px) fit-content(300px)')
  })

  it('disconnects its observers on unmount', () => {
    const { unmount } = setup({ cards: [{ open: true, natural: 100 }], deps: [1], tick: 0 })
    unmount()
    expect(observers.every((o) => o.disconnected)).toBe(true)
  })
})
