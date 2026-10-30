/**
 * Chat A (plan 3.3): fork from a past message, in the same tab — like the TUI's
 * branch. The CLI copies the conversation up to the end of that message's turn
 * into a NEW conversation (`--resume S --resume-session-at A --fork-session
 * --session-id N`; the original file is only read). The tab runs N from then on,
 * recorded `slay-spawned-fork`; the original stays in Sessions. A fork that the
 * CLI refuses leaves the tab in the original conversation.
 */
import { afterEach, expect, test } from 'vitest'
import type { AgentEvent, ConversationOrigin } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'
import {
  emitLine,
  sj,
  TAB_OPTS,
  transportHarness,
  until,
  wait,
  type FakeChild,
  type TransportHarness
} from './chat-transport-testkit'

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

const respawnOpts = async (): Promise<typeof TAB_OPTS> => ({ ...TAB_OPTS })
const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

interface Setup {
  h: TransportHarness
  spawns: string[][]
  persisted: Array<{ conversationId: string; origin: ConversationOrigin }>
  /** The conversation the first process runs. */
  source: string
}

/** A tab whose agent answered two messages: m1 → a1 (tool call, then text), m2 → a2. */
async function twoTurns(opts: { onFake?: (f: FakeChild, i: number) => void } = {}): Promise<Setup> {
  const spawns: string[][] = []
  const persisted: Setup['persisted'] = []
  const h = transportHarness({ onSpawn: (args) => spawns.push(args), onFake: opts.onFake })
  await mgr.hydrateSession({ ...TAB_OPTS, onPersistSessionId: (p) => persisted.push(p) })
  await mgr.ensureSpawned(TAB_OPTS.tabId)
  const source = mgr.getSessionInfo(TAB_OPTS.tabId)!.sessionId
  const f = h.fakes[0]
  await turn(
    f,
    'm1',
    [
      { ...sj.toolUse('tu1'), uuid: 'a1-tool' },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        parent_tool_use_id: null
      },
      // A sub-agent's message: not the main chain, never a fork point.
      { ...sj.text('from a sub-agent', { uuid: 'sub-1' }), parent_tool_use_id: 'tu1' },
      sj.text('first answer', { id: 'msg_a1', uuid: 'a1' })
    ],
    source
  )
  await turn(f, 'm2', [sj.text('second answer', { id: 'msg_a2', uuid: 'a2' })], source)
  return { h, spawns, persisted, source }
}

async function turn(f: FakeChild, id: string, lines: unknown[], sessionId: string): Promise<void> {
  mgr.dispatchUserMessage(TAB_OPTS.tabId, { id, content: [{ type: 'text', text: id }] })
  await until(() => f.stdin.some((m) => m.type === 'user' && m.uuid === id))
  emitLine(f, sj.lifecycle(id, 'queued'))
  emitLine(f, sj.lifecycle(id, 'started'))
  emitLine(f, sj.init(sessionId))
  for (const line of lines) emitLine(f, line)
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle(id, 'completed'))
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
  await wait(10)
}

test('forks at the end of the message turn: old process gone, new conversation spawned from the original', async () => {
  const s = await twoTurns()
  const order: string[] = []
  s.h.fakes[0].emitter.on('exit', () => order.push('old exited'))

  const result = await mgr.forkTab(TAB_OPTS.tabId, { messageId: 'm1', respawnOpts })
  order.push('forked')

  expect(order).toEqual(['old exited', 'forked'])
  const args = s.spawns[1]
  expect(flag(args, '--resume')).toBe(s.source)
  // The turn's last main-chain assistant record: not the sub-agent's.
  expect(flag(args, '--resume-session-at')).toBe('a1')
  expect(args).toContain('--fork-session')
  const forkId = flag(args, '--session-id')!
  expect(forkId).not.toBe(s.source)
  expect(result).toEqual({ conversationId: forkId, fromConversationId: s.source })
  expect(mgr.getSessionInfo(TAB_OPTS.tabId)?.sessionId).toBe(forkId)
  expect(s.h.saved().filter((e) => e.kind === 'conversation-branch')).toEqual([
    {
      kind: 'conversation-branch',
      reason: 'forked',
      messageId: 'm1',
      conversationId: forkId,
      fromConversationId: s.source,
      atMessageUuid: 'a1'
    }
  ])
})

test('the fork is recorded slay-spawned-fork once the CLI confirms it; later spawns just resume it', async () => {
  const s = await twoTurns()
  const { conversationId: forkId } = await mgr.forkTab(TAB_OPTS.tabId, {
    messageId: 'm1',
    respawnOpts
  })
  const f = s.h.fakes[1]
  await turn(f, 'm3', [sj.text('in the fork', { uuid: 'a3' })], forkId)
  expect(s.persisted.at(-1)).toEqual({ conversationId: forkId, origin: 'slay-spawned-fork' })

  await mgr.respawn(TAB_OPTS.tabId, { ...TAB_OPTS })
  const again = s.spawns[2]
  expect(flag(again, '--resume')).toBe(forkId)
  expect(again).not.toContain('--fork-session')
  expect(again).not.toContain('--resume-session-at')
})

test('a running turn is stopped first', async () => {
  const s = await twoTurns()
  const f = s.h.fakes[0]
  f.answer('interrupt', () => {
    setImmediate(() => emitLine(f, sj.aborted()))
    return { success: { still_queued: [] } }
  })
  mgr.dispatchUserMessage(TAB_OPTS.tabId, { id: 'm3', content: [{ type: 'text', text: 'm3' }] })
  await until(() => f.stdin.some((m) => m.uuid === 'm3'))
  emitLine(f, sj.lifecycle('m3', 'queued'))
  emitLine(f, sj.lifecycle('m3', 'started'))
  emitLine(f, sj.text('working…', { uuid: 'a3' }))
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'running')

  await mgr.forkTab(TAB_OPTS.tabId, { messageId: 'm2', respawnOpts })
  expect(f.controlSubtypes()).toContain('interrupt')
  expect(flag(s.spawns[1], '--resume-session-at')).toBe('a2')
})

test('refuses a message without an answer, and one the conversation no longer holds', async () => {
  const s = await twoTurns()
  s.h.fakes[0].answer('rewind_conversation', () => ({ success: { rewound: true } }))
  await mgr.rewindTab(TAB_OPTS.tabId, {
    messageId: 'm2',
    scope: 'before',
    conversation: true,
    files: false,
    respawnOpts
  })
  await expect(mgr.forkTab(TAB_OPTS.tabId, { messageId: 'm2', respawnOpts })).rejects.toThrow(
    /not in the conversation/
  )
  expect(s.h.fakes).toHaveLength(1)
})

test('the CLI refuses the fork: the tab stays in the original conversation, and says so', async () => {
  const s = await twoTurns({
    onFake: (f, i) => {
      // The fork process dies at startup (2.1.312: an unknown --resume-session-at).
      if (i === 1) {
        f.emitter.once('spawn', () =>
          setImmediate(() => {
            f.stderr.write('No message found with message.uuid of: a1\n')
            f.exit(1)
          })
        )
      }
    }
  })
  await mgr.forkTab(TAB_OPTS.tabId, { messageId: 'm1', respawnOpts })
  // Back in the original: a process resumes it (not a fresh start).
  await until(() => s.spawns.length === 3)
  expect(flag(s.spawns[2], '--resume')).toBe(s.source)
  expect(s.spawns[2]).not.toContain('--fork-session')
  expect(mgr.getSessionInfo(TAB_OPTS.tabId)?.sessionId).toBe(s.source)
  const branches = s.h
    .saved()
    .filter(
      (e): e is Extract<AgentEvent, { kind: 'conversation-branch' }> =>
        e.kind === 'conversation-branch'
    )
  expect(branches.map((b) => b.reason)).toEqual(['forked', 'fork-failed'])
  expect(s.h.saved().some((e) => e.kind === 'notice' && e.code === 'fork-failed')).toBe(true)
  // Nothing was recorded for the fork.
  expect(s.persisted.every((p) => p.origin !== 'slay-spawned-fork')).toBe(true)
})

test('after a restart, a fork nobody sent a message in is still the conversation: it forks again', async () => {
  const S = '11111111-2222-4333-8444-555555555555'
  const N = '99999999-2222-4333-8444-555555555555'
  const spawns: string[][] = []
  transportHarness({
    onSpawn: (args) => spawns.push(args),
    history: [
      { seq: 0, event: { kind: 'user-message', id: 'm1', text: 'm1' } },
      { seq: 1, event: { kind: 'assistant-text', messageId: 'msg', text: 'hi', uuid: 'a1' } },
      {
        seq: 2,
        event: {
          kind: 'conversation-branch',
          reason: 'forked',
          messageId: 'm1',
          conversationId: N,
          fromConversationId: S,
          atMessageUuid: 'a1'
        }
      }
    ]
  })
  // The task still names the original: the fork never reached it.
  await mgr.hydrateSession({ ...TAB_OPTS, conversationId: S })
  await mgr.ensureSpawned(TAB_OPTS.tabId)
  expect(flag(spawns[0], '--resume')).toBe(S)
  expect(flag(spawns[0], '--resume-session-at')).toBe('a1')
  expect(flag(spawns[0], '--session-id')).toBe(N)
  expect(spawns[0]).toContain('--fork-session')
})
