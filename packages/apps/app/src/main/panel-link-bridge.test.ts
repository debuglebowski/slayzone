/**
 * The modified-link bridge is in the page's own world, so a page can call it without
 * the user doing anything (review 4 LOW): main acts only on a real user act in that
 * tab, once per act, and opens the system browser only from the user's own tab.
 */
import { describe, expect, test } from 'vitest'
import { GESTURE_WINDOW_MS, linkBridgeAllowed, UserGestureTracker } from './panel-link-bridge'

function tracker() {
  let t = 1_000
  const g = new UserGestureTracker(() => t)
  return { g, advance: (ms: number) => (t += ms) }
}

describe('a call without a user act is refused', () => {
  test('no input at all', () => {
    const { g } = tracker()
    expect(linkBridgeAllowed('create-task', 1, { gestures: g, untrusted: false })).toBe(false)
    expect(linkBridgeAllowed('open-external', 1, { gestures: g, untrusted: false })).toBe(false)
  })
  test('mouse moves and wheel are not an act', () => {
    const { g } = tracker()
    g.noteInput(1, 'mouseMove')
    g.noteInput(1, 'mouseWheel')
    expect(linkBridgeAllowed('create-task', 1, { gestures: g, untrusted: false })).toBe(false)
  })
  test('an act in ANOTHER tab does not count', () => {
    const { g } = tracker()
    g.noteInput(2, 'mouseDown')
    expect(linkBridgeAllowed('create-task', 1, { gestures: g, untrusted: false })).toBe(false)
  })
  test('a stale act does not count', () => {
    const { g, advance } = tracker()
    g.noteInput(1, 'mouseDown')
    advance(GESTURE_WINDOW_MS + 1)
    expect(linkBridgeAllowed('create-task', 1, { gestures: g, untrusted: false })).toBe(false)
  })
})

describe('a user act allows one call', () => {
  test('click, then one call; a second call needs a new act', () => {
    const { g } = tracker()
    g.noteInput(1, 'mouseDown')
    expect(linkBridgeAllowed('open-external', 1, { gestures: g, untrusted: false })).toBe(true)
    expect(linkBridgeAllowed('open-external', 1, { gestures: g, untrusted: false })).toBe(false)
    g.noteInput(1, 'keyDown')
    expect(linkBridgeAllowed('create-task', 1, { gestures: g, untrusted: false })).toBe(true)
  })
})

describe('the system browser only from the user’s own tab', () => {
  test('an untrusted tab never opens externally, act or not — and keeps its act', () => {
    const { g } = tracker()
    g.noteInput(1, 'mouseDown')
    expect(linkBridgeAllowed('open-external', 1, { gestures: g, untrusted: true })).toBe(false)
    // Making a task from the link stays the user's choice there.
    expect(linkBridgeAllowed('create-task', 1, { gestures: g, untrusted: true })).toBe(true)
  })
})
