/**
 * The hub's conversation healer only FORWARDS (robustness plan §9, P0): the heal is
 * decided on the agent's computer (`ledger` op `healConversation`; its decisions
 * are tested in chat-runtime/server/conversation-heal.test.ts against real
 * transcripts). Here: what the hub sends, what it records, and that every failure
 * keeps the stored id — never fresh.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ConversationHealer, ConversationResolver } from '@slayzone/terminal/server'

const state = vi.hoisted(() => ({
  healer: null as unknown as ConversationHealer,
  resolver: null as unknown as ConversationResolver,
  current: null as string | null,
  calls: [] as Array<{ computerId: string; op: string; args: unknown }>,
  answer: null as unknown,
  fail: false,
  diagnostics: [] as Array<{ event: string; message: string }>,
  notified: [] as unknown[]
}))

vi.mock('@slayzone/terminal/hub', async (importOriginal) => {
  const real = await importOriginal<typeof import('@slayzone/terminal/server')>()
  return {
    ...real,
    setConversationHealer: (fn: ConversationHealer) => {
      state.healer = fn
    },
    setConversationResolver: (fn: ConversationResolver) => {
      state.resolver = fn
    }
  }
})
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: (e: { event: string; message: string }) => state.diagnostics.push(e)
}))
vi.mock('./ops/index.js', () => ({
  getTaskOp: async (_db: unknown, id: string) =>
    id === 'gone' ? null : { id, created_at: '2026-10-01 00:00:00' },
  taskSessionLedger: () => ({
    store: {
      getCurrentConversationId: async () => {
        if (state.fail) throw new Error('Computer is offline')
        return state.current
      }
    },
    listResumeCandidates: async () => [],
    call: async (computerId: string, op: string, args: unknown) => {
      state.calls.push({ computerId, op, args })
      if (state.fail) throw new Error('Computer is offline')
      return state.answer
    }
  })
}))

const { registerConversationHealer, registerConversationResolver } = await import(
  './conversation-healer'
)
registerConversationHealer({} as SlayzoneDb, (change) => state.notified.push(change))
registerConversationResolver()

beforeEach(() => {
  state.calls = []
  state.answer = { id: 'S', healed: false }
  state.fail = false
  state.current = null
  state.diagnostics = []
  state.notified = []
})

const heal = (over: Record<string, unknown> = {}) =>
  state.healer({
    taskId: 't1',
    mode: 'claude-code',
    tabId: 'deploy',
    cwd: '/repo',
    storedId: 'S',
    computerId: 'pc',
    projectId: 'p1',
    ...over
  })

describe('hub conversation healer: a forwarder', () => {
  test('asks the computer, with the tab, folder, project and task creation time', async () => {
    expect(await heal()).toEqual({ id: 'S', healed: false })
    expect(state.calls).toEqual([
      {
        computerId: 'pc',
        op: 'healConversation',
        args: {
          taskId: 't1',
          mode: 'claude-code',
          tabId: 'deploy',
          cwd: '/repo',
          projectId: 'p1',
          storedId: 'S',
          taskCreatedAtMs: Date.parse('2026-10-01T00:00:00Z')
        }
      }
    ])
  })

  test('a repoint: returned, its diagnostic recorded, the task row refreshed', async () => {
    state.answer = {
      id: 'SIB',
      healed: true,
      diagnostic: { event: 'conv_id.heal', message: 'S -> SIB', payload: { via: 'history' } }
    }
    expect(await heal()).toEqual({ id: 'SIB', healed: true })
    expect(state.diagnostics).toEqual([expect.objectContaining({ event: 'conv_id.heal' })])
    expect(state.notified).toEqual([{ taskIds: ['t1'] }])
  })

  test('fresh is passed through', async () => {
    state.answer = { id: 'S', healed: false, fresh: true }
    expect(await heal()).toEqual({ id: 'S', healed: false, fresh: true })
    expect(state.notified).toEqual([])
  })

  test('the computer cannot answer: keep the stored id, never fresh', async () => {
    state.fail = true
    expect(await heal()).toEqual({ id: 'S', healed: false })
  })

  test('nothing to ask: no computer, another mode, a task that is gone', async () => {
    expect(await heal({ computerId: null })).toEqual({ id: 'S', healed: false })
    expect(await heal({ mode: 'codex' })).toEqual({ id: 'S', healed: false })
    expect(await heal({ taskId: 'gone' })).toEqual({ id: 'S', healed: false })
    expect(state.calls).toEqual([])
  })
})

// S2: the session ledger lives on the agent's computer. A read that fails there is
// NOT "no session": answering null made createPty mint a fresh session over the real
// one. The failure reaches createPty, which refuses the start visibly.
describe('hub conversation resolver', () => {
  const resolve = (over: Record<string, unknown> = {}) =>
    state.resolver({ computerId: 'pc', taskId: 't1', mode: 'claude-code', tabId: 't1', ...over })

  test("answers the ledger's current conversation, or null when it has none", async () => {
    state.current = 'REAL'
    expect(await resolve()).toBe('REAL')
    state.current = null
    expect(await resolve()).toBeNull()
  })

  test('a ledger read that fails is an error, never "no session"', async () => {
    state.fail = true
    await expect(resolve()).rejects.toThrow(/session history|Computer is offline/)
  })

  test('no computer: nothing to resume', async () => {
    expect(await resolve({ computerId: null })).toBeNull()
  })
})
