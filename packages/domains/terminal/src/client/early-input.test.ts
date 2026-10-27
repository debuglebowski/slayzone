/**
 * Keys typed between "open a new terminal" and that terminal existing (early-input.ts).
 */
import { expect, test } from 'vitest'
import { createEarlyInputCapture, keyToTerminalData } from './early-input'

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...mods
})

test('maps the keys a terminal would send', () => {
  expect(keyToTerminalData(key('a')), 'printable').toBe('a')
  expect(keyToTerminalData(key('A')), 'shifted printable').toBe('A')
  expect(keyToTerminalData(key(' ')), 'space').toBe(' ')
  expect(keyToTerminalData(key('Enter')), 'enter').toBe('\r')
  expect(keyToTerminalData(key('Backspace')), 'backspace').toBe('\x7f')
  expect(keyToTerminalData(key('Tab')), 'tab').toBe('\t')
  expect(keyToTerminalData(key('Escape')), 'escape').toBe('\x1b')
  expect(keyToTerminalData(key('ArrowLeft')), 'arrow').toBe('\x1b[D')
  expect(keyToTerminalData(key('c', { ctrlKey: true })), 'ctrl+c').toBe('\x03')
})

test('leaves app shortcuts and unknown keys alone', () => {
  expect(keyToTerminalData(key('n', { metaKey: true })), 'cmd shortcut').toBe(null)
  expect(keyToTerminalData(key('Shift')), 'bare modifier').toBe(null)
  expect(keyToTerminalData(key('F5')), 'unmapped key').toBe(null)
  expect(keyToTerminalData({ ...key('a'), isComposing: true }), 'IME composition').toBe(null)
})

test('captured keys go to the session the capture is bound to, once', () => {
  const now = 0
  const cap = createEarlyInputCapture({ now: () => now, ttlMs: 3000 })
  const c = cap.start()
  expect(cap.onKey(key('h')), 'consumed while capturing').toBe(true)
  expect(cap.onKey(key('i')), 'consumed while capturing').toBe(true)
  c.bind('s1')
  expect(cap.take('s2'), 'another session gets nothing').toBe('')
  expect(cap.capturing(), 'capturing until taken').toBe(true)
  expect(cap.take('s1'), 'bound session gets the keys').toBe('hi')
  expect(cap.capturing(), 'not capturing once taken').toBe(false)
  expect(cap.take('s1'), 'taken once').toBe('')
  expect(cap.onKey(key('x')), 'capture stopped after take').toBe(false)
})

test('keys keep buffering after bind until the terminal takes them', () => {
  const cap = createEarlyInputCapture({ now: () => 0, ttlMs: 3000 })
  const c = cap.start()
  cap.onKey(key('a'))
  c.bind('s1')
  cap.onKey(key('b'))
  expect(cap.take('s1'), 'both halves delivered').toBe('ab')
})

test('an expired or cancelled capture delivers nothing and stops capturing', () => {
  let now = 0
  const cap = createEarlyInputCapture({ now: () => now, ttlMs: 3000 })
  const c = cap.start()
  cap.onKey(key('a'))
  c.bind('s1')
  now = 3001
  expect(cap.onKey(key('b')), 'expired: not captured').toBe(false)
  expect(cap.take('s1'), 'expired: nothing delivered').toBe('')
  const c2 = cap.start()
  cap.onKey(key('z'))
  c2.cancel()
  expect(cap.onKey(key('y')), 'cancelled: not captured').toBe(false)
})

test('a new capture replaces an older one', () => {
  const cap = createEarlyInputCapture({ now: () => 0, ttlMs: 3000 })
  const c1 = cap.start()
  cap.onKey(key('a'))
  c1.bind('s1')
  const c2 = cap.start()
  cap.onKey(key('b'))
  c2.bind('s2')
  expect(cap.take('s1'), 'older capture dropped').toBe('')
  expect(cap.take('s2'), 'newer capture delivered').toBe('b')
})
