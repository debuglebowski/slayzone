/**
 * Chat A (plan 3.6 / 3.10): a tab switches conversations — the Sessions picker,
 * "Continue in chat" from the terminal. One write path: the old process stops
 * (its exit awaited) before anything else, a `switched` marker and the imported
 * history go into the tab's log, and the next process resumes the new id.
 * Imported history is the past: it never drives the state machine, is never
 * re-sent, never failed on a restart, never taken back by Stop.
 */
import { afterEach, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'
import { emitLine, sj, startTab, TAB_OPTS, transportHarness, until } from './chat-transport-testkit'

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

const X = '11111111-2222-4333-8444-555555555555'
const branch: AgentEvent = {
  kind: 'conversation-branch',
  reason: 'switched',
  conversationId: X,
  source: 'sessions'
}
const history: AgentEvent[] = [
  { kind: 'user-message', id: 'h1', text: 'from before', history: true },
  { kind: 'tool-call', id: 'tu1', name: 'Bash', input: {} },
  { kind: 'tool-result', toolUseId: 'tu1', isError: false, rawContent: 'ok', structured: null },
  { kind: 'assistant-text', messageId: 'm1', text: 'old answer' }
]

test('a live tab: the old process is stopped and gone before the new one resumes the conversation', async () => {
  const order: string[] = []
  const h = transportHarness({
    onSpawn: (args) => {
      const at = args.indexOf('--resume')
      order.push(`spawn ${at >= 0 ? args[at + 1] : 'fresh'}`)
    },
    onFake: (f, i) => {
      if (i === 0) f.emitter.on('exit', () => order.push('old exited'))
    }
  })
  await startTab()
  order.length = 0

  await mgr.switchTabConversation(TAB_OPTS.tabId, {
    conversationId: X,
    branch,
    history,
    notices: [],
    respawnOpts: { ...TAB_OPTS, conversationId: X }
  })

  expect(order).toEqual(['old exited', `spawn ${X}`])
  expect(mgr.getSessionInfo(TAB_OPTS.tabId)?.sessionId).toBe(X)
  const kinds = h.savedKinds()
  expect(kinds.slice(kinds.indexOf('conversation-branch'))).toEqual([
    'conversation-branch',
    'user-message',
    'tool-call',
    'tool-result',
    'assistant-text'
  ])
  // The past never ran a turn here.
  expect(h.states).not.toContain('running')
})

test('a tab with no process stays lazy; the first message resumes the conversation', async () => {
  const h = transportHarness()
  await mgr.hydrateSession({ ...TAB_OPTS })

  await mgr.switchTabConversation(TAB_OPTS.tabId, {
    conversationId: X,
    branch,
    history,
    notices: []
  })
  expect(h.fakes).toHaveLength(0)

  mgr.dispatchUserMessage(TAB_OPTS.tabId, { id: 'n1', content: [{ type: 'text', text: 'next' }] })
  await until(() => h.fakes.length === 1)
  await until(() => h.fakes[0].stdin.some((m) => m.uuid === 'n1'))
  // The past is not sent again.
  expect(h.fakes[0].stdin.filter((m) => m.type === 'user').map((m) => m.uuid)).toEqual(['n1'])
})

test('after a restart, imported history is neither failed nor an unfinished turn', async () => {
  const saved = [{ seq: 0, event: branch }, ...history.map((event, i) => ({ seq: i + 1, event }))]
  const h = transportHarness({ history: saved })
  await mgr.hydrateSession({ ...TAB_OPTS })
  expect(h.savedKinds()).not.toContain('user-message-delivery')
  expect(h.savedKinds()).not.toContain('interrupted')
})

test('Stop never takes an imported message back', async () => {
  const saved = [{ seq: 0, event: history[0] }]
  const h = transportHarness({ history: saved })
  await startTab()
  const f = h.fakes[0]
  f.answer('interrupt', () => {
    setImmediate(() => emitLine(f, sj.aborted()))
    return { success: { still_queued: [] } }
  })
  const result = await mgr.stopTurn(TAB_OPTS.tabId, {
    restorePrompt: true,
    respawnOpts: async () => ({ ...TAB_OPTS })
  })
  expect(result.popped).toBe(false)
})

test('releasing a conversation stops the chat process running it, and waits for its exit', async () => {
  const h = transportHarness()
  await startTab({ conversationId: X })
  let exited = false
  h.fakes[0].emitter.on('exit', () => {
    exited = true
  })
  await mgr.releaseChatConversation('task', X)
  expect(exited).toBe(true)
  expect(mgr.getSessionInfo(TAB_OPTS.tabId)).toBeNull()
  // Another task's or another conversation's chat is left alone.
  await mgr.releaseChatConversation('task', '99999999-2222-4333-8444-555555555555')
})
