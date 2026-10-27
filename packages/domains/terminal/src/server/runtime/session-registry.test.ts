/**
 * Tests for session-registry merge logic.
 *
 * Tests the pure `mergeSessions` helper. The IPC-facing `listSessions` /
 * `getSessionState` are thin wrappers around it + electron-bound modules,
 * exercised end-to-end via manual reload verification.
 */
import { expect, test } from 'vitest'
import { mergeSessions } from '../session-merge'

test('mergeSessions: tags PTY entries with kind:"pty"', () => {
  const out = mergeSessions({
    ptys: [{ sessionId: 'task-1', state: 'idle' }],
    chats: []
  })
  expect(out).toEqual([{ sessionId: 'task-1', state: 'idle', kind: 'pty' }])
})

test('mergeSessions: tags chat entries with kind:"chat"', () => {
  const out = mergeSessions({
    ptys: [],
    chats: [{ sessionId: 'task-1:tab-A', state: 'idle' }]
  })
  expect(out).toEqual([{ sessionId: 'task-1:tab-A', state: 'idle', kind: 'chat' }])
})

test('mergeSessions: merges both, PTY first', () => {
  const out = mergeSessions({
    ptys: [{ sessionId: 'task-pty', state: 'running' }],
    chats: [{ sessionId: 'task-chat:tab-A', state: 'idle' }]
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
      chats: [{ sessionId: 'task-1:tab-A', state: 'idle' }]
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
      chats: [{ sessionId: `t:${s}`, state: s }]
    })
    expect(out[0].state).toBe(s)
  }
})
