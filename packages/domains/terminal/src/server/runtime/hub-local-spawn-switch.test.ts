/**
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` covers terminals and agents on the hub itself
 * (T-06 revision): the in-process pty and chat backends refuse — the local pty one is
 * the default until the composition root installs the routing backend — while a
 * session routed to a computer still spawns. One `hub.process.spawn` audit line per
 * refused spawn, also through createPty's shell-fallback retry. No real shell spawns.
 */
import { afterAll, expect, test } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync, type ChildProcess } from 'node:child_process'
import type { SlayzoneDb } from '@slayzone/platform'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import type { PtySessionWindow } from '../pty-host'
import { createPty, killPty, setDatabase, testExecutionContext } from './pty-manager'
import { localPtyBackend, setPtyBackend, type PtyBackend } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import { childProcessToHandle, createLocalChatBackend } from './chat-proc-handle'
import * as chat from './chat-transport-manager'

async function refused(fn: () => unknown): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}
function childPids(): number {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean).length
  } catch {
    return 0
  }
}

const lines: Array<{ event: string; outcome: string; detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as PtySessionWindow
setDatabase(
  {
    get: async () => ({ project_id: 'proj-1' }),
    all: async () => [],
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
  } as unknown as SlayzoneDb,
  createFakeTaskSessionStore()
)

function fakePty() {
  return {
    pid: 4242,
    process: 'zsh',
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: () => undefined,
    kill: () => undefined,
    resize: () => undefined
  }
}
function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // A real stream: the chat driver waits for its first write to be flushed.
    stdin: new PassThrough(),
    pid: 99999,
    kill: () => true
  }) as unknown as ChildProcess
}

process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'

test('localPtyBackend.spawn: refused, no pty started, one audit line', async () => {
  const before = lines.length
  const kids = childPids()
  const err = await refused(() =>
    localPtyBackend.spawn({
      sessionId: 's1:s1',
      taskId: 's1',
      computerId: null,
      projectId: null,
      file: '/bin/sh',
      args: [],
      options: { cwd: '/tmp', env: {}, cols: 80, rows: 24, name: 'xterm' },
      transport: false
    })
  )
  expect(isHubSwitchedOffError(err), `expected a switch refusal, got ${err}`).toBeTruthy()
  expect(childPids(), 'no child process').toBe(kids)
  expect(lines.length, `one audit line, got ${lines.length - before}`).toBe(before + 1)
  expect(lines[before].event, 'event hub.process.spawn').toBe('hub.process.spawn')
  expect(lines[before].detail.op, 'op pty.spawn').toBe('pty.spawn')
})

test('createPty, hub-local (no computer): refused to the caller, audited once', async () => {
  setPtyBackend(null) // the default local backend, as before the gateway is installed
  const before = lines.length
  const err = await refused(() =>
    createPty({ win: fakeWin, sessionId: 'local:local', cwd: '/tmp', mode: 'terminal' } as never)
  )
  expect(isHubSwitchedOffError(err), `createPty must rethrow the refusal, got ${err}`).toBeTruthy()
  expect(lines.length, `no second line from the -l retry, got ${lines.length - before}`).toBe(
    before + 1
  )
})

test('createPty routed to a computer: still spawns', async () => {
  let routed = 0
  setPtyBackend({
    spawn: async (spec) => {
      routed++
      expect(spec.computerId, 'routed with its computer id').toBe('computer-1')
      return fakePty() as never
    }
  } as PtyBackend)
  const before = lines.length
  const res = await createPty({
    win: fakeWin,
    sessionId: 'routed:routed',
    cwd: '/tmp',
    mode: 'terminal',
    computerId: 'computer-1'
  } as never)
  expect(res.success, `routed spawn succeeds: ${JSON.stringify(res)}`).toBe(true)
  expect(routed, 'routing backend spawned it').toBe(1)
  expect(lines.length, 'nothing refused').toBe(before)
  killPty('routed:routed')
  setPtyBackend(null)
})

test('createLocalChatBackend: refused before resolving a binary', async () => {
  let whichCalls = 0
  const backend = createLocalChatBackend({
    whichBinary: async () => {
      whichCalls++
      return '/bin/echo'
    },
    spawn: (() => fakeChild()) as never
  })
  const err = await refused(() =>
    backend.spawn({
      sessionId: 't:c',
      taskId: 't',
      computerId: null,
      binaryName: 'claude',
      args: [],
      cwd: '/tmp',
      env: {}
    })
  )
  expect(isHubSwitchedOffError(err), 'refused').toBeTruthy()
  expect(whichCalls, 'no login shell for whichBinary').toBe(0)
  expect(lines[lines.length - 1].detail.op, 'op chat.spawn').toBe('chat.spawn')
})

test('chat transport, in-process path: refused before whichBinary/spawn', async () => {
  chat.__resetForTests()
  let whichCalls = 0
  let spawnCalls = 0
  chat.setTransportDepsForTests({
    whichBinary: async () => {
      whichCalls++
      return '/fake/claude'
    },
    spawn: (() => {
      spawnCalls++
      return fakeChild()
    }) as never,
    broadcastEvent: () => undefined,
    broadcastExit: () => undefined
  })
  await chat.hydrateSession({
    tabId: 'chat-local',
    taskId: 'task-c',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  const err = await refused(() => chat.ensureSpawned('chat-local'))
  expect(isHubSwitchedOffError(err), `refused, got ${err}`).toBeTruthy()
  expect(whichCalls, 'nothing resolved or spawned').toBe(0)
  expect(spawnCalls, 'nothing resolved or spawned').toBe(0)
})

test('chat transport, routed backend: still spawns', async () => {
  chat.__resetForTests()
  let routed = 0
  chat.setTransportDepsForTests({
    backend: {
      spawn: async () => {
        routed++
        const child = fakeChild()
        // A real child reports `spawn` once started; ensureSpawned waits for it.
        setImmediate(() => (child as unknown as { emit(e: string): void }).emit('spawn'))
        return childProcessToHandle(child)
      }
    },
    broadcastEvent: () => undefined,
    broadcastExit: () => undefined
  })
  await chat.hydrateSession({
    tabId: 'chat-routed',
    taskId: 'task-r',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  await chat.ensureSpawned('chat-routed')
  expect(routed, 'routed backend spawned the agent').toBe(1)
  chat.__resetForTests()
  chat.resetTransportDeps()
})

test('testExecutionContext: docker/ssh probe refused, host answers', async () => {
  const err = await refused(() =>
    testExecutionContext({ type: 'docker', container: 'c1' } as never)
  )
  expect(isHubSwitchedOffError(err), 'docker probe refused').toBeTruthy()
  const host = await testExecutionContext({ type: 'host' } as never)
  expect(host.success, 'host needs no process').toBe(true)
})

afterAll(() => {
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
  setSecurityLogSink()
})
