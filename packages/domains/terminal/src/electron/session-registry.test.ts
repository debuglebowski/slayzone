/**
 * Tests for session-registry merge logic.
 * Run with: pnpm dlx tsx packages/domains/terminal/src/main/session-registry.test.ts
 *
 * Tests the pure `mergeSessions` helper. The IPC-facing `listSessions` /
 * `getSessionState` are thin wrappers around it + electron-bound modules,
 * exercised end-to-end via manual reload verification.
 */
import { mergeSessions } from '../server/session-merge'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      const a = JSON.stringify(actual)
      const b = JSON.stringify(expected)
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`)
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    },
  }
}

console.log('\nSessionRegistry tests\n')

test('mergeSessions: tags PTY entries with kind:"pty"', () => {
  const out = mergeSessions({
    ptys: [{ sessionId: 'task-1', state: 'idle' }],
    chats: [],
  })
  expect(out).toEqual([{ sessionId: 'task-1', state: 'idle', kind: 'pty' }])
})

test('mergeSessions: tags chat entries with kind:"chat"', () => {
  const out = mergeSessions({
    ptys: [],
    chats: [{ sessionId: 'task-1:tab-A', state: 'idle' }],
  })
  expect(out).toEqual([{ sessionId: 'task-1:tab-A', state: 'idle', kind: 'chat' }])
})

test('mergeSessions: merges both, PTY first', () => {
  const out = mergeSessions({
    ptys: [{ sessionId: 'task-pty', state: 'running' }],
    chats: [{ sessionId: 'task-chat:tab-A', state: 'idle' }],
  })
  expect(out.length).toBe(2)
  expect(out[0].kind).toBe('pty')
  expect(out[1].kind).toBe('chat')
})

test('mergeSessions: drops chat dup on collision, keeps PTY', () => {
  const warns: string[] = []
  const origWarn = console.warn
  console.warn = (msg: string) => warns.push(msg)
  try {
    const out = mergeSessions({
      ptys: [{ sessionId: 'task-1:tab-A', state: 'running' }],
      chats: [{ sessionId: 'task-1:tab-A', state: 'idle' }],
    })
    expect(out.length).toBe(1)
    expect(out[0].kind).toBe('pty')
    expect(out[0].state).toBe('running')
    expect(warns.length).toBe(1)
    expect(warns[0].includes('collision')).toBeTruthy()
  } finally {
    console.warn = origWarn
  }
})

test('mergeSessions: empty inputs → empty output', () => {
  const out = mergeSessions({ ptys: [], chats: [] })
  expect(out.length).toBe(0)
})

test('mergeSessions: preserves all chat states unchanged', () => {
  const states = ['starting', 'running', 'idle', 'error', 'dead'] as const
  for (const s of states) {
    const out = mergeSessions({
      ptys: [],
      chats: [{ sessionId: `t:${s}`, state: s }],
    })
    expect(out[0].state).toBe(s)
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
