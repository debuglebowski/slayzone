/**
 * Hub/runner split (wave 2, Model A) — the PtyBackend spawn seam.
 *
 * (1) A FAKE PtyBackend proves createPty routes its OS spawn through the seam:
 *     the fake handle's `onData` drives ptyEvents 'data' with a monotonic
 *     RingBuffer seq, ptyEvents 'exit' fires on the fake's `onExit`, and
 *     writePty / resizePty / killPty reach the fake handle. The injected spec
 *     carries `runnerId=null` + `transport=false` (the hub-local default).
 * (2) The default `localPtyBackend` spawns a REAL short-lived shell (echo) and
 *     its output arrives through ptyEvents 'data' with a monotonic RingBuffer
 *     seq — proving the dark default path is byte-identical.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm <file>
 */
import type { PtySessionWindow } from '../pty-host'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  createPty,
  writePty,
  resizePty,
  killPty,
  hasPty,
  setDatabase,
  ptyEvents
} from './pty-manager'
import { setPtyBackend, type PtyBackend, type PtyHandle, type PtySpawnSpec } from './pty-backend'

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

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

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
  emitExit(code: number): void
}
function makeFakeHandle(opts: Partial<Pick<PtyHandle, 'pid' | 'whenSpawned'>> = {}): FakeHandle {
  const dataCbs: Array<(d: string) => void> = []
  const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = []
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
    emitExit(code) {
      for (const cb of exitCbs) cb({ exitCode: code })
    }
  }
}

await test(
  'fake backend: createPty routes spawn; onData→ptyEvents data (monotonic seq); write/resize reach handle; onExit→ptyEvents exit',
  async () => {
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
    expect(capturedSpec !== null, 'backend.spawn must be invoked by createPty')
    expect(
      capturedSpec!.runnerId === null,
      `hub-local spawn must carry runnerId null, got ${String(capturedSpec!.runnerId)}`
    )
    expect(capturedSpec!.transport === false, 'host spawn must carry transport=false')
    expect(
      typeof capturedSpec!.file === 'string' && capturedSpec!.file.length > 0,
      'spec must carry a shell file'
    )
    expect(capturedSpec!.sessionId === sid, 'spec must carry the sessionId')

    // onData → ptyEvents 'data' with a monotonic RingBuffer seq.
    handle.emitData('BACKEND-CHUNK-1')
    handle.emitData('BACKEND-CHUNK-2')
    expect(dataEvents.length >= 2, `expected ≥2 data events, got ${dataEvents.length}`)
    expect(
      dataEvents[0][0].includes('BACKEND-CHUNK-1'),
      `first data chunk mismatch: ${dataEvents[0][0]}`
    )
    expect(
      dataEvents[1][0].includes('BACKEND-CHUNK-2'),
      `second data chunk mismatch: ${dataEvents[1][0]}`
    )
    expect(
      dataEvents[1][1] > dataEvents[0][1],
      `RingBuffer seq must be monotonic: ${dataEvents[0][1]} → ${dataEvents[1][1]}`
    )

    // writePty / resizePty reach the fake handle.
    writePty(sid, 'typed-input')
    expect(
      handle.written.join('').includes('typed-input'),
      `write must reach handle, got ${JSON.stringify(handle.written)}`
    )
    resizePty(sid, 120, 40)
    expect(
      handle.resized.some(([c, r]) => c === 120 && r === 40),
      `resize must reach handle, got ${JSON.stringify(handle.resized)}`
    )

    // onExit → ptyEvents 'exit'.
    handle.emitExit(0)
    expect(exitEvents.length >= 1, 'onExit must drive a ptyEvents exit')
    expect(exitEvents[0][0] === 0, `exit code must be 0, got ${String(exitEvents[0][0])}`)

    ptyEvents.off('data', dh)
    ptyEvents.off('exit', eh)
    setPtyBackend(null)
  }
)

await test('fake backend: killPty reaches the handle', async () => {
  const handle = makeFakeHandle()
  setPtyBackend({ spawn: () => handle })
  const sid = 'fakeKillTask:fakeKillTask'
  await createPty({ win: fakeWin, sessionId: sid, cwd: '/tmp', mode: 'terminal', type: 'terminal' })
  killPty(sid)
  expect(
    handle.killed.length >= 1,
    `killPty must reach handle.kill, got ${JSON.stringify(handle.killed)}`
  )
  // Finalize the session so it doesn't linger (kill on a fake handle never fires
  // onExit on its own).
  handle.emitExit(-2)
  setPtyBackend(null)
})

await test(
  'localPtyBackend: real echo shell output reaches ptyEvents with monotonic seq',
  async () => {
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
    )
    // RingBuffer seq strictly increases across the received chunks.
    for (let i = 1; i < dataEvents.length; i++) {
      expect(
        dataEvents[i][1] > dataEvents[i - 1][1],
        `seq must be strictly monotonic at ${i}: ${dataEvents[i - 1][1]} → ${dataEvents[i][1]}`
      )
    }
  }
)

// ── Remote spawn confirmation: an unknown pid is NOT a dead pty ──────────────
//
// A runner-routed handle comes back the instant the request is sent — the pid
// arrives later, with the runner's `pty.spawn` reply. Anything that reads the
// pid as a liveness signal inside that window is reading "not yet known" as
// "dead", which buries a session whose agent is starting up perfectly well.
// Both sentinels for "unknown" are covered so neither representation can creep
// back in as a fatal one.
for (const unknownPid of [null, 0] as Array<number | null>) {
  await test(
    `remote backend: a spawn reply that lands late must not synthesize an exit (pid=${String(unknownPid)})`,
    async () => {
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
        runnerId: 'runner-1'
      })

      // Well past any hub-side spawn watchdog, and the runner still has not
      // replied — exactly the restart case where a batch of resumes queues up
      // behind each other on a busy runner.
      await new Promise((r) => setTimeout(r, 700))

      expect(
        exits.length === 0,
        `no exit may be synthesized while the pid is merely unknown, got ${JSON.stringify(exits)}`
      )
      expect(hasPty(sid), 'session must still be alive while the spawn reply is in flight')

      // The reply lands: the session carries on as normal.
      confirmSpawn({ pid: 4242 })
      await new Promise((r) => setTimeout(r, 50))
      expect(exits.length === 0, `late reply must not exit either, got ${JSON.stringify(exits)}`)
      expect(hasPty(sid), 'session must survive its spawn confirmation')

      ptyEvents.off('exit', eh)
      killPty(sid)
      handle.emitExit(-2)
      setPtyBackend(null)
    }
  )
}

await test('remote backend: a REJECTED spawn confirmation finalizes the session', async () => {
  // The other half of the contract — deferring to the runner must not mean
  // ignoring it. A spawn the runner refused has to surface as a dead session.
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
    runnerId: 'runner-1'
  })
  failSpawn(new Error('runner refused the spawn'))
  await new Promise((r) => setTimeout(r, 100))

  expect(exits.length >= 1, 'a refused remote spawn must drive an exit')
  ptyEvents.off('exit', eh)
  setPtyBackend(null)
})

await test('a session declared dead must not leave a live process behind', async () => {
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

  expect(exits.length >= 1, 'a locally dead-on-arrival pty must still finalize')
  expect(
    handle.killed.length >= 1,
    `finalize must kill the handle so no process is orphaned, got ${JSON.stringify(handle.killed)}`
  )
  ptyEvents.off('exit', eh)
  setPtyBackend(null)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
