/**
 * Hub/computer split (wave 2, Model A) — the PtyBackend spawn seam.
 *
 * (1) A FAKE PtyBackend proves createPty routes its OS spawn through the seam:
 *     the fake handle's `onData` drives ptyEvents 'data' with a monotonic
 *     RingBuffer seq, ptyEvents 'exit' fires on the fake's `onExit`, and
 *     writePty / resizePty / killPty reach the fake handle. The injected spec
 *     carries `computerId=null` + `transport=false` (the hub-local default).
 * (2) The default `localPtyBackend` spawns a REAL short-lived shell (echo) and
 *     its output arrives through ptyEvents 'data' with a monotonic RingBuffer
 *     seq — proving the dark default path is byte-identical.
 *
 */
import { expect, test } from 'vitest'
import type { PtySessionWindow } from '../pty-host'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  createPty,
  writePty,
  resizePty,
  killPty,
  hasPty,
  prioritizePty,
  setDatabase,
  ptyEvents,
  getState
} from './pty-manager'
import { setPtyBackend, type PtyBackend, type PtyHandle, type PtySpawnSpec } from './pty-backend'

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {}, getURL: () => 'https://app' }
} as unknown as PtySessionWindow

// Tolerant stub: the spawn path may record a pending-spawn / build mcp env — all
// no-ops here (the seam under test never depends on their results).
const stubDb = {
  get: async () => ({ project_id: 'proj-1' }),
  all: async () => [],
  run: async () => ({ changes: 0, lastInsertRowid: 0 }),
  batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
} as unknown as SlayzoneDb

setDatabase(stubDb)

// ── Fake PtyHandle: records writes/resizes/kills, replays data/exit on demand ──
interface FakeHandle extends PtyHandle {
  written: string[]
  resized: Array<[number, number]>
  killed: string[]
  emitData(d: string): void
  emitExit(code: number, reason?: string): void
}
function makeFakeHandle(opts: Partial<Pick<PtyHandle, 'pid' | 'whenSpawned'>> = {}): FakeHandle {
  const dataCbs: Array<(d: string) => void> = []
  const exitCbs: Array<(e: { exitCode: number; signal?: number; reason?: string }) => void> = []
  return {
    pid: opts.pid === undefined ? 9191 : opts.pid,
    ...(opts.whenSpawned ? { whenSpawned: opts.whenSpawned } : {}),
    process: 'fake-sh',
    written: [],
    resized: [],
    killed: [],
    onData(cb) {
      dataCbs.push(cb)
      return { dispose() {} }
    },
    onExit(cb) {
      exitCbs.push(cb)
      return { dispose() {} }
    },
    write(d) {
      this.written.push(d)
    },
    resize(c, r) {
      this.resized.push([c, r])
    },
    kill(sig) {
      this.killed.push(sig ?? 'SIGTERM')
    },
    emitData(d) {
      for (const cb of dataCbs) cb(d)
    },
    emitExit(code, reason) {
      for (const cb of exitCbs) cb({ exitCode: code, ...(reason ? { reason } : {}) })
    }
  }
}

test('fake backend: createPty routes spawn; onData→ptyEvents data (monotonic seq); write/resize reach handle; onExit→ptyEvents exit', async () => {
  const handle = makeFakeHandle()
  let capturedSpec: PtySpawnSpec | null = null
  const fakeBackend: PtyBackend = {
    spawn(spec) {
      capturedSpec = spec
      return handle
    }
  }
  setPtyBackend(fakeBackend)

  const sid = 'fakeBackendTask:fakeBackendTask'
  const dataEvents: Array<[string, number]> = []
  const exitEvents: Array<[number | null, string | null]> = []
  const dh = (s: string, d: string, seq: number): void => {
    if (s === sid) dataEvents.push([d, seq])
  }
  const eh = (s: string, code: number | null, err: string | null): void => {
    if (s === sid) exitEvents.push([code, err])
  }
  ptyEvents.on('data', dh)
  ptyEvents.on('exit', eh)

  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'terminal',
    type: 'terminal'
  })

  // The spawn went through the injected backend, with the hub-local defaults.
  expect(capturedSpec, 'backend.spawn must be invoked by createPty').not.toBe(null)
  expect(
    capturedSpec!.computerId,
    `hub-local spawn must carry computerId null, got ${String(capturedSpec!.computerId)}`
  ).toBe(null)
  expect(capturedSpec!.transport, 'host spawn must carry transport=false').toBe(false)
  expect(typeof capturedSpec!.file, 'spec must carry a shell file').toBe('string')
  expect(capturedSpec!.file.length, 'spec must carry a shell file').toBeGreaterThan(0)
  expect(capturedSpec!.sessionId, 'spec must carry the sessionId').toBe(sid)

  // onData → ptyEvents 'data' with a monotonic RingBuffer seq.
  handle.emitData('BACKEND-CHUNK-1')
  handle.emitData('BACKEND-CHUNK-2')
  expect(
    dataEvents.length,
    `expected ≥2 data events, got ${dataEvents.length}`
  ).toBeGreaterThanOrEqual(2)
  expect(dataEvents[0][0], `first data chunk mismatch: ${dataEvents[0][0]}`).toContain(
    'BACKEND-CHUNK-1'
  )
  expect(dataEvents[1][0], `second data chunk mismatch: ${dataEvents[1][0]}`).toContain(
    'BACKEND-CHUNK-2'
  )
  expect(
    dataEvents[1][1],
    `RingBuffer seq must be monotonic: ${dataEvents[0][1]} → ${dataEvents[1][1]}`
  ).toBeGreaterThan(dataEvents[0][1])

  // writePty / resizePty reach the fake handle.
  writePty(sid, 'typed-input')
  expect(
    handle.written.join(''),
    `write must reach handle, got ${JSON.stringify(handle.written)}`
  ).toContain('typed-input')
  resizePty(sid, 120, 40)
  expect(
    handle.resized.some(([c, r]) => c === 120 && r === 40),
    `resize must reach handle, got ${JSON.stringify(handle.resized)}`
  ).toBe(true)

  // onExit → ptyEvents 'exit'.
  handle.emitExit(0)
  expect(exitEvents.length, 'onExit must drive a ptyEvents exit').toBeGreaterThanOrEqual(1)
  expect(exitEvents[0][0], `exit code must be 0, got ${String(exitEvents[0][0])}`).toBe(0)

  ptyEvents.off('data', dh)
  ptyEvents.off('exit', eh)
  setPtyBackend(null)
})

test('fake backend: killPty reaches the handle', async () => {
  const handle = makeFakeHandle()
  setPtyBackend({ spawn: () => handle })
  const sid = 'fakeKillTask:fakeKillTask'
  await createPty({ win: fakeWin, sessionId: sid, cwd: '/tmp', mode: 'terminal', type: 'terminal' })
  killPty(sid)
  expect(
    handle.killed.length,
    `killPty must reach handle.kill, got ${JSON.stringify(handle.killed)}`
  ).toBeGreaterThanOrEqual(1)
  // Finalize the session so it doesn't linger (kill on a fake handle never fires
  // onExit on its own).
  handle.emitExit(-2)
  setPtyBackend(null)
})

test("createPty replacing a live session id fires `replacing` synchronously, before the outgoing handle is killed — and before the outgoing handle's own (possibly delayed) `exit` can land", async () => {
  const handle1 = makeFakeHandle()
  const handle2 = makeFakeHandle()
  let nextHandle = handle1
  setPtyBackend({ spawn: () => nextHandle })
  const sid = 'fakeReplaceTask:fakeReplaceTask'

  const replacingEvents: string[] = []
  const rh = (s: string): void => {
    if (s === sid) replacingEvents.push(s)
  }
  ptyEvents.on('replacing', rh)

  await createPty({ win: fakeWin, sessionId: sid, cwd: '/tmp', mode: 'terminal', type: 'terminal' })
  expect(replacingEvents.length, 'first spawn on a fresh id must not fire replacing').toBe(0)
  expect(handle1.killed.length, 'first spawn must not kill anything').toBe(0)

  // Reuse the SAME session id — this is the createPty "Kill existing if any"
  // branch: it must emit `replacing` before calling killPty (source order), so
  // a listener resetting per-session state (e.g. the agent-hook route's
  // subagent tracker) sees it ahead of the outgoing process's own exit.
  nextHandle = handle2
  await createPty({ win: fakeWin, sessionId: sid, cwd: '/tmp', mode: 'terminal', type: 'terminal' })

  expect(
    replacingEvents.length,
    `expected exactly one replacing event for the reused id, got ${replacingEvents.length}`
  ).toBe(1)
  expect(handle1.killed.length, 'outgoing handle must be killed on replace').toBeGreaterThanOrEqual(
    1
  )
  expect(handle2.killed.length, 'incoming handle must not be killed').toBe(0)

  // The outgoing process's exit landing LATE — after the replacement is
  // already live — must NOT surface as a ptyEvents 'exit' for this id at all:
  // the onExit identity guard (`session.pty !== target`, pty-manager.ts) sees
  // that `sessions.get(sid)` now holds handle2's session, not handle1's, and
  // drops the callback before it ever reaches finalizeSessionExit. This is
  // *why* a plain `ptyEvents.on('exit', evictAgentTree)` listener (composition
  // .ts, no extra id-reuse guard needed) is safe: 'exit' structurally cannot
  // fire for an already-replaced generation. Proven, not assumed:
  const staleExitEvents: Array<number | null> = []
  const seh = (s: string, code: number | null): void => {
    if (s === sid) staleExitEvents.push(code)
  }
  ptyEvents.on('exit', seh)
  handle1.emitExit(-2)
  expect(
    staleExitEvents.length,
    `outgoing generation's late exit must not surface as ptyEvents 'exit', got ${JSON.stringify(staleExitEvents)}`
  ).toBe(0)
  ptyEvents.off('exit', seh)

  ptyEvents.off('replacing', rh)
  handle2.emitExit(0)
  setPtyBackend(null)
})

test('a PLAIN kill (no replace) fires ptyEvents "exit" and an unconditional listener must act on it — regression test for the always-false `!hasPty` guard bug', async () => {
  // Mirrors composition.ts's real wiring: an in-memory tracker standing in for
  // agent-hook.ts's `agentTrees`, evicted by BOTH `replacing` and `exit` with
  // no extra guard on either. This is the common case the whole fix targets —
  // task delete, the standalone kill route, a user-initiated stop — none of
  // which go through createPty's replace branch, so `replacing` never fires
  // and `exit` is the ONLY signal. A `!hasPty(sessionId)` guard on this
  // listener is always false here: `finalizeSessionExit` defers
  // `sessions.delete` ~100ms past the synchronous `exit` emit (to let trailing
  // onData drain), so the id is still registered at the instant this listener
  // runs — such a guard would make eviction unreachable for exactly this case.
  const fakeAgentTrees = new Set<string>()
  const evict = (sessionId: string): void => {
    fakeAgentTrees.delete(sessionId)
  }
  ptyEvents.on('replacing', evict)
  ptyEvents.on('exit', evict)

  const handle = makeFakeHandle()
  setPtyBackend({ spawn: () => handle })
  const sid = 'fakePlainKillTask:fakePlainKillTask'
  await createPty({ win: fakeWin, sessionId: sid, cwd: '/tmp', mode: 'terminal', type: 'terminal' })

  // Simulate a stale subagent id left behind mid-turn (the exact shape of the
  // original bug: a SubagentStop that never arrived).
  fakeAgentTrees.add(sid)
  expect(fakeAgentTrees.has(sid), 'setup: tracker must hold the id before kill').toBe(true)

  killPty(sid)
  expect(handle.killed.length, 'killPty must reach the handle').toBeGreaterThanOrEqual(1)
  handle.emitExit(-2) // no replacement anywhere in this test — a plain kill

  expect(
    fakeAgentTrees.has(sid),
    'a plain kill must evict the tracked id via the exit listener alone — ' +
      'if this fails, the exit listener is guarded by something that never fires'
  ).toBe(false)

  ptyEvents.off('replacing', evict)
  ptyEvents.off('exit', evict)
  setPtyBackend(null)
})

test('localPtyBackend: real echo shell output reaches ptyEvents with monotonic seq', async () => {
  setPtyBackend(null) // default in-process backend
  const sid = 'localEchoTask:localEchoTask'
  const marker = `SZ_BACKEND_ECHO_${Math.random().toString(36).slice(2, 8)}`
  const dataEvents: Array<[string, number]> = []
  let sawMarker = false
  let resolveWait: () => void = () => {}
  const waited = new Promise<void>((res) => {
    resolveWait = res
  })
  const dh = (s: string, d: string, seq: number): void => {
    if (s !== sid) return
    dataEvents.push([d, seq])
    if (d.includes(marker)) {
      sawMarker = true
      resolveWait()
    }
  }
  ptyEvents.on('data', dh)

  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'terminal',
    type: 'terminal',
    initialCommand: `echo ${marker}`
  })

  await Promise.race([waited, new Promise<void>((res) => setTimeout(res, 8000))])

  ptyEvents.off('data', dh)
  killPty(sid)

  expect(
    sawMarker,
    `echo marker must arrive via ptyEvents 'data' (events=${dataEvents.length}, sample=${JSON.stringify(
      dataEvents.slice(0, 3)
    )})`
  ).toBeTruthy()
  // RingBuffer seq strictly increases across the received chunks.
  for (let i = 1; i < dataEvents.length; i++) {
    expect(
      dataEvents[i][1],
      `seq must be strictly monotonic at ${i}: ${dataEvents[i - 1][1]} → ${dataEvents[i][1]}`
    ).toBeGreaterThan(dataEvents[i - 1][1])
  }
})

// ── Remote spawn confirmation: an unknown pid is NOT a dead pty ──────────────
//
// A computer-routed handle comes back the instant the request is sent — the pid
// arrives later, with the computer's `pty.spawn` reply. Anything that reads the
// pid as a liveness signal inside that window is reading "not yet known" as
// "dead", which buries a session whose agent is starting up perfectly well.
// Both sentinels for "unknown" are covered so neither representation can creep
// back in as a fatal one.
for (const unknownPid of [null, 0] as Array<number | null>) {
  await test(`remote backend: a spawn reply that lands late must not synthesize an exit (pid=${String(unknownPid)})`, async () => {
    let confirmSpawn: (v: { pid: number | null }) => void = () => {}
    const whenSpawned = new Promise<{ pid: number | null }>((res) => {
      confirmSpawn = res
    })
    const handle = makeFakeHandle({ pid: unknownPid, whenSpawned })
    setPtyBackend({ spawn: () => handle })

    const sid = `remoteLate${String(unknownPid)}:remoteLate${String(unknownPid)}`
    const exits: Array<number | null> = []
    const eh = (s: string, code: number | null): void => {
      if (s === sid) exits.push(code)
    }
    ptyEvents.on('exit', eh)

    await createPty({
      win: fakeWin,
      sessionId: sid,
      cwd: '/tmp',
      mode: 'terminal',
      type: 'terminal',
      computerId: 'computer-1'
    })

    // Well past any hub-side spawn watchdog, and the computer still has not
    // replied — exactly the restart case where a batch of resumes queues up
    // behind each other on a busy computer.
    await new Promise((r) => setTimeout(r, 700))

    expect(
      exits.length,
      `no exit may be synthesized while the pid is merely unknown, got ${JSON.stringify(exits)}`
    ).toBe(0)
    expect(
      hasPty(sid),
      'session must still be alive while the spawn reply is in flight'
    ).toBeTruthy()

    // The reply lands: the session carries on as normal.
    confirmSpawn({ pid: 4242 })
    await new Promise((r) => setTimeout(r, 50))
    expect(exits.length, `late reply must not exit either, got ${JSON.stringify(exits)}`).toBe(0)
    expect(hasPty(sid), 'session must survive its spawn confirmation').toBeTruthy()

    ptyEvents.off('exit', eh)
    killPty(sid)
    handle.emitExit(-2)
    setPtyBackend(null)
  })
}

test('remote backend: a REJECTED spawn confirmation finalizes the session', async () => {
  // The other half of the contract — deferring to the computer must not mean
  // ignoring it. A spawn the computer refused has to surface as a dead session.
  let failSpawn: (e: Error) => void = () => {}
  const whenSpawned = new Promise<{ pid: number | null }>((_res, rej) => {
    failSpawn = rej
  })
  // The test itself must never be the only handler — otherwise a regression in
  // the code under test surfaces as an unhandled rejection that kills the whole
  // run instead of one honest assertion failure.
  void whenSpawned.catch(() => {})
  const handle = makeFakeHandle({ pid: null, whenSpawned })
  setPtyBackend({ spawn: () => handle })

  const sid = 'remoteRefused:remoteRefused'
  const exits: Array<number | null> = []
  const eh = (s: string, code: number | null): void => {
    if (s === sid) exits.push(code)
  }
  ptyEvents.on('exit', eh)

  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'terminal',
    type: 'terminal',
    computerId: 'computer-1'
  })
  failSpawn(new Error('computer refused the spawn'))
  await new Promise((r) => setTimeout(r, 100))

  expect(exits.length, 'a refused remote spawn must drive an exit').toBeGreaterThanOrEqual(1)
  ptyEvents.off('exit', eh)
  setPtyBackend(null)
})

test('a session declared dead must not leave a live process behind', async () => {
  // Local backend, pid invalid at spawn: a genuine dead-on-arrival pty, and the
  // one case the hub-side pid check legitimately catches. Whatever declares the
  // session dead must also ensure the OS process is gone — a finalize that only
  // tears down bookkeeping is how a false positive turns into an orphaned agent
  // that nothing can ever reattach to.
  const handle = makeFakeHandle({ pid: 0 })
  setPtyBackend({ spawn: () => handle })

  const sid = 'deadOnArrival:deadOnArrival'
  const exits: Array<number | null> = []
  const eh = (s: string, code: number | null): void => {
    if (s === sid) exits.push(code)
  }
  ptyEvents.on('exit', eh)

  await createPty({ win: fakeWin, sessionId: sid, cwd: '/tmp', mode: 'terminal', type: 'terminal' })
  await new Promise((r) => setTimeout(r, 700))

  expect(exits.length, 'a locally dead-on-arrival pty must still finalize').toBeGreaterThanOrEqual(
    1
  )
  expect(
    handle.killed.length,
    `finalize must kill the handle so no process is orphaned, got ${JSON.stringify(handle.killed)}`
  ).toBeGreaterThanOrEqual(1)
  ptyEvents.off('exit', eh)
  setPtyBackend(null)
})

// ── Startup deadline: owned by whoever owns the process ─────────────────────
//
// 2026-10-23: a ~20s hub stall made the hub's own 10s startup timers fire late,
// all at once, and it SIGKILLed 13 agents whose output was already waiting in its
// buffers. The deadline now travels with the spawn so the computer — which sees
// the output directly — runs it, and the hub keeps its own only for a backend that
// confirms it does not.

test('remote backend: the spawn spec carries the startup deadline for the owner to arm', async () => {
  let capturedSpec: PtySpawnSpec | null = null
  const handle = makeFakeHandle({
    whenSpawned: Promise.resolve({ pid: 4242, ownsStartupDeadline: true })
  })
  setPtyBackend({
    spawn(spec) {
      capturedSpec = spec
      return handle
    }
  })
  const sid = 'deadlineSpec:deadlineSpec'
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'terminal',
    type: 'terminal',
    computerId: 'computer-1'
  })

  const spec = capturedSpec as PtySpawnSpec | null
  expect(
    spec?.startupTimeoutMs,
    `spawn spec must carry the adapter's startup deadline, got ${JSON.stringify(spec?.startupTimeoutMs)}`
  ).toBe(10_000)
  killPty(sid)
  handle.emitExit(-2)
  setPtyBackend(null)
})

test("a computer that OWNS the startup deadline is never second-guessed by the hub; one that does not still gets the hub's", async () => {
  // Both sessions stay silent past the deadline. Only the one whose owner did NOT
  // claim the deadline may be killed by the hub.
  const owned = makeFakeHandle({
    pid: null,
    whenSpawned: Promise.resolve({ pid: 4242, ownsStartupDeadline: true })
  })
  const legacy = makeFakeHandle({
    pid: null,
    whenSpawned: Promise.resolve({ pid: 4343, ownsStartupDeadline: false })
  })
  const handles = [owned, legacy]
  setPtyBackend({ spawn: () => handles.shift()! })

  const ownedSid = 'deadlineOwned:deadlineOwned'
  const legacySid = 'deadlineLegacy:deadlineLegacy'
  for (const sid of [ownedSid, legacySid]) {
    await createPty({
      win: fakeWin,
      sessionId: sid,
      cwd: '/tmp',
      mode: 'terminal',
      type: 'terminal',
      computerId: 'computer-1'
    })
  }

  await new Promise((r) => setTimeout(r, 10_700))

  expect(
    owned.killed.length,
    `the hub must not kill a session whose computer owns the deadline, killed=${JSON.stringify(owned.killed)}`
  ).toBe(0)
  expect(
    hasPty(ownedSid),
    `the hub must not kill a session whose computer owns the deadline, killed=${JSON.stringify(owned.killed)}`
  ).toBeTruthy()
  expect(
    legacy.killed,
    `an older computer's silent session still gets the hub's deadline, killed=${JSON.stringify(legacy.killed)}`
  ).toContain('SIGKILL')

  killPty(ownedSid)
  owned.emitExit(-2)
  killPty(legacySid)
  legacy.emitExit(-2)
  setPtyBackend(null)
})

test('an exit the owner attributes to its startup deadline goes through the normal exit path', async () => {
  const handle = makeFakeHandle({
    whenSpawned: Promise.resolve({ pid: 4242, ownsStartupDeadline: true })
  })
  setPtyBackend({ spawn: () => handle })
  const sid = 'deadlineExit:deadlineExit'
  const exits: Array<number | null> = []
  const eh = (s: string, code: number | null): void => {
    if (s === sid) exits.push(code)
  }
  ptyEvents.on('exit', eh)
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'terminal',
    type: 'terminal',
    computerId: 'computer-1'
  })
  await new Promise((r) => setTimeout(r, 20))

  handle.emitExit(0, 'startup-timeout')
  await new Promise((r) => setTimeout(r, 50))

  // The real code, not a synthetic -1: the computer's kill IS the exit.
  expect(
    JSON.stringify(exits),
    `startup-timeout exit must report the owner's code once, got ${JSON.stringify(exits)}`
  ).toBe('[0]')
  ptyEvents.off('exit', eh)
  setPtyBackend(null)
})

test("remote backend: an AGENT's initial spawn asks for admission (visible tab first); a plain shell never does", async () => {
  // Restoring a workspace starts every tab's agent; the computer admits them a few
  // at a time. Only the agent's own start queues — shells start at once.
  const captured: Array<{ sid: string; admission: PtySpawnSpec['admission'] }> = []
  setPtyBackend({
    spawn(spec) {
      captured.push({ sid: spec.sessionId, admission: spec.admission })
      return makeFakeHandle({
        whenSpawned: Promise.resolve({ pid: 4242, ownsStartupDeadline: true })
      })
    }
  })
  const cases: Array<{ sid: string; mode: string; foreground?: boolean }> = [
    { sid: 'admShell:admShell', mode: 'terminal', foreground: true },
    { sid: 'admBg:admBg', mode: 'claude-code' },
    { sid: 'admFg:admFg', mode: 'claude-code', foreground: true }
  ]
  for (const c of cases) {
    await createPty({
      win: fakeWin,
      sessionId: c.sid,
      cwd: '/tmp',
      mode: c.mode as never,
      type: c.mode,
      computerId: 'computer-1',
      ...(c.foreground ? { foreground: true } : {})
    })
  }
  const byId = Object.fromEntries(captured.map((c) => [c.sid, c.admission ?? null]))
  expect(
    byId['admShell:admShell'],
    `plain shell must start at once, got ${String(byId['admShell:admShell'])}`
  ).toBe(null)
  expect(byId['admBg:admBg'], `hidden agent → background, got ${String(byId['admBg:admBg'])}`).toBe(
    'background'
  )
  expect(
    byId['admFg:admFg'],
    `visible agent → foreground, got ${String(byId['admFg:admFg'])}`
  ).toBe('foreground')
  for (const c of cases) killPty(c.sid)
  setPtyBackend(null)
})

test('prioritizePty forwards to the backend for a live session only', async () => {
  const asked: string[] = []
  setPtyBackend({
    spawn: () => makeFakeHandle({ whenSpawned: new Promise<never>(() => {}) as never }),
    prioritize: (sessionId) => asked.push(sessionId)
  })
  const sid = 'prio:prio'
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'claude-code' as never,
    type: 'claude-code',
    computerId: 'computer-1'
  })
  prioritizePty(sid)
  prioritizePty('unknown:unknown')
  expect(JSON.stringify(asked), `asked=${JSON.stringify(asked)}`).toBe(JSON.stringify([sid]))
  killPty(sid)
  setPtyBackend(null)
})

// ── `starting` lasts until the agent's first output ─────────────────────────
//
// It used to flip to `idle` one microtask after spawn, so a tab whose agent was
// queued for a start slot (or still booting) looked exactly like a stopped one.
// The startup deadline bounds it: a session that never prints is killed.

test('a session stays starting until its first output, then settles to idle', async () => {
  const handle = makeFakeHandle({
    whenSpawned: Promise.resolve({ pid: 4242, ownsStartupDeadline: true })
  })
  setPtyBackend({ spawn: () => handle })
  const sid = 'startingUntilOutput:startingUntilOutput'
  await createPty({
    win: fakeWin,
    sessionId: sid,
    cwd: '/tmp',
    mode: 'terminal',
    type: 'terminal',
    computerId: 'computer-1'
  })
  await new Promise((r) => setTimeout(r, 300))
  expect(getState(sid), `before any output: expected starting, got ${String(getState(sid))}`).toBe(
    'starting'
  )

  handle.emitData('$ ')
  await new Promise((r) => setTimeout(r, 300))
  expect(getState(sid), `after first output: expected idle, got ${String(getState(sid))}`).toBe(
    'idle'
  )

  killPty(sid)
  handle.emitExit(-2)
  setPtyBackend(null)
})
