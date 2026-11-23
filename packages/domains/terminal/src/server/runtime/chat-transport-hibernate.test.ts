import { afterEach, expect, test, vi } from 'vitest'
import * as chat from './chat-transport-manager'
import { childProcessToHandle } from './chat-proc-handle'
import {
  emitLine,
  fakeChild,
  sendAndStart,
  sj,
  startTab,
  TAB_OPTS,
  transportHarness,
  wait
} from './chat-transport-testkit'

const tab = TAB_OPTS.tabId
const inventory = chat.defaultChatTransport.hibernationInventory

afterEach(() => {
  chat.__resetForTests()
  chat.resetTransportDeps()
  chat.setAgentStateTabRecorder(null)
})

async function confirmedChat(opts: Parameters<typeof transportHarness>[0] = {}) {
  let sessionId = ''
  const host = transportHarness({
    ...opts,
    onSpawn: (args) => {
      if (!sessionId) sessionId = args[args.indexOf('--session-id') + 1]
      opts.onSpawn?.(args)
    }
  })
  await startTab()
  emitLine(host.fakes[0], sj.init(sessionId))
  await chat.__flushEventsForTests(tab)
  return host
}

test('hibernation keeps history, ignores background restore, and resumes on send', async () => {
  const argv: string[][] = []
  const host = await confirmedChat({ onSpawn: (args) => argv.push(args) })
  const recorded: string[] = []
  chat.setAgentStateTabRecorder((_id, state) => recorded.push(state))
  const [candidate] = inventory().candidates
  expect(await candidate.hibernate(async () => true)).toBe(true)
  expect(inventory()).toEqual({ hibernated: 1, candidates: [] })
  expect(host.states.at(-1)).toBe('hibernated')
  expect(host.savedKinds()).not.toContain('process-exit')
  expect(await chat.ensureSpawned(tab, { prioritize: false })).toMatchObject({ hibernated: true })
  expect(argv).toHaveLength(1)

  await chat.dispatchUserMessage(tab, {
    id: 'after-sleep',
    content: [{ type: 'text', text: 'Continue' }]
  })
  await expect.poll(() => argv.length).toBe(2)
  expect(argv[1]).toEqual(
    expect.arrayContaining(['--resume', argv[0][argv[0].indexOf('--session-id') + 1]])
  )
  await expect.poll(() => recorded).toEqual(['auto_stopped', 'running'])
  expect((await chat.readEventsSince(tab, -1)).map(({ event }) => event.kind)).toContain(
    'turn-init'
  )
})

test('a turn and an unanswered prompt both veto a stale hibernation candidate', async () => {
  const host = await confirmedChat()
  const [candidate] = inventory().candidates
  expect(await candidate.hibernate(async () => false)).toBe(false)
  await sendAndStart(host.fakes[0], 'working')
  expect(await candidate.hibernate(async () => true)).toBe(false)
  expect(inventory().candidates).toEqual([])

  emitLine(host.fakes[0], sj.toolUse('tool-1'))
  emitLine(host.fakes[0], sj.canUseTool('prompt-1', 'tool-1'))
  await chat.__flushEventsForTests(tab)
  expect(chat.getTurnStatus(tab)?.pendingRequestIds).toEqual(['prompt-1'])
  expect(inventory().candidates).toEqual([])
})

test('an agent can wait in admission beyond the startup watchdog and receive a priority bump', async () => {
  const child = fakeChild({ exitOnKill: true })
  const prioritize = vi.fn()
  const spawn = vi.fn(() => childProcessToHandle(child.child))
  const host = chat.createChatTransport({
    backend: { spawn, prioritize },
    waitsForAdmission: true,
    watchdogTimings: {
      startingBoundMs: 10,
      spawnReplyBoundMs: 10,
      runningStallMs: 1_000,
      killGraceMs: 10
    }
  })
  try {
    await host.hydrateSession({ ...TAB_OPTS, admission: 'background' })
    const restored = host.ensureSpawned(tab, { prioritize: false })
    await expect.poll(() => spawn.mock.calls.length).toBe(1)
    await wait(40)
    expect(host.getSessionTerminalState(tab)).toBe('starting')
    const revealed = host.ensureSpawned(tab, { prioritize: true })
    await expect.poll(() => prioritize.mock.calls).toEqual([['task:tab']])
    child.emitter.emit('spawn')
    await Promise.all([restored, revealed])
    expect(host.getSessionTerminalState(tab)).toBe('idle')
  } finally {
    await host.shutdownAll()
  }
})
