import { describe, expect, it } from 'vitest'
import {
  NAV_FOCUS_RECLAIM_MS,
  NavFocusGuard,
  type FocusOwner
} from './browser-view-nav-focus-guard'

const VIEW_ID = 7
const terminalOwner: FocusOwner = { id: 1, isDestroyed: () => false }

function setup() {
  let now = 1_000_000
  const calls: string[] = []
  let explicitAt = 0
  const ref: { guard?: NavFocusGuard<FocusOwner> } = {}
  const guard = new NavFocusGuard<FocusOwner>({
    now: () => now,
    viewId: VIEW_ID,
    explicitFocusAt: () => explicitAt,
    onGenuine: () => calls.push('genuine'),
    onStolen: (o) => calls.push(`stolen:${o.id}`),
    onReclaim: () => {
      calls.push('reclaim')
      ref.guard?.focused() // wc.focus() fires the view's focus event again
    }
  })
  ref.guard = guard
  return {
    guard,
    calls,
    advance: (ms: number) => (now += ms),
    setExplicit: () => (explicitAt = now)
  }
}

describe('NavFocusGuard', () => {
  it('real click into a loading page wins — focus arrives BEFORE its mouseDown', () => {
    const { guard, calls, advance } = setup()
    guard.navigationStarted(terminalOwner) // page never finishes loading
    advance(5_000)
    guard.focused() // AppKit first-responder change
    expect(calls).toEqual(['stolen:1']) // hand-back is immediate
    advance(1)
    guard.userInput() // the click's mouseDown input-event
    expect(calls).toEqual(['stolen:1', 'reclaim', 'genuine'])
  })

  it('focus grab during load with no user input is handed back immediately', () => {
    const { guard, calls } = setup()
    guard.navigationStarted(terminalOwner)
    guard.focused()
    expect(calls).toEqual(['stolen:1'])
  })

  it('input long after a hand-back does not reclaim', () => {
    const { guard, calls, advance } = setup()
    guard.navigationStarted(terminalOwner)
    guard.focused()
    advance(NAV_FOCUS_RECLAIM_MS)
    guard.userInput()
    expect(calls).toEqual(['stolen:1'])
  })

  it('reclaims at most once per hand-back', () => {
    const { guard, calls, advance } = setup()
    guard.navigationStarted(terminalOwner)
    guard.focused()
    guard.userInput()
    advance(1)
    guard.userInput()
    expect(calls).toEqual(['stolen:1', 'reclaim', 'genuine'])
  })

  it('restores only once per navigation', () => {
    const { guard, calls } = setup()
    guard.navigationStarted(terminalOwner)
    guard.focused()
    guard.focused()
    expect(calls).toEqual(['stolen:1', 'genuine'])
  })

  it('input just before focus is genuine', () => {
    const { guard, calls, advance } = setup()
    guard.navigationStarted(terminalOwner)
    guard.userInput()
    advance(5)
    guard.focused()
    expect(calls).toEqual(['genuine'])
  })

  it('explicit focus request is genuine', () => {
    const { guard, calls, setExplicit } = setup()
    guard.navigationStarted(terminalOwner)
    setExplicit()
    guard.focused()
    expect(calls).toEqual(['genuine'])
  })

  it('guard expires shortly after load stops', () => {
    const { guard, calls, advance } = setup()
    guard.navigationStarted(terminalOwner)
    guard.loadStopped()
    advance(301)
    guard.focused()
    expect(calls).toEqual(['genuine'])
  })

  it('no guard when the view itself held focus at navigation start', () => {
    const { guard, calls } = setup()
    guard.navigationStarted({ id: VIEW_ID, isDestroyed: () => false })
    guard.focused()
    expect(calls).toEqual(['genuine'])
  })
})
