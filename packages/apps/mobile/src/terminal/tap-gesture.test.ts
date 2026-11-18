import { DOUBLE_TAP_MS, TapTracker } from './tap-gesture'

/** A tracker on a clock the test moves. */
function tracker() {
  let now = 1_000
  const t = new TapTracker(() => now)
  const tap = (x: number, y: number, holdMs = 50) => {
    t.start(x, y)
    now += holdMs
    return t.end()
  }
  return {
    t,
    tap,
    wait: (ms: number) => {
      now += ms
    }
  }
}

describe('TapTracker', () => {
  it('a short touch that stays put is a tap; a second one soon and close by is a double tap', () => {
    const { tap, wait } = tracker()
    expect(tap(100, 100)).toBe('tap')
    wait(100)
    expect(tap(104, 103)).toBe('double')
    // The pair is used up: the next one starts over.
    wait(100)
    expect(tap(100, 100)).toBe('tap')
  })

  it('a flick (the finger moved) is no tap — two quick scroll flicks never zoom', () => {
    const { t, wait } = tracker()
    t.start(100, 100)
    t.move(100, 140)
    expect(t.end()).toBeNull()
    wait(50)
    t.start(100, 100)
    t.move(100, 130)
    expect(t.end()).toBeNull()
  })

  it('a touch held too long is no tap', () => {
    const { tap } = tracker()
    expect(tap(100, 100, 400)).toBeNull()
  })

  it('a tap after a flick is a first tap, not the second of a pair', () => {
    const { t, tap, wait } = tracker()
    expect(tap(100, 100)).toBe('tap')
    wait(50)
    t.start(100, 100)
    t.move(100, 160)
    expect(t.end()).toBeNull()
    wait(50)
    expect(tap(100, 100)).toBe('tap')
  })

  it('the second tap must come in time and near the first', () => {
    const { tap, wait } = tracker()
    expect(tap(100, 100)).toBe('tap')
    wait(DOUBLE_TAP_MS + 10)
    expect(tap(100, 100)).toBe('tap')
    wait(50)
    expect(tap(200, 300)).toBe('tap')
  })

  it('a second finger (a pinch) cancels the tap', () => {
    const { t } = tracker()
    t.start(100, 100)
    t.cancel()
    expect(t.end()).toBeNull()
  })
})
