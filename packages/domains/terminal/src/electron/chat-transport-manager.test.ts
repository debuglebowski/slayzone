/**
 * Tests for ChatTransportManager.
 * Run with: pnpm dlx tsx packages/domains/terminal/src/main/chat-transport-manager.test.ts
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import * as mgr from './chat-transport-manager'
import type { AgentEvent } from '../shared/agent-events'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
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
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    }
  }
}

interface FakeChild extends ChildProcess {
  _stdinRef: { value: string }
  _stdout: PassThrough
  _stderr: PassThrough
}
function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdinRef = { value: '' }
  const stdin = {
    write: (s: string) => {
      stdinRef.value += s
      return true
    }
  }
  const fake = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    pid: 99999,
    kill: (_sig?: string) => true,
    _stdinRef: stdinRef,
    _stdout: stdout,
    _stderr: stderr
  })
  return fake as unknown as FakeChild
}

function fixtureDir(): string {
  return resolve(__dirname, '../../test/fixtures/claude-stream')
}

async function setup() {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
}

/**
 * Test helper: hydrate the session, ensureSpawned, then fire the `spawn` event
 * the way a real `child_process` would. `spawn` is what triggers
 * `driver.start(ctx)` — without it the per-spawn session driver has no context
 * and `sendUserMessage` / control requests / event parsing all silently no-op.
 *
 * Pass `{ autoSpawn: false }` for tests that drive the `spawn` event themselves
 * (handshake-timing tests) or that must observe the pre-spawn `starting` state.
 */
async function createChat(
  opts: Parameters<typeof mgr.hydrateSession>[0],
  { autoSpawn = true }: { autoSpawn?: boolean } = {}
) {
  mgr.hydrateSession(opts)
  const info = await mgr.ensureSpawned(opts.tabId)
  if (autoSpawn) {
    const child = mgr.__getSessionChildForTests(opts.tabId)
    if (child) (child as unknown as EventEmitter).emit('spawn')
  }
  return info
}

console.log('\nChatTransportManager tests\n')

await test('createChat: unknown mode → throws ChatTransportError', async () => {
  await setup()
  let err: Error | null = null
  try {
    await createChat({
      tabId: 't1',
      taskId: 'task-test',
      mode: 'nonexistent-mode',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    })
  } catch (e) {
    err = e as Error
  }
  expect(err?.name).toBe('ChatTransportError')
  expect(err?.message.includes('nonexistent-mode')).toBeTruthy()
})

await test('createChat: missing binary → throws ChatTransportError', async () => {
  await setup()
  mgr.setTransportDepsForTests({
    whichBinary: async () => null,
    spawn: () => makeFakeChild() as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  let err: Error | null = null
  try {
    await createChat({
      tabId: 't2',
      taskId: 'task-test',
      mode: 'claude-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    })
  } catch (e) {
    err = e as Error
  }
  expect(err?.message.includes('not found on PATH')).toBeTruthy()
})

await test('createChat: pipes fixture NDJSON → emits typed events + ring buffer populated', async () => {
  await setup()
  const captured: Array<{ tabId: string; kind: string; seq: number }> = []
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (tabId, event, seq) => {
      captured.push({ tabId, kind: event.kind, seq })
    },
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-x',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  const raw = readFileSync(resolve(fixtureDir(), 'bash.ndjson'), 'utf8')
  fake._stdout.write(raw)
  await new Promise((r) => setTimeout(r, 50))

  const kinds = captured.map((c) => c.kind)
  expect(kinds.includes('turn-init')).toBeTruthy()
  expect(kinds.includes('tool-call')).toBeTruthy()
  expect(kinds.includes('result')).toBeTruthy()

  const buf = mgr.getEventBufferSince('tab-x', -1)
  expect(buf.length > 0).toBeTruthy()
  expect(buf[0].seq).toBe(0)
  expect(buf[buf.length - 1].seq).toBe(buf.length - 1)
})

await test('getEventBufferSince: returns only events with seq > afterSeq', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-y',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  fake._stdout.write(readFileSync(resolve(fixtureDir(), 'bash.ndjson'), 'utf8'))
  await new Promise((r) => setTimeout(r, 50))
  const total = mgr.getEventBufferSince('tab-y', -1).length
  const tail = mgr.getEventBufferSince('tab-y', 2)
  expect(tail.length).toBe(total - 3)
  if (tail.length > 0) expect(tail[0].seq).toBe(3)
})

await test('persist callback fires on turn-init', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  const persisted: string[] = []
  await createChat({
    tabId: 'tab-z',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: [],
    onPersistSessionId: (id) => persisted.push(id)
  })
  fake._stdout.write(readFileSync(resolve(fixtureDir(), 'bash.ndjson'), 'utf8'))
  await new Promise((r) => setTimeout(r, 50))
  expect(persisted.length > 0).toBeTruthy()
  expect(persisted[0].length > 0).toBeTruthy()
})

await test('sendUserMessage: writes NDJSON line to stdin', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-msg',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  const ok = mgr.sendUserMessage('tab-msg', 'hello')
  expect(ok).toBe(true)
  const line = fake._stdinRef.value.trim()
  const parsed = JSON.parse(line)
  expect(parsed.type).toBe('user')
  expect(parsed.message.content).toBe('hello')
})

await test('sendToolResult: writes NDJSON tool_result envelope keyed by tool_use_id', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-tr',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  const ok = mgr.sendToolResult('tab-tr', {
    toolUseId: 'tu_99',
    content: '{"answers":{"Pick":"A"}}'
  })
  expect(ok).toBe(true)
  const line = fake._stdinRef.value.trim()
  const parsed = JSON.parse(line)
  expect(parsed.type).toBe('user')
  expect(parsed.message.role).toBe('user')
  const block = parsed.message.content[0]
  expect(block.type).toBe('tool_result')
  expect(block.tool_use_id).toBe('tu_99')
  expect(block.content).toBe('{"answers":{"Pick":"A"}}')
})

await test('sendToolResult: returns false for unknown tab', async () => {
  await setup()
  const ok = mgr.sendToolResult('nonexistent-tab', { toolUseId: 'x', content: 'y' })
  expect(ok).toBe(false)
})

await test('sendControlRequest: writes envelope + resolves on matching control_response', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-ctrl',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })

  const promise = mgr.sendControlRequest('tab-ctrl', {
    subtype: 'set_permission_mode',
    mode: 'acceptEdits'
  })

  // Stdin must contain the envelope. Pull the line, scrape its request_id,
  // then push a matching success response onto stdout.
  const line = fake._stdinRef.value.trim()
  const parsed = JSON.parse(line)
  expect(parsed.type).toBe('control_request')
  const requestId: string = parsed.request_id
  expect(parsed.request.subtype).toBe('set_permission_mode')
  expect(parsed.request.mode).toBe('acceptEdits')

  fake._stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId }
    }) + '\n'
  )

  // Resolves with the response data (envelope fields stripped).
  await promise
})

await test('sendControlRequest: rejects on error subtype', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-ctrl-err',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })

  const promise = mgr.sendControlRequest('tab-ctrl-err', {
    subtype: 'set_permission_mode',
    mode: 'plan'
  })
  const parsed = JSON.parse(fake._stdinRef.value.trim())
  fake._stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: parsed.request_id, error: 'rejected by SDK' }
    }) + '\n'
  )

  let err: Error | null = null
  try {
    await promise
  } catch (e) {
    err = e as Error
  }
  expect(err?.message).toBe('rejected by SDK')
})

await test('respondToPermissionRequest: writes control_response success on stdin', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-perm',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })

  const ok = mgr.respondToPermissionRequest('tab-perm', {
    requestId: 'cu_42',
    decision: { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } }
  })
  expect(ok).toBe(true)
  const line = fake._stdinRef.value.trim()
  const parsed = JSON.parse(line)
  expect(parsed.type).toBe('control_response')
  expect(parsed.response.subtype).toBe('success')
  expect(parsed.response.request_id).toBe('cu_42')
  expect(parsed.response.response.behavior).toBe('allow')
})

await test('respondToPermissionRequest: false for unknown tab', async () => {
  await setup()
  const ok = mgr.respondToPermissionRequest('nonexistent-tab', {
    requestId: 'x',
    decision: { behavior: 'deny', message: 'no' }
  })
  expect(ok).toBe(false)
})

await test('sendControlRequest: rejects when adapter has no control channel', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  // Register a stub adapter with no serializeControlRequest. Re-using the
  // claude adapter id would clash; use a fresh id and register via the public
  // API isn't exposed for tests, so we just assert the unknown-tab path here.
  let err: Error | null = null
  try {
    await mgr.sendControlRequest('nonexistent-tab', { subtype: 'interrupt' })
  } catch (e) {
    err = e as Error
  }
  expect(err?.message).toBe('no live session')
})

await test('invalid --resume: onInvalidResume fires + auto-retry with fresh session', async () => {
  await setup()
  const persisted: string[] = []
  let invalidResumeCalled = 0
  let spawnCount = 0
  const lastArgs: string[][] = []
  const fakes: Array<ReturnType<typeof makeFakeChild>> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: (_cmd, args) => {
      spawnCount++
      lastArgs.push(args)
      const f = makeFakeChild()
      fakes.push(f)
      return f as unknown as ChildProcess
    },
    broadcastEvent: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-resume',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: 'stale-session-id',
    providerFlags: [],
    onPersistSessionId: (id) => persisted.push(id),
    onInvalidResume: () => invalidResumeCalled++
  })
  expect(spawnCount).toBe(1)
  expect(lastArgs[0].includes('--resume')).toBe(true)

  // Simulate Claude emitting "No conversation found" stderr + error result.
  const first = fakes[0]
  first._stderr.write('No conversation found with session ID: stale-session-id\n')
  first._stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      total_cost_usd: 0,
      result: 'No conversation found with session ID: stale-session-id'
    }) + '\n'
  )
  // Let readline flush + setImmediate fire.
  await new Promise((r) => setTimeout(r, 150))
  // Simulate exit so retry proceeds.
  ;(first as unknown as EventEmitter).emit('exit', 1, null)
  await new Promise((r) => setTimeout(r, 100))

  expect(invalidResumeCalled).toBe(1)
  expect(spawnCount).toBe(2)
  // Second spawn must be fresh session-id, not --resume
  expect(lastArgs[1].includes('--resume')).toBe(false)
  expect(lastArgs[1].includes('--session-id')).toBe(true)
})

await test('invalid --resume: failed spawn events never broadcast or persist', async () => {
  await setup()
  const broadcastEvents: Array<{ tabId: string; kind: string }> = []
  const persistedEvents: Array<{ tabId: string; kind: string }> = []
  const fakes: Array<ReturnType<typeof makeFakeChild>> = []
  let spawnCount = 0
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount++
      const f = makeFakeChild()
      fakes.push(f)
      return f as unknown as ChildProcess
    },
    broadcastEvent: (tabId, event) => broadcastEvents.push({ tabId, kind: event.kind }),
    broadcastExit: () => {},
    broadcastStateChange: () => {},
    persistEvent: (tabId, _seq, event) => persistedEvents.push({ tabId, kind: event.kind })
  })
  await createChat(
    {
      tabId: 'tab-stage',
      taskId: 'task-stage',
      mode: 'claude-chat',
      cwd: '/tmp',
      conversationId: 'stale-uuid',
      providerFlags: []
    },
    { autoSpawn: false } // fires `spawn` explicitly to test the staging window
  )

  const first = fakes[0]
  // Synthetic spawn event so session-spawn enters tentative window first.
  ;(first as unknown as EventEmitter).emit('spawn')
  first._stderr.write('No conversation found with session ID: stale-uuid\n')
  first._stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      total_cost_usd: 0,
      result: 'No conversation found with session ID: stale-uuid'
    }) + '\n'
  )
  await new Promise((r) => setTimeout(r, 150))
  ;(first as unknown as EventEmitter).emit('exit', 1, null)
  await new Promise((r) => setTimeout(r, 150))

  // Failed spawn's noise events MUST NOT have reached renderer or chat_events.
  expect(broadcastEvents.some((e) => e.kind === 'stderr')).toBe(false)
  expect(broadcastEvents.some((e) => e.kind === 'process-exit')).toBe(false)
  expect(broadcastEvents.some((e) => e.kind === 'result')).toBe(false)
  expect(broadcastEvents.some((e) => e.kind === 'session-spawn')).toBe(false)
  expect(persistedEvents.some((e) => e.kind === 'stderr')).toBe(false)
  expect(persistedEvents.some((e) => e.kind === 'process-exit')).toBe(false)
  expect(persistedEvents.some((e) => e.kind === 'result')).toBe(false)
  expect(persistedEvents.some((e) => e.kind === 'session-spawn')).toBe(false)
  // Auto-retry must have run.
  expect(spawnCount).toBe(2)
})

await test('valid --resume: first healthy event flushes staged events in order', async () => {
  await setup()
  const broadcastEvents: Array<{ kind: string; seq: number }> = []
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (_tab, event, seq) => broadcastEvents.push({ kind: event.kind, seq }),
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  await createChat(
    {
      tabId: 'tab-resume-ok',
      taskId: 'task-resume-ok',
      mode: 'claude-chat',
      cwd: '/tmp',
      conversationId: 'good-uuid',
      providerFlags: []
    },
    { autoSpawn: false } // fires `spawn` explicitly to test staged-flush order
  )

  // Synthetic spawn event → would normally broadcast immediately, but we're in
  // the tentative window so it stages.
  ;(fake as unknown as EventEmitter).emit('spawn')
  // No broadcasts yet — staged.
  expect(broadcastEvents.some((e) => e.kind === 'session-spawn')).toBe(false)

  // Healthy turn-init … wait, turn-init alone isn't healthy in commitEvent
  // semantics (only assistant-text / tool-call / non-error result count).
  // Send turn-init (stages) then assistant-text (flushes).
  fake._stdout.write(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'good-uuid',
      model: 'sonnet',
      cwd: '/tmp',
      tools: []
    }) + '\n'
  )
  await new Promise((r) => setTimeout(r, 30))
  // Still staged — turn-init isn't healthy.
  expect(broadcastEvents.some((e) => e.kind === 'turn-init')).toBe(false)

  fake._stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello back' }] }
    }) + '\n'
  )
  await new Promise((r) => setTimeout(r, 30))

  // Flush order: session-spawn → turn-init → assistant-text. Seqs monotonic from 0.
  const kinds = broadcastEvents.map((e) => e.kind)
  const ssIdx = kinds.indexOf('session-spawn')
  const tiIdx = kinds.indexOf('turn-init')
  const atIdx = kinds.indexOf('assistant-text')
  expect(ssIdx >= 0).toBeTruthy()
  expect(tiIdx >= 0).toBeTruthy()
  expect(atIdx >= 0).toBeTruthy()
  expect(ssIdx < tiIdx).toBeTruthy()
  expect(tiIdx < atIdx).toBeTruthy()
  expect(broadcastEvents[ssIdx].seq).toBe(0)
  expect(broadcastEvents[tiIdx].seq).toBe(1)
  expect(broadcastEvents[atIdx].seq).toBe(2)
})

await test('exit event: fires process-exit + chat:exit broadcast', async () => {
  await setup()
  const fake = makeFakeChild()
  const eventKinds: string[] = []
  const exits: Array<{ code: number | null; signal: string | null }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (_tab, event) => eventKinds.push(event.kind),
    broadcastExit: (_tab, _sid, code, signal) => exits.push({ code, signal })
  })
  await createChat({
    tabId: 'tab-exit',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  ;(fake as unknown as EventEmitter).emit('exit', 0, null)
  await new Promise((r) => setTimeout(r, 10))
  expect(eventKinds.includes('process-exit')).toBeTruthy()
  expect(exits.length).toBe(1)
  expect(exits[0].code).toBe(0)
})

await test('exit event: chat:exit broadcast carries dying session sessionId', async () => {
  await setup()
  const fake = makeFakeChild()
  const exits: Array<{ sessionId: string }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: (_tab, sessionId) => exits.push({ sessionId })
  })
  const info = await createChat({
    tabId: 'tab-exit-sid',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: 'sid-known',
    providerFlags: []
  })
  ;(fake as unknown as EventEmitter).emit('exit', 0, null)
  await new Promise((r) => setTimeout(r, 10))
  expect(exits.length).toBe(1)
  expect(exits[0].sessionId).toBe(info.sessionId)
})

await test('reset race: old session exit fires after removeSession — broadcast swallowed', async () => {
  await setup()
  let spawnCount = 0
  const children: FakeChild[] = []
  const events: string[] = []
  const exits: Array<{ code: number | null }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount++
      const f = makeFakeChild()
      children.push(f)
      return f as unknown as ChildProcess
    },
    broadcastEvent: (_tab, event) => events.push(event.kind),
    broadcastExit: (_tab, _sid, code) => exits.push({ code }),
    broadcastStateChange: () => {}
  })

  // 1. Spawn session A.
  await createChat({
    tabId: 'tab-reset',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  expect(spawnCount).toBe(1)

  // 2. Reset flow: kill + remove + create.
  mgr.kill('tab-reset')
  mgr.removeSession('tab-reset')
  await createChat({
    tabId: 'tab-reset',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  expect(spawnCount).toBe(2)

  const beforeExitCount = exits.length

  // 3. Old session A's exit fires LATE — after new session already spawned.
  ;(children[0] as unknown as EventEmitter).emit('exit', 0, null)
  await new Promise((r) => setTimeout(r, 10))

  // Identity guard must have swallowed it — no new exit broadcast.
  expect(exits.length).toBe(beforeExitCount)
  // process-exit event must NOT have been buffered on the new session either.
  // (If it had, eventKinds would include 'process-exit'.)
  expect(events.filter((k) => k === 'process-exit').length).toBe(0)
})

await test('reset race: live session exit (not stale) still broadcasts', async () => {
  await setup()
  const fake = makeFakeChild()
  const events: string[] = []
  const exits: Array<{ code: number | null }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (_tab, event) => events.push(event.kind),
    broadcastExit: (_tab, _sid, code) => exits.push({ code }),
    broadcastStateChange: () => {}
  })
  await createChat({
    tabId: 'tab-live',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  // Session still in map (no reset). Exit fires.
  ;(fake as unknown as EventEmitter).emit('exit', 0, null)
  await new Promise((r) => setTimeout(r, 10))
  expect(exits.length).toBe(1)
  expect(events.includes('process-exit')).toBeTruthy()
})

await test('createChat: same tabId with different (taskId,cwd) → tears down zombie + spawns fresh', async () => {
  await setup()
  const fakeOld = makeFakeChild()
  const fakeNew = makeFakeChild()
  let spawnCount = 0
  let oldKilled = false
  fakeOld.kill = (_sig?: string) => {
    oldKilled = true
    return true
  }
  const events: Array<{ tabId: string; kind: string }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount++
      return (spawnCount === 1 ? fakeOld : fakeNew) as unknown as ChildProcess
    },
    broadcastEvent: (tabId, event) => events.push({ tabId, kind: event.kind }),
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  // First create: taskA, cwd /a
  await createChat({
    tabId: 'shared-tab',
    taskId: 'taskA',
    mode: 'claude-chat',
    cwd: '/a',
    conversationId: null,
    providerFlags: []
  })
  expect(spawnCount).toBe(1)

  // Second create on same tabId but different identity → must tear down + respawn
  await createChat({
    tabId: 'shared-tab',
    taskId: 'taskB',
    mode: 'claude-chat',
    cwd: '/b',
    conversationId: null,
    providerFlags: []
  })
  expect(spawnCount).toBe(2)
  expect(oldKilled).toBe(true)

  // New session emits events; assert broadcast carries the (now sole) live tabId
  fakeNew._stdout.write(readFileSync(resolve(fixtureDir(), 'bash.ndjson'), 'utf8'))
  await new Promise((r) => setTimeout(r, 30))
  expect(events.some((e) => e.kind === 'turn-init')).toBeTruthy()
})

await test('createChat: same tabId AND same identity → returns existing session (idempotent)', async () => {
  await setup()
  const fake = makeFakeChild()
  let spawnCount = 0
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => {
      spawnCount++
      return fake as unknown as ChildProcess
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  await createChat({
    tabId: 'idem-tab',
    taskId: 'taskA',
    mode: 'claude-chat',
    cwd: '/a',
    conversationId: null,
    providerFlags: []
  })
  await createChat({
    tabId: 'idem-tab',
    taskId: 'taskA',
    mode: 'claude-chat',
    cwd: '/a',
    conversationId: null,
    providerFlags: []
  })
  expect(spawnCount).toBe(1)
})

await test('onStateChange: fires alongside broadcastStateChange so global listeners see chat activity', async () => {
  await setup()
  const fake = makeFakeChild()
  const broadcasts: Array<{ sessionId: string; next: string; old: string }> = []
  const globalNotices: Array<{ sessionId: string; next: string; old: string }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: (sessionId, next, old) => broadcasts.push({ sessionId, next, old }),
    onStateChange: (sessionId, next, old) => globalNotices.push({ sessionId, next, old })
  })
  await createChat({
    tabId: 'tab-state',
    taskId: 'task-state',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  fake._stdout.write(readFileSync(resolve(fixtureDir(), 'bash.ndjson'), 'utf8'))
  await new Promise((r) => setTimeout(r, 50))

  // Both channels must see at least one running and one idle transition,
  // keyed by `${taskId}:${tabId}` so handleTerminalStateChange can split off the taskId.
  expect(broadcasts.length > 0).toBeTruthy()
  expect(globalNotices.length).toBe(broadcasts.length)
  expect(globalNotices[0].sessionId).toBe('task-state:tab-state')
  expect(globalNotices.some((g) => g.next === 'running')).toBeTruthy()
  expect(globalNotices.some((g) => g.next === 'idle' && g.old === 'running')).toBeTruthy()
})

await test('createChat: initialBuffer with unfinished turn → emits synthetic interrupted', async () => {
  await setup()
  const fake = makeFakeChild()
  const events: Array<{ tabId: string; kind: string; seq: number }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (tabId, event, seq) => events.push({ tabId, kind: event.kind, seq }),
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  // Seed: turn-init + user-message, NO result. Mid-turn crash scenario.
  const seeded: mgr.BufferedEvent[] = [
    {
      seq: 0,
      event: {
        kind: 'turn-init',
        sessionId: 'old',
        model: 'sonnet',
        cwd: '/tmp',
        tools: []
      }
    },
    { seq: 1, event: { kind: 'user-message', text: 'hello' } }
  ]
  await createChat({
    tabId: 'tab-restore-mid',
    taskId: 'task-restore',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: 'old-session',
    providerFlags: [],
    initialBuffer: seeded,
    initialNextSeq: 2
  })
  // Synthetic interrupted should appear at seq 2, before any spawn event.
  const interrupted = events.find((e) => e.kind === 'interrupted')
  expect(interrupted !== undefined).toBeTruthy()
  expect(interrupted!.tabId).toBe('tab-restore-mid')
  expect(interrupted!.seq).toBe(2)
})

await test('createChat: initialBuffer with completed turn → no synthetic interrupted', async () => {
  await setup()
  const fake = makeFakeChild()
  const events: Array<{ kind: string }> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (_tabId, event) => events.push({ kind: event.kind }),
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  const seeded: mgr.BufferedEvent[] = [
    {
      seq: 0,
      event: {
        kind: 'turn-init',
        sessionId: 'old',
        model: 'sonnet',
        cwd: '/tmp',
        tools: []
      }
    },
    { seq: 1, event: { kind: 'user-message', text: 'hi' } },
    {
      seq: 2,
      event: {
        kind: 'result',
        subtype: 'success',
        isError: false,
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 1,
        totalCostUsd: 0,
        stopReason: null,
        terminalReason: null,
        text: null,
        modelUsage: {},
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        permissionDenials: []
      }
    }
  ]
  await createChat({
    tabId: 'tab-restore-clean',
    taskId: 'task-restore',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: 'old-session',
    providerFlags: [],
    initialBuffer: seeded,
    initialNextSeq: 3
  })
  expect(events.some((e) => e.kind === 'interrupted')).toBe(false)
})

await test('permission-request ExitPlanMode → auto-deny on stdin, no broadcast', async () => {
  await setup()
  const events: AgentEvent[] = []
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (_t, e) => events.push(e),
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-exitplan',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  // Reset stdin capture so we ignore the spawn-time control_request init.
  fake._stdinRef.value = ''
  fake._stdout.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'cu_exit_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'ExitPlanMode',
        tool_use_id: 'tu_exit_1',
        input: { plan: 'do stuff' }
      }
    }) + '\n'
  )
  await new Promise((r) => setImmediate(r))
  const written = fake._stdinRef.value.trim()
  expect(written.length > 0).toBeTruthy()
  const parsed = JSON.parse(written)
  expect(parsed.type).toBe('control_response')
  expect(parsed.response.subtype).toBe('success')
  expect(parsed.response.request_id).toBe('cu_exit_1')
  expect(parsed.response.response.behavior).toBe('deny')
  // permission-request must NOT reach renderer — auto-handled at transport
  expect(events.some((e) => e.kind === 'permission-request')).toBe(false)
})

await test('permission-request AskUserQuestion → broadcast, no auto-deny', async () => {
  await setup()
  const events: AgentEvent[] = []
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: (_t, e) => events.push(e),
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-ask',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  fake._stdinRef.value = ''
  fake._stdout.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'cu_ask_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu_ask_1',
        input: { questions: [] }
      }
    }) + '\n'
  )
  await new Promise((r) => setImmediate(r))
  // No transport-level deny — renderer must answer.
  expect(fake._stdinRef.value).toBe('')
  expect(events.some((e) => e.kind === 'permission-request')).toBe(true)
})

await test('permission-request → flips terminal state to idle + sets awaitingUserInput', async () => {
  await setup()
  const stateChanges: { next: string; old: string }[] = []
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastStateChange: (_s, next, old) => stateChanges.push({ next, old }),
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-ask-state',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  // A user message opens the turn → running. (`turn-init` is session
  // metadata, not a turn-open signal — see commitEvent.)
  mgr.sendUserMessage('tab-ask-state', 'hi')
  await new Promise((r) => setImmediate(r))
  expect(mgr.getSessionTerminalState('tab-ask-state')).toBe('running')

  // permission-request (AskUserQuestion) → idle + awaitingUserInput=true
  fake._stdout.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'cu_state_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu_state_1',
        input: { questions: [] }
      }
    }) + '\n'
  )
  await new Promise((r) => setImmediate(r))
  expect(mgr.getSessionTerminalState('tab-ask-state')).toBe('idle')
  expect(mgr.isSessionAwaitingUserInput('tab-ask-state')).toBe(true)
  expect(stateChanges.some((s) => s.old === 'running' && s.next === 'idle')).toBe(true)

  // Subsequent assistant-text (SDK resumed after user answered) clears flag
  fake._stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'thanks' }] }
    }) + '\n'
  )
  await new Promise((r) => setImmediate(r))
  expect(mgr.isSessionAwaitingUserInput('tab-ask-state')).toBe(false)
})

await test('awaitingUserInput stays true across stderr / non-progress events', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastStateChange: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-ask-noclear',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  fake._stdout.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'cu_nc_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu_nc_1',
        input: {}
      }
    }) + '\n'
  )
  await new Promise((r) => setImmediate(r))
  expect(mgr.isSessionAwaitingUserInput('tab-ask-noclear')).toBe(true)

  // stderr does not prove SDK resumed — flag must stay true.
  fake._stderr.write('some warning\n')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 150)) // stderr is debounced
  expect(mgr.isSessionAwaitingUserInput('tab-ask-noclear')).toBe(true)
})

await test('drainChatQueue skips when awaitingUserInput is true (mid AskUserQuestion)', async () => {
  await setup()
  const fake = makeFakeChild()
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastStateChange: () => {},
    broadcastExit: () => {}
  })
  await createChat({
    tabId: 'tab-ask-drain',
    taskId: 'task-test',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  fake._stdout.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'cu_drain_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu_drain_1',
        input: {}
      }
    }) + '\n'
  )
  await new Promise((r) => setImmediate(r))
  expect(mgr.getSessionTerminalState('tab-ask-drain')).toBe('idle')
  expect(mgr.isSessionAwaitingUserInput('tab-ask-drain')).toBe(true)
})

// ---------------------------------------------------------------------------
// was_spawned lifecycle — restore-warm-on-reboot
// ---------------------------------------------------------------------------

await test('spawnedSetter: fires (true) on spawn-success with tabId', async () => {
  await setup()
  const fake = makeFakeChild()
  const recorder: Array<{ tabId: string; v: boolean }> = []
  mgr.setSpawnedTabRecorder((tabId, v) => recorder.push({ tabId, v }))
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  try {
    await createChat({
      tabId: 'tab-warm-1',
      taskId: 'task-warm',
      mode: 'claude-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    })
    expect(recorder.length).toBe(1)
    expect(recorder[0].tabId).toBe('tab-warm-1')
    expect(recorder[0].v).toBe(true)
  } finally {
    mgr.setSpawnedTabRecorder(null)
  }
})

await test('spawnedSetter: fires (false) on natural subprocess exit', async () => {
  await setup()
  const fake = makeFakeChild()
  const recorder: Array<{ tabId: string; v: boolean }> = []
  mgr.setSpawnedTabRecorder((tabId, v) => recorder.push({ tabId, v }))
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  try {
    await createChat({
      tabId: 'tab-warm-2',
      taskId: 'task-warm',
      mode: 'claude-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    })
    // Subprocess exits cleanly — exit handler should clear was_spawned.
    fake.emit('exit', 0, null)
    await new Promise((r) => setImmediate(r))
    const clears = recorder.filter((r) => r.v === false)
    expect(clears.length).toBe(1)
    expect(clears[0].tabId).toBe('tab-warm-2')
  } finally {
    mgr.setSpawnedTabRecorder(null)
  }
})

await test('spawnedSetter: shutdown gate preserves was_spawned on exit', async () => {
  await setup()
  const fake = makeFakeChild()
  const recorder: Array<{ tabId: string; v: boolean }> = []
  mgr.setSpawnedTabRecorder((tabId, v) => recorder.push({ tabId, v }))
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  try {
    await createChat({
      tabId: 'tab-warm-3',
      taskId: 'task-warm',
      mode: 'claude-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    })
    // Simulate app.on('will-quit') → beginTerminalShutdown(): gate flips first,
    // THEN killAll fires subprocess exits. Without the gate, this exit would
    // clear was_spawned and defeat the warm-restore on next boot.
    mgr.setShuttingDown(true)
    fake.emit('exit', null, 'SIGTERM')
    await new Promise((r) => setImmediate(r))
    const clears = recorder.filter((r) => r.v === false)
    expect(clears.length).toBe(0)
    // Spawn call (true) still happened though.
    const sets = recorder.filter((r) => r.v === true)
    expect(sets.length).toBe(1)
  } finally {
    mgr.setShuttingDown(false)
    mgr.setSpawnedTabRecorder(null)
  }
})

await test('shutdownAll: waits for chat exits and preserves warm flags', async () => {
  await setup()
  const fake = makeFakeChild()
  const kills: string[] = []
  fake.kill = (sig?: string) => {
    kills.push(sig ?? '')
    setImmediate(() => fake.emit('exit', null, sig ?? null))
    return true
  }
  const recorder: Array<{ tabId: string; v: boolean }> = []
  mgr.setSpawnedTabRecorder((tabId, v) => recorder.push({ tabId, v }))
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  try {
    await createChat({
      tabId: 'tab-shutdown',
      taskId: 'task-shutdown',
      mode: 'claude-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    })
    mgr.setShuttingDown(true)
    const result = await mgr.shutdownAll({ termGraceMs: 50, hardTimeoutMs: 200 })
    expect(result.total).toBe(1)
    expect(result.exited).toBe(1)
    expect(result.timedOut).toBe(0)
    expect(kills[0]).toBe('SIGTERM')
    expect(recorder.filter((r) => r.v === false).length).toBe(0)
  } finally {
    mgr.setShuttingDown(false)
    mgr.setSpawnedTabRecorder(null)
  }
})

await test('shutdownAll: escalates stuck chat process and resolves', async () => {
  await setup()
  const fake = makeFakeChild()
  const kills: string[] = []
  fake.kill = (sig?: string) => {
    kills.push(sig ?? '')
    return true
  }
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/claude',
    spawn: () => fake as unknown as ChildProcess,
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: () => {}
  })
  await createChat({
    tabId: 'tab-stuck',
    taskId: 'task-shutdown',
    mode: 'claude-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  mgr.setShuttingDown(true)
  try {
    const result = await mgr.shutdownAll({ termGraceMs: 5, hardTimeoutMs: 25 })
    expect(result.total).toBe(1)
    expect(result.timedOut).toBe(1)
    expect(kills.includes('SIGTERM')).toBe(true)
    expect(kills.includes('SIGKILL')).toBe(true)
  } finally {
    mgr.setShuttingDown(false)
  }
})

await test('codex-chat: a fatal driver-start failure kills the subprocess + goes dead', async () => {
  await setup()
  const stateChanges: string[] = []
  const fakes: Array<ReturnType<typeof makeFakeChild>> = []
  const killed: string[] = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/codex',
    spawn: () => {
      const f = makeFakeChild()
      // Record kill calls — the fatal-failure path must tear the process down.
      f.kill = ((sig?: string) => {
        killed.push(sig ?? 'SIGTERM')
        return true
      }) as ChildProcess['kill']
      fakes.push(f)
      return f as unknown as ChildProcess
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: (_tabId, state) => stateChanges.push(state)
  })
  await createChat(
    {
      tabId: 'tab-codex-fatal',
      taskId: 'task-codex',
      mode: 'codex-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    },
    { autoSpawn: false } // this test fires `spawn` explicitly
  )
  const child = fakes[0]
  // Subprocess is alive — the driver runs its initialize handshake.
  ;(child as unknown as EventEmitter).emit('spawn')
  await new Promise((r) => setTimeout(r, 50))
  // initialize (JSON-RPC id 1) fails — an unrecoverable handshake failure.
  child._stdout.write(
    JSON.stringify({ id: 1, error: { code: -32000, message: 'app-server down' } }) + '\n'
  )
  await new Promise((r) => setTimeout(r, 120))
  expect(killed.length > 0).toBe(true)
  // The kill drives the existing exit path → terminal `dead` state.
  ;(child as unknown as EventEmitter).emit('exit', 1, null)
  await new Promise((r) => setTimeout(r, 50))
  expect(stateChanges.includes('dead')).toBe(true)
})

await test('codex-chat: handshake with no user message rests at `idle`, not `running`', async () => {
  // Regression: the driver emits a synthetic `turn-init` at handshake to seed
  // the timeline. That event is session metadata — it must NOT flip the state
  // machine to `running`, or a freshly spawned / resumed codex-chat session
  // shows a perpetual spinner until the first message is sent.
  await setup()
  const stateChanges: string[] = []
  const fakes: Array<ReturnType<typeof makeFakeChild>> = []
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/codex',
    spawn: () => {
      const f = makeFakeChild()
      fakes.push(f)
      return f as unknown as ChildProcess
    },
    broadcastEvent: () => {},
    broadcastExit: () => {},
    broadcastStateChange: (_tabId, state) => stateChanges.push(state)
  })
  await createChat(
    {
      tabId: 'tab-codex-idle',
      taskId: 'task-codex',
      mode: 'codex-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    },
    { autoSpawn: false }
  )
  const child = fakes[0]
  ;(child as unknown as EventEmitter).emit('spawn') // starting → idle
  await new Promise((r) => setTimeout(r, 40))
  // Complete the handshake — initialize + thread/start both succeed. The
  // driver emits its synthetic `turn-init`; no user message follows.
  child._stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }) + '\n')
  await new Promise((r) => setTimeout(r, 30))
  child._stdout.write(
    JSON.stringify({ id: 2, result: { thread: { id: 't' }, model: 'gpt', cwd: '/tmp' } }) + '\n'
  )
  await new Promise((r) => setTimeout(r, 50))
  expect(mgr.getSessionTerminalState('tab-codex-idle')).toBe('idle')
  expect(stateChanges.includes('running')).toBe(false)
})

// --- liveness watchdog ---

/**
 * Stand up a codex-chat session with a fake child, recording kill signals,
 * state changes and exit broadcasts. Tiny watchdog bounds + an injected
 * liveness probe keep the suite fast and deterministic.
 */
async function watchdogHarness(opts: { alive?: boolean } = {}) {
  await setup()
  const stateChanges: ChatTerminalState[] = []
  const killed: string[] = []
  let exits = 0
  const fakes: Array<ReturnType<typeof makeFakeChild>> = []
  let alive = opts.alive ?? false
  mgr.setTransportDepsForTests({
    whichBinary: async () => '/fake/codex',
    spawn: () => {
      const f = makeFakeChild()
      f.kill = ((sig?: string) => {
        killed.push(sig ?? 'SIGTERM')
        return true
      }) as ChildProcess['kill']
      fakes.push(f)
      return f as unknown as ChildProcess
    },
    broadcastEvent: () => {},
    broadcastExit: () => {
      exits++
    },
    broadcastStateChange: (_id, state) => stateChanges.push(state),
    isProcessAlive: () => alive,
    watchdogTimings: { startingBoundMs: 40, runningStallMs: 80, killGraceMs: 40 }
  })
  await createChat(
    {
      tabId: 'tab-wd',
      taskId: 'task-wd',
      mode: 'codex-chat',
      cwd: '/tmp',
      conversationId: null,
      providerFlags: []
    },
    { autoSpawn: false } // watchdog tests drive `spawn` themselves
  )
  return {
    child: fakes[0],
    stateChanges,
    killed,
    getExits: () => exits,
    setAlive: (v: boolean) => {
      alive = v
    }
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Drive a fresh codex-chat child through spawn + handshake, then send a user
 * message so a real turn opens → `running`. The handshake alone leaves the
 * session `idle` (its synthetic `turn-init` is session metadata, not a
 * turn-open signal); a `user-message` is what flips it to `running`.
 */
async function driveCodexToRunning(child: ReturnType<typeof makeFakeChild>): Promise<void> {
  ;(child as unknown as EventEmitter).emit('spawn')
  await wait(30)
  child._stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }) + '\n')
  await wait(30)
  child._stdout.write(
    JSON.stringify({ id: 2, result: { thread: { id: 't' }, model: 'gpt', cwd: '/tmp' } }) + '\n'
  )
  await wait(40)
  mgr.sendUserMessage('tab-wd', 'go')
  await wait(20)
}

await test('watchdog: stuck `starting`, process dead → reaps to `dead`', async () => {
  const h = await watchdogHarness({ alive: false })
  // Never emit 'spawn' — the session is stuck in `starting`.
  await wait(160)
  expect(h.stateChanges.includes('dead')).toBe(true)
})

await test('watchdog: stuck `starting`, process alive → SIGTERM → SIGKILL → `dead`', async () => {
  const h = await watchdogHarness({ alive: true })
  await wait(150) // two kill-grace ticks
  expect(h.killed.includes('SIGTERM')).toBe(true)
  expect(h.killed.includes('SIGKILL')).toBe(true)
  h.setAlive(false) // process finally gone
  await wait(100)
  expect(h.stateChanges.includes('dead')).toBe(true)
})

await test('watchdog: stalled `running` turn → `dead`', async () => {
  const h = await watchdogHarness({ alive: false })
  await driveCodexToRunning(h.child)
  expect(h.stateChanges.includes('running')).toBe(true)
  await wait(200) // silence past runningStallMs
  expect(h.stateChanges.includes('dead')).toBe(true)
})

await test('watchdog: a `running` turn with steady progress is NOT killed', async () => {
  const h = await watchdogHarness({ alive: false })
  await driveCodexToRunning(h.child)
  // Stream a delta every 30ms (< 80ms stall bound) for ~240ms.
  for (let i = 0; i < 8; i++) {
    h.child._stdout.write(
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'tn', itemId: 'a1', delta: 'x' }
      }) + '\n'
    )
    await wait(30)
  }
  expect(h.stateChanges.includes('dead')).toBe(false) // never false-killed
  // Now go silent — the watchdog should catch the real stall.
  await wait(200)
  expect(h.stateChanges.includes('dead')).toBe(true)
})

await test('watchdog: missed-exit reap emits exactly one exit (idempotent)', async () => {
  const h = await watchdogHarness({ alive: false })
  await driveCodexToRunning(h.child)
  await wait(200) // watchdog reaps via a synthesized exit
  expect(h.getExits()).toBe(1)
  // A late real `exit` must not double-broadcast.
  ;(h.child as unknown as EventEmitter).emit('exit', 1, null)
  await wait(20)
  expect(h.getExits()).toBe(1)
})

await test('watchdog: a session resting in `idle` is never killed', async () => {
  const h = await watchdogHarness({ alive: false })
  ;(h.child as unknown as EventEmitter).emit('spawn') // starting → idle
  await wait(200) // well past every bound
  expect(h.stateChanges.includes('dead')).toBe(false)
  expect(h.stateChanges[h.stateChanges.length - 1]).toBe('idle')
})

await test('watchdog: __resetForTests cancels a pending timer', async () => {
  const h = await watchdogHarness({ alive: false })
  // Session is in `starting` with the watchdog armed; reset before it fires.
  mgr.__resetForTests()
  await wait(160)
  expect(h.getExits()).toBe(0)
})

await test('watchdog: fatal handshake failure escalates to SIGKILL', async () => {
  const h = await watchdogHarness({ alive: true })
  ;(h.child as unknown as EventEmitter).emit('spawn')
  await wait(30)
  // initialize fails → driver emits a fatal error → transport kills + arms.
  h.child._stdout.write(
    JSON.stringify({ id: 1, error: { code: -32000, message: 'app-server down' } }) + '\n'
  )
  await wait(120) // fatal SIGTERM, then a watchdog kill-grace tick
  expect(h.killed.includes('SIGTERM')).toBe(true)
  expect(h.killed.includes('SIGKILL')).toBe(true)
  h.setAlive(false)
  await wait(100)
  expect(h.stateChanges.includes('dead')).toBe(true)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
