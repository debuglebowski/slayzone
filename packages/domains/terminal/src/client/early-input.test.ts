/**
 * Keys typed between "open a new terminal" and that terminal existing (early-input.ts).
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/early-input.test.ts
 */
import { createEarlyInputCapture, keyToTerminalData } from './early-input'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
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
  ok(keyToTerminalData(key('a')) === 'a', 'printable')
  ok(keyToTerminalData(key('A')) === 'A', 'shifted printable')
  ok(keyToTerminalData(key(' ')) === ' ', 'space')
  ok(keyToTerminalData(key('Enter')) === '\r', 'enter')
  ok(keyToTerminalData(key('Backspace')) === '\x7f', 'backspace')
  ok(keyToTerminalData(key('Tab')) === '\t', 'tab')
  ok(keyToTerminalData(key('Escape')) === '\x1b', 'escape')
  ok(keyToTerminalData(key('ArrowLeft')) === '\x1b[D', 'arrow')
  ok(keyToTerminalData(key('c', { ctrlKey: true })) === '\x03', 'ctrl+c')
})

test('leaves app shortcuts and unknown keys alone', () => {
  ok(keyToTerminalData(key('n', { metaKey: true })) === null, 'cmd shortcut')
  ok(keyToTerminalData(key('Shift')) === null, 'bare modifier')
  ok(keyToTerminalData(key('F5')) === null, 'unmapped key')
  ok(keyToTerminalData({ ...key('a'), isComposing: true }) === null, 'IME composition')
})

test('captured keys go to the session the capture is bound to, once', () => {
  const now = 0
  const cap = createEarlyInputCapture({ now: () => now, ttlMs: 3000 })
  const c = cap.start()
  ok(cap.onKey(key('h')) && cap.onKey(key('i')), 'consumed while capturing')
  c.bind('s1')
  ok(cap.take('s2') === '', 'another session gets nothing')
  ok(cap.capturing(), 'capturing until taken')
  ok(cap.take('s1') === 'hi', 'bound session gets the keys')
  ok(!cap.capturing(), 'not capturing once taken')
  ok(cap.take('s1') === '', 'taken once')
  ok(!cap.onKey(key('x')), 'capture stopped after take')
})

test('keys keep buffering after bind until the terminal takes them', () => {
  const cap = createEarlyInputCapture({ now: () => 0, ttlMs: 3000 })
  const c = cap.start()
  cap.onKey(key('a'))
  c.bind('s1')
  cap.onKey(key('b'))
  ok(cap.take('s1') === 'ab', 'both halves delivered')
})

test('an expired or cancelled capture delivers nothing and stops capturing', () => {
  let now = 0
  const cap = createEarlyInputCapture({ now: () => now, ttlMs: 3000 })
  const c = cap.start()
  cap.onKey(key('a'))
  c.bind('s1')
  now = 3001
  ok(!cap.onKey(key('b')), 'expired: not captured')
  ok(cap.take('s1') === '', 'expired: nothing delivered')
  const c2 = cap.start()
  cap.onKey(key('z'))
  c2.cancel()
  ok(!cap.onKey(key('y')), 'cancelled: not captured')
})

test('a new capture replaces an older one', () => {
  const cap = createEarlyInputCapture({ now: () => 0, ttlMs: 3000 })
  const c1 = cap.start()
  cap.onKey(key('a'))
  c1.bind('s1')
  const c2 = cap.start()
  cap.onKey(key('b'))
  c2.bind('s2')
  ok(cap.take('s1') === '', 'older capture dropped')
  ok(cap.take('s2') === 'b', 'newer capture delivered')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
