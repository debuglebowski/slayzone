/**
 * Unit tests for the hub-side exec proxies, driven by a fake in-memory gateway
 * (request + a real typed event bus). No sockets, no computer. The routing
 * backends consume the REAL seam types (terminal `PtyBackend`, processes
 * `ProcessBackend`, task `WorktreeExecAdapters`); the fake gateway is the
 * `RoutingGateway` slice of `HubComputerGateway`.
 */
import type { ProcHandle, ProcSpawnSpec } from '@slayzone/processes/server'
import type { LocalWorkspaceFs } from '@slayzone/file-editor/server'
import type { WorktreeExecAdapters } from '@slayzone/task/server'
import type { PtyHandle, PtySpawnSpec } from '@slayzone/terminal/server'
import { describe, expect, it, vi } from 'vitest'
import { TypedEventEmitter } from '../shared/events'
import {
  ComputerTransportErrorCodes,
  PTY_SIGNAL_EVENT_NAME,
  projectNotPlacedError
} from '../shared/frames'
import { RpcDisposedError, RpcError } from '../shared/rpc'
import {
  createRemoteFsAdapters,
  createRemoteWorktreeAdapters,
  createRoutingProcessBackend,
  createRoutingChatBackend,
  createRoutingPtyBackend,
  NoComputerAvailableError,
  type ComputerWork,
  type ComputerWorkGate,
  type PtyExitEvent,
  type RoutingGateway
} from './exec-proxies'
import type { ComputerDescriptor, ComputerGatewayEvents } from './hub-gateway'
import { ComputerUpdatePendingError } from './hub-gateway'

// ---------------------------------------------------------------------------
// Fake gateway
// ---------------------------------------------------------------------------

interface RecordedCall {
  computerId: string
  method: string
  params: unknown
  /** The caller's per-request timeout, as passed (undefined = the rpc default). */
  timeoutMs?: number
}

class FakeGateway implements RoutingGateway {
  readonly calls: RecordedCall[] = []
  readonly events = new TypedEventEmitter<ComputerGatewayEvents>()
  private readonly handlers = new Map<string, (params: unknown) => unknown>()

  /** Register a canned responder for a hub → computer request method. */
  onMethod(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler)
  }

  request<T = unknown>(
    computerId: string,
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    this.calls.push({ computerId, method, params, timeoutMs })
    const handler = this.handlers.get(method)
    if (!handler) return Promise.resolve(undefined as T)
    try {
      return Promise.resolve(handler(params) as T)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * Drive a gateway event to all subscribers, keeping the connected-computer
   * roster consistent with it — the real gateway registers on connect and
   * removes on loss, and the detach controller reads that roster for its epoch
   * baseline.
   */
  emit<K extends keyof ComputerGatewayEvents>(event: K, payload: ComputerGatewayEvents[K]): void {
    if (event === 'computer-connected') {
      const { computer } = payload as ComputerGatewayEvents['computer-connected']
      this.computers.set(computer.computerId, computer)
    } else if (event === 'computer-disconnected' || event === 'computer-lost') {
      const { computerId } = payload as { computerId: string }
      this.computers.delete(computerId)
    }
    this.events.emit(event, payload)
  }

  private readonly computers = new Map<string, ComputerDescriptor>()

  listComputers(): ComputerDescriptor[] {
    return [...this.computers.values()]
  }

  requestsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method)
  }
}

const requireCall = (gateway: FakeGateway, method: string): RecordedCall => {
  const call = gateway.requestsOf(method)[0]
  if (!call) throw new Error(`expected a call to ${method}`)
  return call
}

const ptySpec = (over: Partial<PtySpawnSpec> = {}): PtySpawnSpec => ({
  sessionId: 'sess-1',
  taskId: 'task-1',
  computerId: 'computer-1',
  projectId: null,
  file: 'bash',
  args: [],
  transport: false,
  ...over,
  options: {
    cwd: '/tmp',
    env: {},
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    ...(over.options ?? {})
  }
})

const procSpec = (over: Partial<ProcSpawnSpec> = {}): ProcSpawnSpec => ({
  id: 'proc-1',
  taskId: 'task-1',
  projectId: 'proj-1',
  computerId: 'computer-1',
  command: 'git status',
  cwd: '/repo',
  ...over
})

// ===========================================================================
// Routing pty backend
// ===========================================================================

describe('createRoutingPtyBackend', () => {
  it('throws NoComputerAvailableError when no computer resolves (never spawns on the hub)', () => {
    const gateway = new FakeGateway()
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => null
    })

    // Computers run the agents. This used to fall through to an in-process spawn,
    // which made "which machine ran this?" invisible DB state.
    expect(() => backend.spawn(ptySpec({ computerId: null }))).toThrow(NoComputerAvailableError)
    expect(gateway.calls).toHaveLength(0)
  })

  it('remote: monotonic delivery, backfills a gap via getBufferSince, sets pid, cleans up on exit', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 4242 }))
    gateway.onMethod('pty.getBufferSince', () => ({
      frames: [
        { seq: 2, data: 'c' },
        { seq: 3, data: 'd' },
        { seq: 4, data: 'e' }
      ]
    }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })

    // Sequences start at 0 — that is what the computer's RingBuffer emits.
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 0,
      data: 'a'
    })
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 1,
      data: 'b'
    })
    // Gap: seq 4 arrives before 2 & 3 → backfill from lastSeq (1).
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 4,
      data: 'e'
    })

    await vi.waitFor(() => expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e']))
    await vi.waitFor(() => expect(handle.pid).toBe(4242))

    expect(requireCall(gateway, 'pty.getBufferSince').params).toMatchObject({
      sessionId: 'sess-1',
      seq: 1
    })

    // Duplicate / stale frame is ignored (no double delivery).
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 2,
      data: 'DUP'
    })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])

    gateway.emit('pty.exit', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      exitCode: 0,
      signal: null
    })
    expect(exit).toEqual({ exitCode: 0, signal: undefined })

    // Post-exit frames are dropped (session disposed).
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 5,
      data: 'zzz'
    })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('adopt: seeds warm output first, then drains frames that raced the reply', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.warmAdopt', () => ({
      pid: 4242,
      data: 'BOOT-BANNER',
      seq: 5
    }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => 'computer-1'
    })

    const chunks: string[] = []
    // Start the adopt but do not await it yet, so we can emit a live frame while
    // the request is still in flight — the real race, since the computer begins
    // streaming the instant it rekeys.
    const pending = backend.adopt!('computer-1', 'warm-1', 'sess-warm', 'bash', 'task-warm')
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-warm',
      seq: 6,
      data: 'AFTER'
    })

    const handle = await pending
    handle.onData((d) => chunks.push(d))
    await new Promise((r) => setTimeout(r, 0))

    expect(handle.pid).toBe(4242)
    // Warm output precedes the frame that raced it, despite arriving later.
    expect(chunks.join('')).toBe('BOOT-BANNERAFTER')
    // ...and no backfill was issued. A frame arriving before the seed looks like
    // a gap against the initial lastSeq of -1, so an unsealed entry fires a
    // getBufferSince on EVERY adopt — a wasted round-trip re-fetching precisely
    // the bytes the adopt reply is already carrying.
    expect(gateway.requestsOf('pty.getBufferSince')).toHaveLength(0)
    // Rekey, not respawn: nothing was spawned for this session.
    expect(gateway.requestsOf('pty.spawn')).toHaveLength(0)
    expect(requireCall(gateway, 'pty.warmAdopt').params).toEqual({
      warmId: 'warm-1',
      sessionId: 'sess-warm',
      taskId: 'task-warm'
    })

    // Seq continues from the seed's high-water mark rather than restarting, so a
    // frame at or below it is a duplicate and must not be re-delivered.
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-warm',
      seq: 5,
      data: 'DUP'
    })
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-warm',
      seq: 7,
      data: '-NEXT'
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(chunks.join('')).toBe('BOOT-BANNERAFTER-NEXT')
  })

  it('adopt: a failed warmAdopt disposes the session instead of leaking it', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.warmAdopt', () => {
      throw new Error('no warm session warm-gone to adopt')
    })
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => 'computer-1'
    })

    await expect(backend.adopt!('computer-1', 'warm-gone', 'sess-x', 'bash')).rejects.toThrow(
      /no warm session/
    )
    // The caller cold-spawns after a failed adopt; a stale entry under the same
    // key would swallow that session's frames.
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    const handle = await backend.spawn(ptySpec({ sessionId: 'sess-x' }))
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-x',
      seq: 0,
      data: 'fresh'
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(chunks.join('')).toBe('fresh')
  })

  it('skips forward instead of stalling when a gap is unrecoverable', async () => {
    // Starting delivery at seq -1 makes an unfillable seq 0 reachable: a session
    // whose opening chunk already aged out of the computer's ring buffer can never
    // produce it. Waiting for it would stall the pty forever — strictly worse
    // than the single dropped chunk this fix removes. So after a backfill has
    // run at a position and left the gap open, delivery advances.
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 9 }))
    // Computer no longer holds the missing frames.
    gateway.onMethod('pty.getBufferSince', () => ({ frames: [] }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))

    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 7,
      data: 'late'
    })

    await vi.waitFor(() => expect(chunks).toEqual(['late']))

    // And delivery continues normally from there.
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 8,
      data: 'next'
    })
    expect(chunks).toEqual(['late', 'next'])
  })

  it('a frame arriving while the backfill is in flight waits for it — nothing skipped', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 9 }))
    let release!: (v: unknown) => void
    gateway.onMethod('pty.getBufferSince', () => new Promise((r) => (release = r)))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    const frame = (seq: number, data: string) =>
      gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq, data })
    frame(0, 'zero ')
    frame(3, 'three ') // gap 1-2: backfill
    frame(4, 'four') // before the backfill replied
    release({
      frames: [
        { seq: 1, data: 'one ' },
        { seq: 2, data: 'two ' }
      ]
    })
    await vi.waitFor(() => expect(chunks.join('')).toBe('zero one two three four'))
  })

  it('a failed backfill is retried, never taken as proof the frames are gone', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 9 }))
    let attempts = 0
    gateway.onMethod('pty.getBufferSince', () => {
      attempts++
      if (attempts === 1) throw new Error('request timed out')
      return { frames: [{ seq: 1, data: 'one ' }] }
    })
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    const frame = (seq: number, data: string) =>
      gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq, data })
    frame(0, 'zero ')
    frame(2, 'two ')
    await new Promise((r) => setTimeout(r, 5))
    frame(3, 'three')
    await vi.waitFor(() => expect(chunks.join('')).toBe('zero one two three'), { timeout: 3000 })
    expect(attempts).toBe(2)
  })

  it('delivers seq 0 — the computer numbers its FIRST chunk 0, not 1', async () => {
    // The computer's RingBuffer starts at `nextSeq = 0` (ring-buffer.ts), so the
    // very first chunk of every remote pty session carries seq 0. The hub used
    // to initialise `lastSeq: 0`, and `ingest` drops `seq <= lastSeq` — so that
    // first chunk was silently discarded on every session. Session start is
    // exactly where a shell's banner/prompt lives.
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))

    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 0,
      data: 'FIRST'
    })
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 1,
      data: 'second'
    })

    expect(chunks).toEqual(['FIRST', 'second'])
  })

  it('backfills a gap that starts at seq 0 (never-backfilled sentinel is distinct from lastSeq)', async () => {
    // `backfilledAt` guards against re-issuing a backfill at the same position.
    // With `lastSeq` now starting at -1, a `-1` sentinel would compare equal on
    // the first gap and suppress the only backfill that could recover seq 0 —
    // hence the sentinel is `null`, not a number.
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    gateway.onMethod('pty.getBufferSince', () => ({
      frames: [
        { seq: 0, data: 'zero' },
        { seq: 1, data: 'one' }
      ]
    }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))

    // seq 2 first: gap at 0 and 1 → backfill must ask from BEFORE seq 0.
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 2,
      data: 'two'
    })

    await vi.waitFor(() => expect(chunks).toEqual(['zero', 'one', 'two']))
    // `getBufferSince` returns `seq > params.seq`, so -1 is what includes seq 0.
    expect(requireCall(gateway, 'pty.getBufferSince').params).toMatchObject({
      sessionId: 'sess-1',
      seq: -1
    })
  })

  it('maps the spawn spec to a pty.spawn frame and issues write/resize/kill frames', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })

    const handle = (await backend.spawn(
      ptySpec({
        file: 'zsh',
        args: ['-l'],
        options: {
          cwd: '/work',
          env: { FOO: 'bar', SLAYZONE_TASK_ID: 'task-1' },
          cols: 100,
          rows: 30,
          name: 'xterm-256color'
        }
      })
    )) as PtyHandle

    expect(requireCall(gateway, 'pty.spawn')).toMatchObject({
      computerId: 'computer-1',
      params: {
        sessionId: 'sess-1',
        command: 'zsh',
        args: ['-l'],
        cwd: '/work',
        env: { SLAYZONE_TASK_ID: 'task-1' },
        cols: 100,
        rows: 30
      }
    })

    handle.write('input')
    expect(requireCall(gateway, 'pty.write').params).toMatchObject({
      sessionId: 'sess-1',
      data: 'input'
    })

    handle.resize(120, 40)
    expect(requireCall(gateway, 'pty.resize').params).toMatchObject({
      sessionId: 'sess-1',
      cols: 120,
      rows: 40
    })

    handle.kill('SIGTERM')
    expect(requireCall(gateway, 'pty.kill').params).toMatchObject({
      sessionId: 'sess-1',
      signal: 'SIGTERM'
    })
    expect((requireCall(gateway, 'pty.kill').params as { spawnId: string }).spawnId).toBeTruthy()

    handle.kill()
    expect(gateway.requestsOf('pty.kill')[1]?.params).toMatchObject({
      sessionId: 'sess-1'
    })
  })

  it('keeps old routing until computer confirms kill, then confirms replacement', async () => {
    const gateway = new FakeGateway()
    let releaseKill!: () => void
    let releaseSpawn!: () => void
    let starts = 0
    gateway.onMethod('pty.spawn', () => {
      starts += 1
      return starts === 1
        ? { pid: 11 }
        : new Promise((resolve) => {
            releaseSpawn = () => resolve({ pid: 22 })
          })
    })
    gateway.onMethod(
      'pty.kill',
      () =>
        new Promise((resolve) => {
          releaseKill = () => resolve({ ok: true })
        })
    )
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    const old = (await backend.spawn(ptySpec())) as PtyHandle
    await old.whenSpawned
    const oldSpawnId = (requireCall(gateway, 'pty.spawn').params as { spawnId: string }).spawnId
    const oldData: string[] = []
    old.onData((data) => oldData.push(data))
    const replacing = Promise.resolve(backend.spawn(ptySpec()))
    await vi.waitFor(() => expect(gateway.requestsOf('pty.kill')).toHaveLength(1))
    expect(gateway.requestsOf('pty.spawn')).toHaveLength(1)
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 0, data: 'A' })
    expect(oldData).toEqual(['A'])
    releaseKill()
    await vi.waitFor(() => expect(gateway.requestsOf('pty.spawn')).toHaveLength(2))
    let delivered = false
    void replacing.then(() => {
      delivered = true
    })
    await Promise.resolve()
    expect(delivered).toBe(false)
    releaseSpawn()
    const next = (await replacing) as PtyHandle
    expect(next.pid).toBe(22)
    const nextData: string[] = []
    let nextExited = false
    next.onData((data) => nextData.push(data))
    next.onExit(() => {
      nextExited = true
    })
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      spawnId: oldSpawnId,
      seq: 0,
      data: 'late A'
    })
    gateway.emit('pty.exit', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      spawnId: oldSpawnId,
      exitCode: 0
    })
    expect(nextData).toEqual([])
    expect(nextExited).toBe(false)
  })

  // ── Detach / reattach across a dropped computer connection ──────────────────
  //
  // These used to assert the opposite: that computer-lost / computer-disconnected
  // finalized every session on the computer. That was the bug — a lost socket is
  // not a dead agent, and coercing it to `exitCode: 1` surfaced one dropped
  // connection as N independent "Process exited with code 1" while every agent
  // was still running. A disconnect now resolves NOTHING; the computer does, on
  // reconnect.

  /** Drive the gateway's computer-connected event, optionally carrying an epoch. */
  const connect = (gateway: FakeGateway, epoch?: string): void => {
    gateway.emit('computer-connected', {
      computer: {
        computerId: 'computer-1',
        authMode: 'hello',
        directAddress: null,
        peerLoopback: false,
        directRtc: false,
        connectedAt: 0,
        lastSeenAt: 0,
        ...(epoch === undefined ? {} : { epoch })
      }
    })
  }

  const spawnDetached = async (
    gateway: FakeGateway,
    epoch: string | undefined = 'epoch-a'
  ): Promise<{ chunks: string[]; exit: () => PtyExitEvent | null }> => {
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, epoch)
    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 0,
      data: 'a'
    })
    gateway.emit('computer-lost', {
      computerId: 'computer-1',
      reason: 'heartbeat-timeout'
    })
    return { chunks, exit: () => exit }
  }

  it('computer-lost detaches the session rather than declaring it dead', async () => {
    const gateway = new FakeGateway()
    const { chunks, exit } = await spawnDetached(gateway)

    // The regression this whole mechanism exists for: closing a laptop lid must
    // not report a running agent as crashed.
    expect(exit()).toBeNull()

    // Still tracked, so anything that does arrive is still delivered.
    gateway.emit('pty.data', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      seq: 1,
      data: 'b'
    })
    expect(chunks).toEqual(['a', 'b'])
  })

  it('computer-disconnected detaches too — a clean close is no more evidence than a silent one', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('computer-disconnected', {
      computerId: 'computer-1',
      reason: 'socket-closed'
    })
    expect(exit).toBeNull()
  })

  it('reconnect with the SAME epoch reattaches sessions the computer still holds, backfilling the gap', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', pid: 1, seq: 1 }]
    }))
    gateway.onMethod('pty.getBufferSince', () => ({
      frames: [{ seq: 1, data: 'b' }]
    }))
    const { chunks, exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-a') // same process came back

    await vi.waitFor(() => expect(chunks).toEqual(['a', 'b']))
    expect(exit()).toBeNull()
    // Backfill resumes from the last seq actually delivered, not from scratch.
    expect(requireCall(gateway, 'pty.getBufferSince').params).toMatchObject({
      sessionId: 'sess-1',
      seq: 0
    })
  })

  it('a piped session acked before any output owns its output: seqs pass through, replay forwards', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
    gateway.onMethod('pty.getReplay', () => ({
      chunks: [{ seq: 0, data: 'a' }],
      prelude: '',
      currentSeq: 0
    }))
    gateway.onMethod('pty.clearBuffer', () => ({ clearedSeq: 0 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'codex', resuming: false }
    })) as PtyHandle
    await handle.whenSpawned
    expect(handle.ownsOutput).toBe(true)
    // Direct link: the routed handle names its computer, for issuing a capability.
    expect(handle.computerId).toBe('computer-1')
    const got: Array<[string, number | undefined]> = []
    handle.onData((d, seq) => got.push([d, seq]))
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 0, data: 'a' })
    expect(got).toEqual([['a', 0]])
    expect(await handle.getReplay?.(-1)).toEqual({
      chunks: [{ seq: 0, data: 'a' }],
      prelude: '',
      currentSeq: 0
    })
    expect(requireCall(gateway, 'pty.getReplay').params).toMatchObject({
      sessionId: 'sess-1',
      afterSeq: -1
    })
    expect(await handle.clearOutput?.()).toEqual({ clearedSeq: 0 })
  })

  it('relays what a direct write meant (pty-input) to its session, only for that session and spawn', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'codex', resuming: false }
    })) as PtyHandle
    await handle.whenSpawned
    const got: unknown[] = []
    handle.onInput?.((facts) => got.push(facts))
    const event = (payload: Record<string, unknown>) =>
      gateway.emit('event', { computerId: 'computer-1', name: 'pty-input', payload })
    event({ sessionId: 'sess-1', submitted: 'hi\r', esc: false, statusCommand: false })
    event({ sessionId: 'other', submitted: 'x\r', esc: false, statusCommand: false })
    event({
      sessionId: 'sess-1',
      spawnId: 'stale',
      submitted: 'y\r',
      esc: false,
      statusCommand: false
    })
    event({ sessionId: 'sess-1', submitted: 5 })
    expect(got).toEqual([{ submitted: 'hi\r', esc: false, statusCommand: false }])
  })

  it('relay on demand: spawned unrelayed, turned on at the seq the computer reached, no backfill of the gap', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
    gateway.onMethod('pty.relay', () => ({ seq: 7 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'codex', resuming: false },
      relay: false
    })) as PtyHandle
    await handle.whenSpawned
    expect(requireCall(gateway, 'pty.spawn').params).toMatchObject({ relay: false })
    const got: Array<[string, number | undefined]> = []
    handle.onData((d, seq) => got.push([d, seq]))
    handle.setRelay?.(true)
    await vi.waitFor(() =>
      expect(requireCall(gateway, 'pty.relay').params).toMatchObject({
        sessionId: 'sess-1',
        on: true
      })
    )
    await new Promise((r) => setTimeout(r, 10))
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 8, data: 'x' })
    expect(got).toEqual([['x', 8]])
    expect(gateway.calls.filter((c) => c.method === 'pty.getBufferSince')).toEqual([])
  })

  // Round-7 N7: on reconnect the relay request went out twice — from here and from
  // the terminal runtime's availability listener (which owns that decision since L2).
  it('resume does not resend the relay itself (the runtime asks once, on availability)', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
    gateway.onMethod('pty.relay', () => ({ seq: 0 }))
    gateway.onMethod('pty.list', () => ({ sessions: [{ sessionId: 'sess-1', pid: 1, seq: -1 }] }))
    gateway.onMethod('pty.getBufferSince', () => ({ frames: [] }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'codex', resuming: false },
      relay: false
    })) as PtyHandle
    await handle.whenSpawned
    await handle.setRelay?.(true)
    const seen: boolean[] = []
    handle.onAvailability?.((available) => seen.push(available))
    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    connect(gateway, 'epoch-a')
    await vi.waitFor(() => expect(seen).toEqual([false, true]))
    await new Promise((r) => setTimeout(r, 20))
    expect(gateway.requestsOf('pty.relay')).toHaveLength(1)
  })

  // N7: a computer that predates pty.relay (v0.37.2) streams every session anyway; each
  // watch change asked it again, and failed. It is asked once.
  it('a computer without pty.relay is asked once, and the relay reads as applied', async () => {
    for (const refusal of [
      new RpcError(ComputerTransportErrorCodes.unimplemented, 'unimplemented: pty.relay'),
      new ComputerUpdatePendingError(
        'pty.relay',
        ComputerTransportErrorCodes.unimplemented,
        '0.37.2'
      )
    ]) {
      const gateway = new FakeGateway()
      gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
      gateway.onMethod('pty.relay', () => {
        throw refusal
      })
      const backend = createRoutingPtyBackend({
        gateway,
        resolveComputerId: (spec) => spec.computerId ?? null
      })
      connect(gateway, 'epoch-a')
      const handle = (await backend.spawn({
        ...ptySpec(),
        detection: { mode: 'codex', resuming: false },
        relay: false
      })) as PtyHandle
      await handle.whenSpawned
      await expect(handle.setRelay?.(true)).resolves.toBeUndefined()
      await expect(handle.setRelay?.(false)).resolves.toBeUndefined()
      await expect(handle.setRelay?.(true)).resolves.toBeUndefined()
      expect(gateway.requestsOf('pty.relay')).toHaveLength(1)
    }
  })

  it('a routed handle reports its output unavailable while the computer is away, and back on resume', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
    gateway.onMethod('pty.list', () => ({ sessions: [{ sessionId: 'sess-1', pid: 1, seq: -1 }] }))
    gateway.onMethod('pty.getBufferSince', () => ({ frames: [] }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'codex', resuming: false }
    })) as PtyHandle
    await handle.whenSpawned
    const seen: boolean[] = []
    handle.onAvailability?.((available) => seen.push(available))
    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    expect(seen).toEqual([false])
    connect(gateway, 'epoch-a')
    await vi.waitFor(() => expect(seen).toEqual([false, true]))
  })

  it('without the ack the hub keeps owning output (older computer)', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'codex', resuming: false }
    })) as PtyHandle
    await handle.whenSpawned
    expect(handle.ownsOutput).toBe(false)
  })

  it('reconnect replays what the computer detected while the hub was away, as one snapshot signal', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
    const detected = {
      activity: 'idle',
      title: 'Agent waiting',
      prompt: { type: 'permission', text: 'Allow? [Y/n]', position: 0 },
      devServerUrls: ['http://localhost:5173'],
      conversationId: 'conv-1',
      error: null
    }
    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', pid: 1, seq: 4, detection: true, detected }]
    }))
    gateway.onMethod('pty.getBufferSince', () => ({ frames: [] }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'codex', resuming: false }
    })) as PtyHandle
    await handle.whenSpawned
    const signals: unknown[] = []
    handle.onSignal?.((s) => signals.push(s))
    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    connect(gateway, 'epoch-a')
    await vi.waitFor(() =>
      expect(signals).toEqual([
        expect.objectContaining({
          snapshot: true,
          activity: 'idle',
          title: 'Agent waiting',
          prompt: detected.prompt,
          devServerUrls: ['http://localhost:5173'],
          conversationId: 'conv-1'
        })
      ])
    )
  })

  // Final review M1: a resume that failed before any output sent its exit error at
  // seq -1 (nothing emitted yet), and the hub dropped every signal at or below where
  // it took over detection (-1 for a fresh spawn) — the "session expired" overlay
  // never showed. An error is about the exit, not about output already detected.
  // Final review M2: past the carry window the hub sent no continuation at all, and
  // the recovery shell's output restarted at seq 0. The seq the session reached is
  // always sent with a continuing spawn.
  it('a continuing spawn always says where the session seqs reached', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const gateway = new FakeGateway()
      gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
      const backend = createRoutingPtyBackend({
        gateway,
        resolveComputerId: (spec) => spec.computerId ?? null
      })
      connect(gateway, 'epoch-a')
      const first = (await backend.spawn(ptySpec())) as PtyHandle
      await first.whenSpawned
      for (let seq = 0; seq <= 5; seq++)
        gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq, data: 'x' })
      gateway.emit('pty.exit', {
        computerId: 'computer-1',
        sessionId: 'sess-1',
        exitCode: 1
      } as never)
      // The computer's carry window is long over (its tombstone is gone).
      vi.advanceTimersByTime(10 * 60_000)
      const second = (await backend.spawn({
        ...ptySpec(),
        carryOutput: { preamble: '[recovered]' }
      })) as PtyHandle
      const spawns = gateway.requestsOf('pty.spawn')
      expect((spawns.at(-1)?.params as { carryOutput?: unknown } | undefined)?.carryOutput).toEqual(
        expect.objectContaining({ preamble: '[recovered]', afterSeq: 5 })
      )
      void second
    } finally {
      vi.useRealTimers()
    }
  })

  it('an exit error before any output (seq -1) reaches the hub', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1, detection: true }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn({
      ...ptySpec(),
      detection: { mode: 'claude-code', resuming: true }
    })) as PtyHandle
    await handle.whenSpawned
    const signals: Array<{ error: unknown }> = []
    handle.onSignal?.((s) => signals.push(s as never))
    const error = { code: 'SESSION_NOT_FOUND', message: 'Session not found', recoverable: false }
    gateway.emit('event', {
      computerId: 'computer-1',
      name: PTY_SIGNAL_EVENT_NAME,
      payload: {
        sessionId: 'sess-1',
        seq: -1,
        activity: null,
        refreshIdleClock: false,
        preview: '',
        error,
        suppressOutput: false,
        prompt: null,
        title: null,
        devServerUrls: [],
        conversationId: null
      }
    } as never)
    expect(signals).toEqual([expect.objectContaining({ error })])
  })

  it('reconnect with the same epoch ends the sessions the computer no longer holds', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({ sessions: [] }))
    const { exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-a')

    // Absent from the computer's own list ⇒ it really did exit while we were away.
    await vi.waitFor(() =>
      expect(exit()).toEqual({
        exitCode: 1,
        signal: undefined,
        reason: 'exited-while-detached'
      })
    )
  })

  it('reconnect as a DIFFERENT process ends every detached session without asking', async () => {
    const gateway = new FakeGateway()
    const { exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-b') // computer restarted

    await vi.waitFor(() =>
      expect(exit()).toEqual({
        exitCode: 1,
        signal: undefined,
        reason: 'computer-restarted'
      })
    )
    // A new process provably holds nothing of ours — no point listing.
    expect(gateway.requestsOf('pty.list')).toHaveLength(0)
  })

  it('a computer that reports no epoch keeps the conservative pre-epoch behavior', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', pid: 1, seq: 0 }]
    }))
    const { exit } = await spawnDetached(gateway, undefined)

    connect(gateway, undefined)

    // Identity unverified ⇒ never reattach on it, even though the computer says
    // it still holds the session. Absence of an epoch is not a match.
    await vi.waitFor(() =>
      expect(exit()).toEqual({
        exitCode: 1,
        signal: undefined,
        reason: 'computer-restarted'
      })
    )
    expect(gateway.requestsOf('pty.list')).toHaveLength(0)
  })

  it('kills sessions the computer still holds that the hub no longer tracks', async () => {
    const gateway = new FakeGateway()
    // The computer reports one session the hub knows about and one it does not —
    // e.g. stranded by an earlier grace expiry. Nothing will ever attach to the
    // orphan again, so leaving it running would burn an agent against no task.
    gateway.onMethod('pty.list', () => ({
      sessions: [
        { sessionId: 'sess-1', pid: 1, seq: 0 },
        { sessionId: 'orphan-9', pid: 2, seq: 0 }
      ]
    }))
    await spawnDetached(gateway)

    connect(gateway, 'epoch-a')

    await vi.waitFor(() =>
      expect(gateway.requestsOf('pty.kill').map((c) => c.params)).toEqual([
        { sessionId: 'orphan-9' }
      ])
    )
  })

  it('drops sessions once the grace window expires with no reconnect', async () => {
    // The one time-based outcome, and deliberately the LAST resort: it bounds
    // the hub's own bookkeeping (a computer that never returns would otherwise
    // leak entries forever and hang its tasks in "reconnecting"). It is not a
    // claim that the agent died — nothing here can know that.
    vi.useFakeTimers()
    try {
      const gateway = new FakeGateway()
      const { exit } = await spawnDetached(gateway)

      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(exit()).toBeNull() // still inside the window

      await vi.advanceTimersByTimeAsync(60_001)
      expect(exit()).toEqual({
        exitCode: 1,
        signal: undefined,
        reason: 'reattach-timeout'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unanswerable list leaves sessions detached rather than guessing', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => {
      throw new Error('computer went away again mid-reattach')
    })
    const { exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(gateway.requestsOf('pty.list')).toHaveLength(1))
    expect(exit()).toBeNull()
  })

  it('an established session that exited while detached reports its REAL exit, not code 1', async () => {
    // The computer remembers what it reaped (a tombstone). Before tombstones a
    // session missing from the list could only be guessed at — code 1, which an
    // agent mode turns into a recovery shell for a process that exited cleanly.
    const gateway = new FakeGateway()
    const { exit } = await spawnDetached(gateway)
    const { spawnId } = requireCall(gateway, 'pty.spawn').params as {
      spawnId: string
    }
    gateway.onMethod('pty.list', () => ({
      sessions: [],
      exited: [{ sessionId: 'sess-1', spawnId, pid: 1, exitCode: 0, signal: null }]
    }))

    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 0, signal: undefined }))
  })

  // ── A spawn still in flight when the connection drops ───────────────────────
  //
  // 2026-10-23: a restart resumed ~35 agents at once, the hub stalled, the
  // computer's heartbeat gave up and dropped the socket — and every `pty.spawn`
  // still awaiting its reply was REJECTED by the rpc teardown and finalized as a
  // failed spawn. The computer had already started most of them; on reconnect the
  // hub no longer tracked them, so the reattach sweep killed them. A lost reply
  // is no more evidence than a lost socket: the spawn's outcome is UNKNOWN, and
  // the computer settles it on reconnect like any other detached session.

  /** Start a spawn whose reply never comes, then drop the connection under it. */
  const spawnInFlight = (
    gateway: FakeGateway,
    spec: PtySpawnSpec = ptySpec({ startupTimeoutMs: 10_000 })
  ): {
    handle: PtyHandle
    exit: () => PtyExitEvent | null
    confirmed: () => {
      pid: number | null
      ownsStartupDeadline?: boolean
    } | null
    spawnId: string
  } => {
    let rejectSpawn: (err: unknown) => void = noopReject
    gateway.onMethod(
      'pty.spawn',
      () =>
        new Promise((_, reject) => {
          rejectSpawn = reject
        })
    )
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = backend.spawn(spec) as PtyHandle
    let exit: PtyExitEvent | null = null
    let confirmed: {
      pid: number | null
      ownsStartupDeadline?: boolean
    } | null = null
    handle.onExit((e) => {
      exit = e
    })
    void handle.whenSpawned?.then(
      (c) => {
        confirmed = c
      },
      () => undefined
    )
    const { spawnId } = requireCall(gateway, 'pty.spawn').params as {
      spawnId: string
    }
    // The real teardown order: dispose() rejects pending requests (settling on a
    // later microtask), then `computer-disconnected` is emitted synchronously.
    rejectSpawn(new RpcDisposedError('computer-hub', 'socket-closed'))
    gateway.emit('computer-disconnected', {
      computerId: 'computer-1',
      reason: 'socket-closed'
    })
    return { handle, exit: () => exit, confirmed: () => confirmed, spawnId }
  }

  const noopReject = (): void => undefined
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('sends pty.spawn with an idempotency key, the startup deadline, and NO request timeout', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 5, startupDeadline: true }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })

    const handle = backend.spawn(ptySpec({ startupTimeoutMs: 10_000 })) as PtyHandle

    const call = requireCall(gateway, 'pty.spawn')
    expect(call.params).toMatchObject({
      sessionId: 'sess-1',
      startupTimeoutMs: 10_000
    })
    expect(typeof (call.params as { spawnId?: unknown }).spawnId).toBe('string')
    // Liveness is the heartbeat's job. A request timeout here turned a slow spawn
    // (a computer restoring dozens of sessions) into a refused one.
    expect(call.timeoutMs).toBe(0)
    // The computer acknowledged owning the deadline, so the hub must not run its own.
    await expect(handle.whenSpawned).resolves.toEqual({
      pid: 5,
      ownsStartupDeadline: true
    })
  })

  it('an agent spawn carries its admission lane; prioritize reaches the computer only until it starts', async () => {
    const gateway = new FakeGateway()
    let reply: (v: unknown) => void = () => undefined
    gateway.onMethod('pty.spawn', () => new Promise((r) => (reply = r)))
    gateway.onMethod('pty.prioritize', () => ({ ok: true, queued: true }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })

    const handle = backend.spawn(
      ptySpec({ startupTimeoutMs: 10_000, admission: 'background' })
    ) as PtyHandle
    expect(requireCall(gateway, 'pty.spawn').params).toMatchObject({
      admission: 'background'
    })

    // Still waiting for its slot on the computer: the reveal is forwarded.
    backend.prioritize?.('sess-1')
    await settle()
    expect(gateway.requestsOf('pty.prioritize').map((c) => c.params)).toMatchObject([
      { sessionId: 'sess-1' }
    ])

    // Started: nothing left to move up, so no more requests.
    reply({ pid: 7, startupDeadline: true })
    await handle.whenSpawned
    backend.prioritize?.('sess-1')
    await settle()
    expect(gateway.requestsOf('pty.prioritize')).toHaveLength(1)
  })

  it('probeBackgroundJobs asks the computer that owns the session', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    gateway.onMethod('pty.backgroundJobs', () => ({
      ok: true,
      supported: true,
      alive: ['j1']
    }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    const jobs = [
      { id: 'j1', kind: 'shell' as const, command: 'pnpm dev' },
      { id: 'j2', kind: 'monitor' as const, command: 'tail -f x' }
    ]
    // No session yet: nobody can tell.
    await expect(backend.probeBackgroundJobs?.('sess-1', jobs)).resolves.toBeNull()

    await (backend.spawn(ptySpec()) as PtyHandle).whenSpawned
    await expect(backend.probeBackgroundJobs?.('sess-1', jobs)).resolves.toEqual(['j1'])
    expect(requireCall(gateway, 'pty.backgroundJobs').params).toMatchObject({
      sessionId: 'sess-1',
      jobs
    })
  })

  it("doctor asks the task's computer about itself: node-pty, the shell, the binaries", async () => {
    const gateway = new FakeGateway()
    const facts = {
      ok: true,
      problems: [
        {
          check: 'spawn-helper executable',
          detail: 'not executable',
          fix: 'chmod +x h'
        }
      ],
      shellExists: true,
      binaries: [{ binary: 'claude', path: '/opt/bin/claude' }]
    }
    gateway.onMethod('pty.doctor', () => facts)
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => 'computer-1'
    })

    await expect(
      backend.doctor?.('computer-1', {
        shell: '/bin/zsh',
        binaries: ['claude']
      })
    ).resolves.toEqual({
      problems: facts.problems,
      shellExists: true,
      binaries: facts.binaries
    })
    const call = requireCall(gateway, 'pty.doctor')
    expect(call.computerId).toBe('computer-1')
    expect(call.params).toEqual({ shell: '/bin/zsh', binaries: ['claude'] })
  })

  it('doctor: old computer → null (can not tell); lost link → rejects', async () => {
    const gateway = new FakeGateway()
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => 'computer-1'
    })
    const ask = () => backend.doctor?.('computer-1', { shell: '/bin/zsh', binaries: [] })

    gateway.onMethod('pty.doctor', () => {
      throw new RpcError(ComputerTransportErrorCodes.unimplemented, 'unimplemented')
    })
    await expect(ask()).resolves.toBeNull()

    gateway.onMethod('pty.doctor', () => {
      throw new RpcDisposedError('gone')
    })
    await expect(ask()).rejects.toThrow()
  })

  it('cliVersion asks that computer; old computer → null; lost link → rejects', async () => {
    const gateway = new FakeGateway()
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => 'computer-1'
    })
    gateway.onMethod('pty.cliVersion', () => ({ ok: true, version: '0.167.0' }))
    await expect(backend.cliVersion?.('computer-1', 'codex')).resolves.toBe('0.167.0')
    const call = requireCall(gateway, 'pty.cliVersion')
    expect(call.computerId).toBe('computer-1')
    expect(call.params).toEqual({ binary: 'codex' })

    gateway.onMethod('pty.cliVersion', () => {
      throw new RpcError(ComputerTransportErrorCodes.unimplemented, 'unimplemented')
    })
    await expect(backend.cliVersion?.('computer-1', 'codex')).resolves.toBeNull()

    gateway.onMethod('pty.cliVersion', () => {
      throw new RpcDisposedError('gone')
    })
    await expect(backend.cliVersion?.('computer-1', 'codex')).rejects.toThrow()
  })

  it('probeBackgroundJobs: unsupported platform / old computer → null; lost link → rejects', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    await (backend.spawn(ptySpec()) as PtyHandle).whenSpawned
    const jobs = [{ id: 'j1', kind: 'shell' as const, command: null }]

    gateway.onMethod('pty.backgroundJobs', () => ({
      ok: true,
      supported: false,
      alive: []
    }))
    await expect(backend.probeBackgroundJobs?.('sess-1', jobs)).resolves.toBeNull()

    gateway.onMethod('pty.backgroundJobs', () => {
      throw new RpcError(ComputerTransportErrorCodes.unimplemented, 'unimplemented')
    })
    await expect(backend.probeBackgroundJobs?.('sess-1', jobs)).resolves.toBeNull()

    gateway.onMethod('pty.backgroundJobs', () => {
      throw new RpcDisposedError('gone')
    })
    await expect(backend.probeBackgroundJobs?.('sess-1', jobs)).rejects.toThrow()
  })

  it('a spawn without admission never asks the computer to prioritize', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => new Promise(() => undefined))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    backend.spawn(ptySpec())
    expect(requireCall(gateway, 'pty.spawn').params).not.toHaveProperty('admission')
    backend.prioritize?.('sess-1')
    await settle()
    expect(gateway.requestsOf('pty.prioritize')).toEqual([])
  })

  it('warmSpawn has NO request timeout — the computer boots warm agents only once agent starts are over', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.warmSpawn', () => ({ pid: 9 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    await backend.warmSpawn?.('computer-1', {
      warmId: 'warm:1',
      command: 'zsh',
      args: [],
      cwd: '/tmp',
      env: {}
    })
    expect(requireCall(gateway, 'pty.warmSpawn').timeoutMs).toBe(0)
  })

  it('a computer that does not acknowledge the deadline leaves it to the hub', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 5 })) // pre-deadline computer
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })

    const handle = backend.spawn(ptySpec({ startupTimeoutMs: 10_000 })) as PtyHandle

    await expect(handle.whenSpawned).resolves.toEqual({
      pid: 5,
      ownsStartupDeadline: false
    })
  })

  it('a spawn in flight when the socket drops is NOT declared dead', async () => {
    const gateway = new FakeGateway()
    const { exit, confirmed } = spawnInFlight(gateway)

    await settle()

    expect(exit()).toBeNull()
    expect(confirmed()).toBeNull() // still unknown — neither confirmed nor refused
  })

  it('reconnect resolves the in-flight spawn when the computer holds it — and does not kill it', async () => {
    const gateway = new FakeGateway()
    const { handle, exit, confirmed, spawnId } = spawnInFlight(gateway)
    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', spawnId, pid: 42, seq: -1 }]
    }))

    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(confirmed()).toEqual({ pid: 42, ownsStartupDeadline: true }))
    expect(handle.pid).toBe(42)
    expect(exit()).toBeNull()
    // The exact failure of 2026-10-23: the computer still held the agent the hub
    // had given up on, and the reattach sweep killed it as an orphan.
    expect(gateway.requestsOf('pty.kill')).toHaveLength(0)
    expect(gateway.requestsOf('pty.spawn')).toHaveLength(1)
  })

  it('reconnect re-sends the SAME spawn when the computer never received it', async () => {
    const gateway = new FakeGateway()
    const { exit, confirmed, spawnId } = spawnInFlight(gateway)
    gateway.onMethod('pty.list', () => ({ sessions: [], exited: [] }))

    gateway.onMethod('pty.spawn', () => ({ pid: 7, startupDeadline: true }))
    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(confirmed()).toEqual({ pid: 7, ownsStartupDeadline: true }))
    const spawns = gateway.requestsOf('pty.spawn')
    expect(spawns).toHaveLength(2)
    // Same idempotency key: if the first one did land after all, the computer
    // answers with the process it already started instead of starting another.
    expect((spawns[1]!.params as { spawnId: string }).spawnId).toBe(spawnId)
    expect(spawns[1]!.timeoutMs).toBe(0)
    expect(exit()).toBeNull()
  })

  it('a spawn that ran and exited while detached reports its real exit and trailing output', async () => {
    const gateway = new FakeGateway()
    const { handle, exit, confirmed, spawnId } = spawnInFlight(gateway)
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    gateway.onMethod('pty.list', () => ({
      sessions: [],
      exited: [
        {
          sessionId: 'sess-1',
          spawnId,
          pid: 9,
          exitCode: 3,
          signal: null,
          reason: undefined
        }
      ]
    }))
    gateway.onMethod('pty.getBufferSince', () => ({
      frames: [{ seq: 0, data: 'bye' }]
    }))

    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 3, signal: undefined }))
    // Output the computer kept with the tombstone lands BEFORE the exit.
    expect(chunks).toEqual(['bye'])
    // Confirmed with the pid it ran under, so nothing downstream reads the spawn
    // as refused and overwrites the real exit with a synthetic one.
    expect(confirmed()).toEqual({ pid: 9, ownsStartupDeadline: true })
    expect(gateway.requestsOf('pty.spawn')).toHaveLength(1)
  })

  it('an in-flight spawn on a computer that RESTARTED ends as computer-restarted', async () => {
    const gateway = new FakeGateway()
    const { exit } = spawnInFlight(gateway)

    connect(gateway, 'epoch-b')

    await vi.waitFor(() =>
      expect(exit()).toEqual({
        exitCode: 1,
        signal: undefined,
        reason: 'computer-restarted'
      })
    )
    expect(gateway.requestsOf('pty.spawn')).toHaveLength(1)
  })

  it('a spawn sent while the computer is unreachable waits for it instead of failing', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    connect(gateway, 'epoch-a')
    gateway.emit('computer-disconnected', {
      computerId: 'computer-1',
      reason: 'socket-closed'
    })

    // The gateway refuses a request to a computer it has no socket for.
    gateway.onMethod('pty.spawn', () => {
      throw new RpcError(
        ComputerTransportErrorCodes.unknownComputer,
        "computer 'computer-1' is not connected"
      )
    })
    const handle = backend.spawn(ptySpec()) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })
    await settle()
    expect(exit).toBeNull()

    gateway.onMethod('pty.list', () => ({ sessions: [], exited: [] }))
    gateway.onMethod('pty.spawn', () => ({ pid: 11 }))
    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(handle.pid).toBe(11))
    expect(exit).toBeNull()
  })

  it('a spawn sent before the computer ever connected is started on its first hello', async () => {
    // A restarted app opens its task before the local computer's first hello: the
    // spawn waits for it. With no earlier connection this hub saw, nothing can have
    // reached a previous process, so this is no "reconnected as a different
    // process" (which killed it: e2e terminal/108, exit 1 computer-restarted).
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => {
      throw new RpcError(
        ComputerTransportErrorCodes.unknownComputer,
        "computer 'computer-1' is not connected"
      )
    })
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    const handle = backend.spawn(ptySpec()) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })
    await settle()
    expect(exit).toBeNull()

    gateway.onMethod('pty.list', () => ({ sessions: [], exited: [] }))
    gateway.onMethod('pty.spawn', () => ({ pid: 12 }))
    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(handle.pid).toBe(12))
    expect(exit).toBeNull()
  })

  it('a REAL refusal from the computer still fails the spawn', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => {
      throw new RpcError(-32603, 'project proj-1 is not checked out on this computer')
    })
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    connect(gateway, 'epoch-a')

    const handle = backend.spawn(ptySpec()) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })

    // The computer answered: this IS a verdict, unlike a lost reply. Its words
    // ride along — "couldn't start the agent" alone names no cause.
    await expect(handle.whenSpawned).rejects.toThrow(/not checked out/)
    expect(exit).toEqual({
      exitCode: 1,
      signal: undefined,
      reason: 'spawn-failed',
      detail: 'project proj-1 is not checked out on this computer'
    })
  })

  // The fix is choosing the project's folder on that computer, so the session says
  // that, not "the computer couldn't start the agent".
  it('a project with no folder on the computer ends with reason project-not-placed', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => {
      throw projectNotPlacedError('proj-1')
    })
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    connect(gateway, 'epoch-a')

    const handle = backend.spawn(ptySpec()) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })

    await expect(handle.whenSpawned).rejects.toThrow(/no folder for project proj-1/)
    expect(exit).toMatchObject({ reason: 'project-not-placed' })
  })

  it('a session closed while detached is never re-spawned or resumed', async () => {
    const gateway = new FakeGateway()
    const { handle, spawnId } = spawnInFlight(gateway)

    // The user closed the tab while the computer was unreachable.
    handle.kill()

    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', spawnId, pid: 42, seq: -1 }]
    }))
    connect(gateway, 'epoch-a')

    // The hub stopped tracking it, so the computer's copy is an orphan — killed
    // by the sweep, exactly like any other session nothing will attach to again.
    await vi.waitFor(() =>
      expect(gateway.requestsOf('pty.kill').map((c) => c.params)).toContainEqual({
        sessionId: 'sess-1'
      })
    )
    expect(gateway.requestsOf('pty.spawn')).toHaveLength(1)
  })

  it('a session closed while detached is not re-sent when the computer never got it', async () => {
    const gateway = new FakeGateway()
    const { handle } = spawnInFlight(gateway)
    handle.kill()

    gateway.onMethod('pty.list', () => ({ sessions: [], exited: [] }))
    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(gateway.requestsOf('pty.list')).toHaveLength(1))
    await settle()
    expect(gateway.requestsOf('pty.spawn')).toHaveLength(1)
  })

  it('a pre-tombstone computer listing the session reattaches it, without a deadline claim', async () => {
    // Old computers send no spawnId and keep no tombstones. Present is still the
    // strongest evidence available, so it reattaches as before; the hub keeps its
    // own startup deadline because nothing on the other end owns one.
    const gateway = new FakeGateway()
    const { confirmed } = spawnInFlight(gateway)
    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', pid: 42, seq: -1 }]
    }))

    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(confirmed()).toEqual({ pid: 42, ownsStartupDeadline: false }))
  })

  it('a listed session from a DIFFERENT spawn attempt is not mistaken for this one', async () => {
    // Session ids repeat (an agent tab reuses its id on every restart). A live
    // session under the same id but another spawnId is an older process, not ours.
    const gateway = new FakeGateway()
    const { confirmed, spawnId } = spawnInFlight(gateway)
    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', spawnId: `${spawnId}-older`, pid: 41, seq: 5 }],
      exited: []
    }))
    gateway.onMethod('pty.spawn', () => ({ pid: 43, startupDeadline: true }))

    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(confirmed()).toEqual({ pid: 43, ownsStartupDeadline: true }))
    expect((gateway.requestsOf('pty.spawn')[1]!.params as { spawnId: string }).spawnId).toBe(
      spawnId
    )
    // The re-sent spawn replaces the older process on the computer. A sweep kill
    // for that id would land AFTER the new spawn and end the session it started.
    expect(gateway.requestsOf('pty.kill')).toHaveLength(0)
  })

  it('an older attempt still running under a reused id is ended once this one settles as exited', async () => {
    // Ours exited (tombstone); a different attempt's process holds the same id.
    // Nothing tracks that process, so it is an orphan like any other.
    const gateway = new FakeGateway()
    const { exit, spawnId } = spawnInFlight(gateway)
    gateway.onMethod('pty.list', () => ({
      sessions: [{ sessionId: 'sess-1', spawnId: `${spawnId}-older`, pid: 41, seq: 5 }],
      exited: [{ sessionId: 'sess-1', spawnId, pid: 9, exitCode: 0, signal: null }]
    }))

    connect(gateway, 'epoch-a')

    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 0, signal: undefined }))
    expect(gateway.requestsOf('pty.kill').map((c) => c.params)).toEqual([{ sessionId: 'sess-1' }])
  })

  it('a startup-timeout exit from the computer carries its reason', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 5, startupDeadline: true }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (s) => s.computerId ?? null
    })
    const handle = backend.spawn(ptySpec({ startupTimeoutMs: 10_000 })) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('pty.exit', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      exitCode: 0,
      signal: '9',
      reason: 'startup-timeout'
    })

    expect(exit).toEqual({
      exitCode: 0,
      signal: undefined,
      reason: 'startup-timeout'
    })
  })
})

// ===========================================================================
// Routing process backend
// ===========================================================================

describe('createRoutingProcessBackend', () => {
  it('throws NoComputerAvailableError when no computer resolves', () => {
    const gateway = new FakeGateway()
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: () => null
    })

    expect(() => backend.spawn(procSpec({ computerId: null }))).toThrow(NoComputerAvailableError)
    expect(gateway.calls).toHaveLength(0)
  })

  it('a background process asks its computer to sweep its group on exit, and reads stats from it', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 555 }))
    gateway.onMethod('proc.stats', () => ({
      stats: { 'proc-1': { cpu: 1.5, rss: 2048, title: 'node' } }
    }))
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    backend.spawn(procSpec())
    expect(requireCall(gateway, 'proc.spawn').params).toMatchObject({ reapGroupOnExit: true })
    expect(await backend.stats?.(['proc-1', 'unknown'])).toEqual({
      'proc-1': { cpu: 1.5, rss: 2048, title: 'node' }
    })
    expect(requireCall(gateway, 'proc.stats')).toMatchObject({
      computerId: 'computer-1',
      params: { sessionIds: ['proc-1'] }
    })
  })

  it('lists the runs a computer holds that this hub does not track, and ends one there', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 555 }))
    gateway.onMethod('proc.list', () => ({
      sessions: [
        { sessionId: 'proc-1', pid: 555, seq: 0 },
        { sessionId: 'left-by-old-hub', pid: 777, seq: 4 }
      ],
      exited: []
    }))
    gateway.onMethod('proc.kill', () => ({ ok: true }))
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    backend.spawn(procSpec())
    expect(await backend.listSessions?.('computer-1')).toEqual([
      { sessionId: 'left-by-old-hub', pid: 777 }
    ])
    await backend.killSession?.('computer-1', 'left-by-old-hub')
    expect(requireCall(gateway, 'proc.kill')).toMatchObject({
      computerId: 'computer-1',
      params: { sessionId: 'left-by-old-hub' }
    })
  })

  it('remote: forwards proc.spawn, delivers proc.data in order, kill frame, exit cleanup', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 555 }))
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })

    const handle = backend.spawn(procSpec())
    const chunks: string[] = []
    let exit: { code: number | null; signal: string | null } | null = null
    handle.onData((chunk) => chunks.push(chunk))
    handle.onExit((e) => {
      exit = e
    })

    expect(requireCall(gateway, 'proc.spawn')).toMatchObject({
      computerId: 'computer-1',
      params: { sessionId: 'proc-1', command: 'git status', cwd: '/repo' }
    })
    await vi.waitFor(() => expect(handle.pid).toBe(555))

    gateway.emit('proc.data', {
      computerId: 'computer-1',
      sessionId: 'proc-1',
      data: 'one'
    })
    gateway.emit('proc.data', {
      computerId: 'computer-1',
      sessionId: 'proc-1',
      data: 'two',
      stream: 'stderr'
    })
    expect(chunks).toEqual(['one', 'two'])

    handle.kill('SIGKILL')
    expect(requireCall(gateway, 'proc.kill').params).toEqual({
      sessionId: 'proc-1',
      // The attempt it is meant for, so it can never hit a replacement.
      spawnId: (requireCall(gateway, 'proc.spawn').params as { spawnId: string }).spawnId,
      signal: 'SIGKILL'
    })

    gateway.emit('proc.exit', {
      computerId: 'computer-1',
      sessionId: 'proc-1',
      exitCode: 1,
      signal: null
    })
    expect(exit).toEqual({ code: 1, signal: null })

    gateway.emit('proc.data', {
      computerId: 'computer-1',
      sessionId: 'proc-1',
      data: 'after-exit'
    })
    expect(chunks).toEqual(['one', 'two'])
  })

  // Routed child processes (which the chat agents ride on) detach and reattach
  // on exactly the same rule as ptys — same controller, `proc.list` instead of
  // `pty.list`. Previously a dropped socket finalized these too, which is why
  // one sleep killed both the terminals and the chat agents on a machine.
  const connectProc = (gateway: FakeGateway, epoch?: string): void => {
    gateway.emit('computer-connected', {
      computer: {
        computerId: 'computer-1',
        authMode: 'hello',
        directAddress: null,
        peerLoopback: false,
        directRtc: false,
        connectedAt: 0,
        lastSeenAt: 0,
        ...(epoch === undefined ? {} : { epoch })
      }
    })
  }

  const spawnDetachedProc = (
    gateway: FakeGateway
  ): { exit: () => { code: number | null; signal: string | null } | null } => {
    gateway.onMethod('proc.spawn', () => ({ pid: 1 }))
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connectProc(gateway, 'epoch-a')
    const handle = backend.spawn(procSpec())
    let exit: { code: number | null; signal: string | null } | null = null
    handle.onExit((e) => {
      exit = e
    })
    gateway.emit('computer-lost', {
      computerId: 'computer-1',
      reason: 'heartbeat-timeout'
    })
    return { exit: () => exit }
  }

  // After a hub restart the process manager adopts the runs a computer kept (they
  // show orphaned, Stop reaches them by session) — with no handle, so this backend
  // does not track them. A network blip and same-epoch reconnect then swept them as
  // strays: the dev server was killed silently. Adopted runs are kept; a stray is not.
  it('a reconnect keeps runs the process manager adopted, and still ends a stray', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 1 }))
    gateway.onMethod('proc.kill', () => ({ ok: true, clean: true }))
    gateway.onMethod('proc.list', () => ({
      sessions: [
        { sessionId: 'proc-1', pid: 1, seq: 0 },
        { sessionId: 'adopted-dev-server', pid: 7, seq: 3 },
        { sessionId: 'stray', pid: 8, seq: 0 }
      ]
    }))
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null,
      keepUntracked: (computerId, sessionId) =>
        computerId === 'computer-1' && sessionId === 'adopted-dev-server'
    })
    connectProc(gateway, 'epoch-a')
    backend.spawn(procSpec())
    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    connectProc(gateway, 'epoch-a')
    await vi.waitFor(() => expect(gateway.requestsOf('proc.kill')).toHaveLength(1))
    expect(gateway.requestsOf('proc.kill').map((c) => c.params)).toEqual([{ sessionId: 'stray' }])
  })

  it('computer-lost detaches the process rather than declaring it dead', () => {
    const gateway = new FakeGateway()
    expect(spawnDetachedProc(gateway).exit()).toBeNull()
  })

  it('reconnect with the same epoch resumes a process the computer still holds', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.list', () => ({
      sessions: [{ sessionId: 'proc-1', pid: 1, seq: 0 }]
    }))
    const { exit } = spawnDetachedProc(gateway)

    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() => expect(gateway.requestsOf('proc.list')).toHaveLength(1))
    expect(exit()).toBeNull()
  })

  it('many backends on one gateway share a single reattach round-trip', async () => {
    // createRoutingChatBackend builds a FRESH process backend per agent spawn.
    // One detach controller per backend would mean a listener set per agent
    // (unbounded over a session) and one proc.list per agent on every
    // reconnect. Controllers are keyed by (gateway, kind) instead.
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 1 }))
    gateway.onMethod('proc.list', () => ({
      sessions: [
        { sessionId: 'proc-1', pid: 1, seq: 0 },
        { sessionId: 'proc-2', pid: 2, seq: 0 }
      ]
    }))
    connectProc(gateway, 'epoch-a')

    const exits: Array<{ code: number | null; signal: string | null } | null> = [null, null]
    for (const [i, id] of ['proc-1', 'proc-2'].entries()) {
      const backend = createRoutingProcessBackend({
        gateway,
        resolveComputerId: (spec) => spec.computerId ?? null
      })
      backend.spawn(procSpec({ id })).onExit((e) => {
        exits[i] = e
      })
    }

    gateway.emit('computer-lost', {
      computerId: 'computer-1',
      reason: 'heartbeat-timeout'
    })
    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() => expect(gateway.requestsOf('proc.list')).toHaveLength(1))
    expect(exits).toEqual([null, null]) // both resumed, neither declared dead
  })

  it('reconnect with the same epoch ends a process the computer no longer holds', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.list', () => ({ sessions: [] }))
    const { exit } = spawnDetachedProc(gateway)

    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() => expect(exit()).toEqual({ code: null, signal: 'exited-while-detached' }))
  })

  // Same rule as the pty backend: a proc.spawn whose reply was lost to a dropped
  // socket is UNKNOWN, not failed. Chat agents ride this path, so before this a
  // restart storm killed them exactly the way it killed terminal agents.
  const spawnProcInFlight = (
    gateway: FakeGateway
  ): {
    handle: ProcHandle
    exit: () => { code: number | null; signal: string | null } | null
    spawnId: string
  } => {
    let rejectSpawn: (err: unknown) => void = () => undefined
    gateway.onMethod(
      'proc.spawn',
      () =>
        new Promise((_, reject) => {
          rejectSpawn = reject
        })
    )
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connectProc(gateway, 'epoch-a')
    const handle = backend.spawn(procSpec())
    let exit: { code: number | null; signal: string | null } | null = null
    handle.onExit((e) => {
      exit = e
    })
    const { spawnId } = requireCall(gateway, 'proc.spawn').params as {
      spawnId: string
    }
    rejectSpawn(new RpcDisposedError('computer-hub', 'socket-closed'))
    gateway.emit('computer-disconnected', {
      computerId: 'computer-1',
      reason: 'socket-closed'
    })
    return { handle, exit: () => exit, spawnId }
  }

  it('sends proc.spawn with an idempotency key and no request timeout', () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 1 }))
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })

    backend.spawn(procSpec())

    const call = requireCall(gateway, 'proc.spawn')
    expect(typeof (call.params as { spawnId?: unknown }).spawnId).toBe('string')
    expect(call.timeoutMs).toBe(0)
  })

  it('an in-flight proc.spawn survives the socket dropping and resumes on reconnect', async () => {
    const gateway = new FakeGateway()
    const { handle, exit, spawnId } = spawnProcInFlight(gateway)
    await new Promise((r) => setTimeout(r, 0))
    expect(exit()).toBeNull()

    gateway.onMethod('proc.list', () => ({
      sessions: [{ sessionId: 'proc-1', spawnId, pid: 77, seq: -1 }],
      exited: []
    }))
    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() => expect(handle.pid).toBe(77))
    expect(exit()).toBeNull()
    expect(gateway.requestsOf('proc.kill')).toHaveLength(0)
    expect(gateway.requestsOf('proc.spawn')).toHaveLength(1)
  })

  it('an in-flight proc.spawn the computer never received is re-sent with the same key', async () => {
    const gateway = new FakeGateway()
    const { handle, spawnId } = spawnProcInFlight(gateway)
    gateway.onMethod('proc.list', () => ({ sessions: [], exited: [] }))
    gateway.onMethod('proc.spawn', () => ({ pid: 78 }))

    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() => expect(handle.pid).toBe(78))
    const spawns = gateway.requestsOf('proc.spawn')
    expect(spawns).toHaveLength(2)
    expect((spawns[1]!.params as { spawnId: string }).spawnId).toBe(spawnId)
  })

  it('a process that exited while detached reports its real exit', async () => {
    const gateway = new FakeGateway()
    const { exit, spawnId } = spawnProcInFlight(gateway)
    gateway.onMethod('proc.list', () => ({
      sessions: [],
      exited: [{ sessionId: 'proc-1', spawnId, pid: 79, exitCode: 0, signal: null }]
    }))

    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() => expect(exit()).toEqual({ code: 0, signal: null }))
    expect(gateway.requestsOf('proc.spawn')).toHaveLength(1)
  })

  it('a real proc.spawn refusal still ends the process', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => {
      throw new RpcError(-32603, 'path outside allowed roots')
    })
    const backend = createRoutingProcessBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId ?? null
    })
    connectProc(gateway, 'epoch-a')
    let exit: { code: number | null; signal: string | null } | null = null
    backend.spawn(procSpec()).onExit((e) => {
      exit = e
    })

    // The computer's reason travels with the exit, so the process log can say why.
    await vi.waitFor(() =>
      expect(exit).toEqual({
        code: null,
        signal: 'spawn-failed',
        detail: 'path outside allowed roots'
      })
    )
  })
})

// ===========================================================================
// Remote worktree adapters
// ===========================================================================

function makeLocalWorktrees(over: Partial<WorktreeExecAdapters> = {}): WorktreeExecAdapters {
  return {
    createWorktree: vi.fn(async () => ({ computerId: null })),
    removeWorktree: vi.fn(async () => ({})),
    runWorktreeSetupScript: vi.fn(async () => ({ ran: false })),
    copyIgnoredFiles: vi.fn(async () => {}),
    getCurrentBranch: vi.fn(async () => null),
    isGitRepo: vi.fn(async () => false),
    getWorktreeColor: vi.fn(() => '#abcdef'),
    ensureProjectWorktreeColors: vi.fn(
      async () => new Map([['/wt', '#abcdef']]) as ReadonlyMap<string, string>
    ),
    pathExists: vi.fn(async () => false),
    hubPathExists: vi.fn(() => false),
    removeArtifactDir: vi.fn(async () => {}),
    ...over
  }
}

/** Any task id: the local adapters ignore it; the routing ones resolve a computer from it. */
const TASK = 'task-1'

describe('createRemoteWorktreeAdapters', () => {
  // A task's auto-worktree runs its setup script on the computer (5 min there);
  // at the gateway's 30 s default the hub reported auto_worktree_setup_failed while
  // the script kept running (a retry then hit a duplicate worktree).
  it('every step carries an explicit timeout; create / setup / copy / remove get minutes', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('git.isGitRepo', () => ({ isGitRepo: true }))
    gateway.onMethod('git.getCurrentBranch', () => ({ branch: 'main' }))
    gateway.onMethod('git.removeWorktree', () => ({ branchDeleted: true }))
    gateway.onMethod('git.runWorktreeSetupScript', () => ({ ran: true, success: true, output: '' }))
    gateway.onMethod('fs.pathExists', () => ({ exists: true }))
    const adapters = createRemoteWorktreeAdapters({
      gateway,
      local: makeLocalWorktrees(),
      resolveComputerId: () => 'computer-1'
    })
    await adapters.isGitRepo(TASK, '/repo')
    await adapters.getCurrentBranch(TASK, '/repo')
    await adapters.pathExists(TASK, '/wt')
    await adapters.createWorktree(TASK, '/repo', '/wt', 'feature', 'main')
    await adapters.runWorktreeSetupScript(TASK, '/wt', '/repo', 'main')
    await adapters.copyIgnoredFiles(TASK, '/repo', '/wt', 'none' as never, [])
    await adapters.removeWorktree(TASK, '/proj', '/wt')
    for (const call of gateway.calls) {
      expect(call.timeoutMs, `${call.method}: explicit`).toBeGreaterThan(30_000)
    }
    for (const method of [
      'git.createWorktree',
      'git.runWorktreeSetupScript',
      'git.copyIgnoredFiles',
      'git.removeWorktree'
    ]) {
      expect(requireCall(gateway, method).timeoutMs, method).toBeGreaterThan(5 * 60_000)
    }
  })

  // Trash purge, no-login multi-computer hub: an unbound task's computer is the
  // default NOW; its worktree stays on the computer that made it. Create answers
  // that computer (the hub records it), removal goes to the worktree's computer.
  it('create answers its computer; remove goes to the computer holding the worktree', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('git.removeWorktree', () => ({}))
    const adapters = createRemoteWorktreeAdapters({
      gateway,
      local: makeLocalWorktrees(),
      resolveComputerId: () => 'default-now',
      resolveWorktreeComputerId: () => 'made-it'
    })
    expect(await adapters.createWorktree(TASK, '/repo', '/wt', 'b')).toEqual({
      computerId: 'default-now'
    })
    await adapters.removeWorktree(TASK, '/proj', '/wt')
    expect(requireCall(gateway, 'git.removeWorktree').computerId).toBe('made-it')
  })

  it('forwards git/fs ops to the right frames and parses the computer replies', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('git.isGitRepo', () => ({ isGitRepo: true }))
    gateway.onMethod('git.getCurrentBranch', () => ({ branch: 'main' }))
    gateway.onMethod('git.createWorktree', () => ({}))
    gateway.onMethod('git.removeWorktree', () => ({ branchDeleted: true }))
    gateway.onMethod('git.runWorktreeSetupScript', () => ({
      ran: true,
      success: true,
      output: 'ok'
    }))
    gateway.onMethod('git.copyIgnoredFiles', () => ({}))
    gateway.onMethod('fs.pathExists', () => ({ exists: true }))
    gateway.onMethod('fs.removeDir', () => ({}))
    const local = makeLocalWorktrees()
    const adapters = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveComputerId: () => 'computer-1'
    })

    expect(await adapters.isGitRepo(TASK, '/repo')).toBe(true)
    expect(requireCall(gateway, 'git.isGitRepo').params).toEqual({
      path: '/repo'
    })

    expect(await adapters.getCurrentBranch(TASK, '/repo')).toBe('main')
    expect(requireCall(gateway, 'git.getCurrentBranch').params).toEqual({
      repoPath: '/repo'
    })

    await adapters.createWorktree(TASK, '/repo', '/wt', 'feature', 'main')
    expect(requireCall(gateway, 'git.createWorktree').params).toEqual({
      repoPath: '/repo',
      worktreePath: '/wt',
      branch: 'feature',
      sourceBranch: 'main'
    })

    expect(await adapters.removeWorktree(TASK, '/proj', '/wt')).toEqual({
      branchDeleted: true
    })
    expect(requireCall(gateway, 'git.removeWorktree').params).toEqual({
      projectPath: '/proj',
      worktreePath: '/wt'
    })

    expect(await adapters.runWorktreeSetupScript(TASK, '/wt', '/repo', null)).toEqual({
      ran: true,
      success: true,
      output: 'ok'
    })
    expect(requireCall(gateway, 'git.runWorktreeSetupScript').params).toEqual({
      worktreePath: '/wt',
      repoPath: '/repo',
      sourceBranch: null
    })

    await adapters.copyIgnoredFiles(TASK, '/repo', '/wt', 'custom', ['.env'])
    expect(requireCall(gateway, 'git.copyIgnoredFiles').params).toEqual({
      repoPath: '/repo',
      worktreePath: '/wt',
      behavior: 'custom',
      customPaths: ['.env']
    })

    expect(await adapters.pathExists(TASK, '/some/path')).toBe(true)
    expect(requireCall(gateway, 'fs.pathExists').params).toEqual({
      path: '/some/path'
    })

    // Artifact dirs live in the HUB's own storage, so they are served locally and
    // never cross the wire — routing them would have made archiving a task
    // impossible with no computer connected.
    await adapters.removeArtifactDir('/artifacts/x')
    expect(gateway.requestsOf('fs.removeDir')).toHaveLength(0)
    expect(local.removeArtifactDir).toHaveBeenCalledWith('/artifacts/x')

    // git/fs work never touched the local adapters.
    expect(local.isGitRepo).not.toHaveBeenCalled()
    expect(local.createWorktree).not.toHaveBeenCalled()
    expect(local.pathExists).not.toHaveBeenCalled()
  })

  it('keeps getWorktreeColor + ensureProjectWorktreeColors local (never over the wire)', async () => {
    const gateway = new FakeGateway()
    const local = makeLocalWorktrees()
    const adapters = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveComputerId: () => 'computer-1'
    })

    expect(adapters.getWorktreeColor('/proj', '/wt')).toBe('#abcdef')
    expect(local.getWorktreeColor).toHaveBeenCalledWith('/proj', '/wt')

    expect(await adapters.ensureProjectWorktreeColors('/proj')).toEqual(
      new Map([['/wt', '#abcdef']])
    )
    expect(local.ensureProjectWorktreeColors).toHaveBeenCalledWith('/proj')

    expect(gateway.calls).toHaveLength(0)
  })

  it('throws for every WORKSPACE method, but keeps hub-owned ops working', async () => {
    const gateway = new FakeGateway()
    const local = makeLocalWorktrees()
    const adapters = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveComputerId: () => null
    })

    // Workspace work must land on the same machine as the agent that will use it,
    // so "no computer" cannot silently mean "do it on the hub".
    await expect(adapters.isGitRepo(TASK, '/repo')).rejects.toThrow(NoComputerAvailableError)
    await expect(adapters.pathExists(TASK, '/x')).rejects.toThrow(NoComputerAvailableError)
    await expect(adapters.createWorktree(TASK, '/r', '/wt', 'b')).rejects.toThrow(
      NoComputerAvailableError
    )

    // …while the hub-owned ops keep working with zero computers — archiving a task
    // and rendering the task list must not require one (docs/exec-boundary.md).
    expect(await adapters.hubPathExists('/storage/artifacts/x')).toBe(false)
    await adapters.removeArtifactDir('/storage/artifacts/x')
    expect(adapters.getWorktreeColor('/proj', '/wt')).toBe('#abcdef')

    expect(gateway.calls).toHaveLength(0)
  })

  it('serves the color ops locally even with no computer (hub-local UI state)', async () => {
    const gateway = new FakeGateway()
    const local = makeLocalWorktrees()
    const adapters = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveComputerId: () => null
    })

    // The documented exception to the invariant: colors are hub-local UI state and
    // `getWorktreeColor` is sync, so it could never be a network call.
    expect(adapters.getWorktreeColor('/proj', '/wt')).toBe('#abcdef')
    expect(await adapters.ensureProjectWorktreeColors('/proj')).toEqual(
      new Map([['/wt', '#abcdef']])
    )
    expect(gateway.calls).toHaveLength(0)
  })
})

// ===========================================================================
// Computer-OFF / no-computer fall-through
//
// The composition wires these routing backends unconditionally (always-on),
// but with no computer registered `resolveTaskComputerId` returns null, so the
// spec's computerId is null and EVERY spawn must route to the in-process local
// backend WITHOUT any gateway contact — byte-identical to computer-OFF. This
// pins that guarantee across all three backends against a gateway whose
// `request` throws (so any accidental routing is a hard failure).
// ===========================================================================

describe('no-computer: every exec kind fails loudly, nothing reaches the gateway', () => {
  class ExplodingGateway extends FakeGateway {
    override request<T = unknown>(
      _computerId: string,
      method: string,
      _params?: unknown
    ): Promise<T> {
      throw new Error(`a no-computer spawn must never reach the gateway (got ${method})`)
    }
  }

  it('pty/proc/worktree all throw NoComputerAvailableError', async () => {
    const gateway = new ExplodingGateway()

    // The invariant in one place: with no computer there is nowhere to run, and the
    // hub must not quietly become the execution host.
    const pty = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => null
    })
    expect(() => pty.spawn(ptySpec({ computerId: null }))).toThrow(NoComputerAvailableError)

    const proc = createRoutingProcessBackend({
      gateway,
      resolveComputerId: () => null
    })
    expect(() => proc.spawn(procSpec({ computerId: null }))).toThrow(NoComputerAvailableError)

    const wt = createRemoteWorktreeAdapters({
      gateway,
      local: makeLocalWorktrees(),
      resolveComputerId: () => null
    })
    await expect(wt.isGitRepo(TASK, '/repo')).rejects.toThrow(NoComputerAvailableError)

    expect(gateway.calls).toHaveLength(0)
  })
})

// ===========================================================================
// Per-task worktree routing
// ===========================================================================

describe('worktree routing is per-task', () => {
  it('routes each task to ITS computer; an unassigned task has nowhere to run', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('git.isGitRepo', () => ({ isGitRepo: true }))
    const local = makeLocalWorktrees({ isGitRepo: vi.fn(async () => true) })

    // The whole point of threading taskId: two tasks in one process can land on
    // different machines. Before this, the resolver took no argument and was
    // pinned to null, so every task's worktree work ran on the hub — including
    // tasks whose agents were running on a computer.
    const wt = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveComputerId: (taskId) =>
        taskId === 'task-on-computer'
          ? 'computer-7'
          : taskId === 'task-on-other'
            ? 'computer-9'
            : null
    })

    await wt.isGitRepo('task-on-computer', '/repo-a')
    await wt.isGitRepo('task-on-other', '/repo-b')

    const routed = gateway.calls.filter((c) => c.method === 'git.isGitRepo')
    expect(routed).toHaveLength(2)
    expect(routed.map((c) => c.computerId)).toEqual(['computer-7', 'computer-9'])

    // A task bound to nothing does not silently run on the hub.
    await expect(wt.isGitRepo('task-unassigned', '/repo-c')).rejects.toThrow(
      NoComputerAvailableError
    )
    expect(local.isGitRepo).not.toHaveBeenCalled()
  })

  it('awaits an async resolver (the real one reads the DB)', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.pathExists', () => ({ exists: true }))
    const local = makeLocalWorktrees()

    // `resolveTaskComputerId` is async, so a resolver returning a Promise must be
    // awaited — not coerced to a truthy object (which would "route" to garbage).
    const wt = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveComputerId: async (taskId) => (taskId === 'task-x' ? 'computer-3' : null)
    })

    expect(await wt.pathExists('task-x', '/some/path')).toBe(true)
    expect(requireCall(gateway, 'fs.pathExists').computerId).toBe('computer-3')
    expect(local.pathExists).not.toHaveBeenCalled()
  })
})

describe('the no-computer error is actionable', () => {
  // Failing loudly is only an improvement if the message tells the user what to do.
  // A bare "cannot spawn" would be a worse experience than the silent hub fallback
  // it replaces.
  it('names the computer requirement and how to fix it', () => {
    const gateway = new FakeGateway()
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => null
    })

    let caught: Error | null = null
    try {
      backend.spawn(ptySpec({ computerId: null }))
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(NoComputerAvailableError)
    expect(caught!.name).toBe('NoComputerAvailableError')
    // WHAT could not run…
    expect(caught!.message).toContain('terminal session')
    // …WHY, and the fix.
    expect(caught!.message).toContain('run on computers')
    expect(caught!.message).toContain('Settings → Computers')
  })

  it('identifies which work failed, per exec kind', async () => {
    const gateway = new FakeGateway()
    const chat = createRoutingChatBackend({
      gateway,
      resolveComputerId: () => null
    })
    await expect(
      chat.spawn({
        sessionId: 's',
        taskId: 't',
        computerId: null,
        binaryName: 'claude',
        args: [],
        cwd: '/tmp',
        env: {}
      })
    ).rejects.toThrow(/chat agent claude/)

    const proc = createRoutingProcessBackend({
      gateway,
      resolveComputerId: () => null
    })
    expect(() => proc.spawn(procSpec({ computerId: null, id: 'proc-42' }))).toThrow(
      /process proc-42/
    )

    const wt = createRemoteWorktreeAdapters({
      gateway,
      local: makeLocalWorktrees(),
      resolveComputerId: () => null
    })
    await expect(wt.createWorktree('task-9', '/r', '/wt', 'b')).rejects.toThrow(
      /worktree create for task task-9/
    )
  })
})

// ===========================================================================
// Workspace filesystem adapters
// ===========================================================================

/**
 * A `LocalWorkspaceFs` that records rather than touching disk. Only the
 * `computerId: null` path may reach it, so any call recorded during a routed test
 * is itself the failure — the whole point of this seam is that a workspace op
 * never silently answers about the hub's disk.
 */
function makeLocalFs(): LocalWorkspaceFs & { calls: string[] } {
  const calls: string[] = []
  const note =
    <T>(name: string, value: T) =>
    (): T => {
      calls.push(name)
      return value
    }
  return {
    calls,
    listRoots: note('listRoots', {
      roots: ['/home/local'],
      home: '/home/local',
      platform: 'linux',
      sep: '/'
    }),
    listDir: async (path: string) => {
      calls.push('listDir')
      return { path, parent: null, entries: [] }
    },
    mkdir: async (path: string) => {
      calls.push('mkdir')
      return { path }
    },
    pathExists: note('pathExists', true),
    setAllowedRoots: async () => {
      calls.push('setAllowedRoots')
      throw new Error('this host has no path jail to configure')
    },
    discoverRepos: async () => {
      calls.push('discoverRepos')
      return []
    },
    resolveProjectPath: note('resolveProjectPath', { path: null }),
    setProjectPath: (_projectId: string, path: string) => {
      calls.push('setProjectPath')
      return { path }
    },
    forgetProjectPath: note('forgetProjectPath', undefined),
    readDir: note('readDir', []),
    readFile: note('readFile', { content: 'local' }),
    writeFile: note('writeFile', undefined),
    createFile: note('createFile', undefined),
    createDir: note('createDir', undefined),
    rename: note('rename', undefined),
    delete: note('delete', undefined),
    copyIn: note('copyIn', 'local.txt'),
    copy: note('copy', undefined),
    gitStatus: async () => {
      calls.push('gitStatus')
      return { files: {}, isGitRepo: false }
    },
    searchFiles: note('searchFiles', { results: [], truncated: false }),
    listAllFiles: note('listAllFiles', { files: [], truncated: false }),
    watch: () => {
      calls.push('watch')
      return () => {}
    }
  }
}

describe('createRemoteFsAdapters — browse ops', () => {
  it('forwards listRoots/listDir/mkdir to the computer and parses the replies', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.listRoots', () => ({
      roots: ['/srv/work'],
      home: '/home/deploy',
      platform: 'linux',
      sep: '/'
    }))
    gateway.onMethod('fs.listDir', () => ({
      path: '/srv/work',
      parent: null,
      entries: [
        {
          name: 'app',
          path: '/srv/work/app',
          type: 'directory',
          isGitRepo: true
        }
      ]
    }))
    gateway.onMethod('fs.mkdir', () => ({ path: '/srv/work/new' }))

    const local = makeLocalFs()
    const fs = createRemoteFsAdapters({ gateway, local })

    expect(await fs.listRoots('computer-1')).toEqual({
      roots: ['/srv/work'],
      home: '/home/deploy',
      platform: 'linux',
      sep: '/'
    })
    const listed = await fs.listDir('computer-1', '/srv/work', {
      dirsOnly: true
    })
    expect(listed.entries[0]?.isGitRepo).toBe(true)
    expect(requireCall(gateway, 'fs.listDir').params).toMatchObject({
      path: '/srv/work',
      dirsOnly: true
    })
    expect(await fs.mkdir('computer-1', '/srv/work/new')).toEqual({
      path: '/srv/work/new'
    })

    // Nothing touched the hub's disk.
    expect(local.calls).toEqual([])
  })

  // The bug this whole seam exists to fix: the hub answering a path question
  // about its OWN disk while the workspace lives on a computer. A remote probe
  // must never reach `local`, whatever the hub happens to have at that path.
  it('probes pathExists on the computer, never on the hub', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.pathExists', () => ({ exists: false }))
    const local = makeLocalFs()
    const fs = createRemoteFsAdapters({ gateway, local })

    expect(await fs.pathExists('computer-1', '/srv/work/app')).toBe(false)
    expect(local.calls).toEqual([])
    expect(requireCall(gateway, 'fs.pathExists').computerId).toBe('computer-1')
  })

  // Not a fallback: null means no computer exists to ask (standalone/fork sidecar,
  // or before the local computer enrolls), where the hub's disk is the only disk.
  it('answers in-process when there is no computer', async () => {
    const gateway = new FakeGateway()
    const local = makeLocalFs()
    const fs = createRemoteFsAdapters({ gateway, local })

    expect(await fs.pathExists(null, '/tmp/x')).toBe(true)
    await fs.listRoots(null)
    await fs.listDir(null, '/tmp')
    expect(local.calls).toEqual(['pathExists', 'listRoots', 'listDir'])
    expect(gateway.calls).toEqual([])
  })
})

describe('createRemoteFsAdapters — allowedRoots', () => {
  it('forwards a jail edit to the computer and reports what was rejected', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('computer.setAllowedRoots', () => ({
      roots: ['/srv/work'],
      rejected: [{ path: '/nope', reason: 'does not exist on this computer' }]
    }))
    const fs = createRemoteFsAdapters({ gateway, local: makeLocalFs() })

    expect(await fs.setAllowedRoots('computer-1', ['/srv/work', '/nope'])).toEqual({
      roots: ['/srv/work'],
      rejected: [{ path: '/nope', reason: 'does not exist on this computer' }]
    })
  })

  // A hub has no jail. Pretending to save would leave the user believing they
  // had widened access that was never restricted in the first place.
  it('refuses when there is no computer, rather than silently accepting', async () => {
    const fs = createRemoteFsAdapters({
      gateway: new FakeGateway(),
      local: makeLocalFs()
    })
    await expect(fs.setAllowedRoots(null, ['/srv/work'])).rejects.toThrow(/no path jail/)
  })
})

describe('createRemoteFsAdapters — editor ops', () => {
  it('forwards each editor op to its frame and unwraps the payload', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.readDir', () => ({
      entries: [{ name: 'src', path: 'src', type: 'directory' }]
    }))
    gateway.onMethod('fs.readFile', () => ({ content: 'remote' }))
    gateway.onMethod('fs.writeFile', () => ({ ok: true }))
    gateway.onMethod('fs.copyIn', () => ({ path: 'assets/pic.png' }))
    gateway.onMethod('fs.gitStatus', () => ({
      files: { 'a.ts': 'modified' },
      isGitRepo: true
    }))
    gateway.onMethod('fs.listAllFiles', () => ({
      files: ['a.ts'],
      truncated: true
    }))
    gateway.onMethod('fs.searchFiles', () => ({
      results: [],
      truncated: false
    }))

    const local = makeLocalFs()
    const fs = createRemoteFsAdapters({ gateway, local })

    expect(await fs.readDir('computer-1', '/srv/app', '')).toEqual([
      { name: 'src', path: 'src', type: 'directory' }
    ])
    expect(await fs.readFile('computer-1', '/srv/app', 'a.ts')).toEqual({
      content: 'remote'
    })
    await fs.writeFile('computer-1', '/srv/app', 'a.ts', 'x')
    expect(await fs.copyIn('computer-1', '/srv/app', '/tmp/pic.png')).toBe('assets/pic.png')
    expect(await fs.gitStatus('computer-1', '/srv/app')).toEqual({
      files: { 'a.ts': 'modified' },
      isGitRepo: true
    })
    expect(local.calls).toEqual([])
  })

  // A capped whole-tree read must arrive labelled. Dropping `truncated` would
  // present a partial tree as the complete one.
  it('preserves the truncated flag on capped whole-tree reads', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.listAllFiles', () => ({
      files: ['a.ts'],
      truncated: true
    }))
    const fs = createRemoteFsAdapters({ gateway, local: makeLocalFs() })
    expect(await fs.listAllFiles('computer-1', '/srv/app')).toEqual({
      files: ['a.ts'],
      truncated: true
    })
  })
})

describe('createRemoteFsAdapters — watch', () => {
  const computer = (computerId: string): ComputerDescriptor => ({
    computerId,
    name: computerId,
    platform: 'linux-x64',
    version: '0.0.0',
    capabilities: ['fs'],
    authMode: 'hello',
    directAddress: null,
    peerLoopback: false,
    directRtc: false,
    connectedAt: 0,
    lastSeenAt: 0
  })

  it('starts a watch and delivers only its own computer + watchId events', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.watchStart', () => ({ ok: true }))
    gateway.onMethod('fs.watchStop', () => ({ ok: true }))
    const fs = createRemoteFsAdapters({
      gateway,
      local: makeLocalFs(),
      newWatchId: () => 'watch-1'
    })

    const seen: string[] = []
    const stop = fs.watch('computer-1', '/srv/app', (e) => seen.push(`${e.type}:${e.relPath}`))
    await vi.waitFor(() => expect(gateway.requestsOf('fs.watchStart')).toHaveLength(1))

    gateway.emit('fs.change', {
      computerId: 'computer-1',
      watchId: 'watch-1',
      type: 'changed',
      relPath: 'a.ts'
    })
    // Another watch on the same computer, and the same watchId on another computer —
    // both must be ignored, or two panels watching one root cross-talk.
    gateway.emit('fs.change', {
      computerId: 'computer-1',
      watchId: 'watch-2',
      type: 'changed',
      relPath: 'other.ts'
    })
    gateway.emit('fs.change', {
      computerId: 'computer-2',
      watchId: 'watch-1',
      type: 'changed',
      relPath: 'elsewhere.ts'
    })

    expect(seen).toEqual(['changed:a.ts'])
    stop()
    expect(requireCall(gateway, 'fs.watchStop').params).toEqual({
      watchId: 'watch-1'
    })
  })

  it('stops delivering after dispose', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.watchStart', () => ({ ok: true }))
    gateway.onMethod('fs.watchStop', () => ({ ok: true }))
    const fs = createRemoteFsAdapters({
      gateway,
      local: makeLocalFs(),
      newWatchId: () => 'watch-1'
    })

    const seen: string[] = []
    const stop = fs.watch('computer-1', '/srv/app', (e) => seen.push(e.relPath))
    await vi.waitFor(() => expect(gateway.requestsOf('fs.watchStart')).toHaveLength(1))
    stop()
    gateway.emit('fs.change', {
      computerId: 'computer-1',
      watchId: 'watch-1',
      type: 'changed',
      relPath: 'a.ts'
    })
    expect(seen).toEqual([])
  })

  // Disposing before the start round-trip lands must still stop the computer-side
  // watcher; otherwise a fast open/close leaks a watcher for the process lifetime.
  it('stops a watch disposed before its start request resolves', async () => {
    const gateway = new FakeGateway()
    let releaseStart: (() => void) | undefined
    gateway.onMethod('fs.watchStart', () => {
      // Returned promise resolves only when the test releases it.
      return new Promise<{ ok: true }>((resolve) => {
        releaseStart = () => resolve({ ok: true })
      })
    })
    gateway.onMethod('fs.watchStop', () => ({ ok: true }))
    const fs = createRemoteFsAdapters({
      gateway,
      local: makeLocalFs(),
      newWatchId: () => 'watch-1'
    })

    const stop = fs.watch('computer-1', '/srv/app', () => {})
    stop()
    releaseStart!()
    await vi.waitFor(() => expect(gateway.requestsOf('fs.watchStop').length).toBeGreaterThan(0))
  })

  // Silence is indistinguishable from "nothing changed". A lost computer has to
  // tear the watch down so the client resubscribes rather than trusting a frozen
  // tree.
  it('tears the watch down when its computer is lost', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.watchStart', () => ({ ok: true }))
    gateway.onMethod('fs.watchStop', () => ({ ok: true }))
    const fs = createRemoteFsAdapters({
      gateway,
      local: makeLocalFs(),
      newWatchId: () => 'watch-1'
    })

    const seen: string[] = []
    fs.watch('computer-1', '/srv/app', (e) => seen.push(e.relPath))
    await vi.waitFor(() => expect(gateway.requestsOf('fs.watchStart')).toHaveLength(1))

    gateway.emit('computer-connected', { computer: computer('computer-1') })
    gateway.emit('computer-lost', {
      computerId: 'computer-1',
      reason: 'heartbeat-timeout'
    })

    gateway.emit('fs.change', {
      computerId: 'computer-1',
      watchId: 'watch-1',
      type: 'changed',
      relPath: 'a.ts'
    })
    expect(seen).toEqual([])
  })
})

// ===========================================================================
// The work gate (T-19): asked before anything reaches a computer
// ===========================================================================

describe('the work gate: a computer works only for the work it was admitted for', () => {
  /** A gate that admits only `allowed`, recording what it was asked. */
  const gateFor = (allowed: string) => {
    const asked: Array<{ computerId: string; work: ComputerWork }> = []
    const gate: ComputerWorkGate = async (computerId, work) => {
      asked.push({ computerId, work })
      if (computerId !== allowed) throw new Error('not yours')
    }
    return { gate, asked }
  }

  it('pty spawn: asks for the task; a refusal sends nothing — not the spawn, not early input', async () => {
    const gateway = new FakeGateway()
    const { gate, asked } = gateFor('mine')
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId,
      gate
    })
    const handle = backend.spawn(ptySpec({ computerId: 'theirs' })) as PtyHandle
    handle.write('ls\n')
    handle.resize(100, 40)
    await expect(handle.whenSpawned).rejects.toThrow('not yours')
    await new Promise((r) => setImmediate(r))
    expect(asked).toEqual([{ computerId: 'theirs', work: { kind: 'task', id: 'task-1' } }])
    expect(gateway.calls).toEqual([])
  })

  it('pty spawn: admitted, the spawn goes first and input queued behind it follows in order', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: (spec) => spec.computerId,
      gate: gateFor('mine').gate
    })
    const handle = backend.spawn(ptySpec({ computerId: 'mine' })) as PtyHandle
    handle.write('ls\n')
    await handle.whenSpawned
    await vi.waitFor(() => expect(gateway.calls).toHaveLength(2))
    expect(gateway.calls.map((c) => c.method)).toEqual(['pty.spawn', 'pty.write'])
  })

  it('pty adopt: asks for the session before anything is tracked or sent', async () => {
    const gateway = new FakeGateway()
    const { gate, asked } = gateFor('mine')
    const backend = createRoutingPtyBackend({
      gateway,
      resolveComputerId: () => null,
      gate
    })
    await expect(backend.adopt!('theirs', 'warm:1', 'task-1:tab-1', 'bash')).rejects.toThrow(
      'not yours'
    )
    expect(asked).toEqual([{ computerId: 'theirs', work: { kind: 'session', id: 'task-1:tab-1' } }])
    expect(gateway.calls).toEqual([])
  })

  it('chat spawn: asks for the task; a refusal sends nothing', async () => {
    const gateway = new FakeGateway()
    const { gate, asked } = gateFor('mine')
    const chat = createRoutingChatBackend({
      gateway,
      resolveComputerId: () => 'theirs',
      gate
    })
    await expect(
      chat.spawn({
        sessionId: 's',
        taskId: 'task-9',
        computerId: 'theirs',
        binaryName: 'claude',
        args: [],
        cwd: '/tmp',
        env: {}
      })
    ).rejects.toThrow('not yours')
    expect(asked).toEqual([{ computerId: 'theirs', work: { kind: 'task', id: 'task-9' } }])
    expect(gateway.calls).toEqual([])
  })

  it('worktree/git: every routed op asks for its task', async () => {
    const gateway = new FakeGateway()
    const { gate, asked } = gateFor('mine')
    const adapters = createRemoteWorktreeAdapters({
      gateway,
      local: makeLocalWorktrees(),
      resolveComputerId: () => 'theirs',
      gate
    })
    await expect(adapters.createWorktree('task-3', '/r', '/wt', 'b')).rejects.toThrow('not yours')
    await expect(adapters.isGitRepo('task-3', '/r')).rejects.toThrow('not yours')
    await expect(adapters.pathExists('task-3', '/r')).rejects.toThrow('not yours')
    expect(asked.every((a) => a.work?.kind === 'task' && a.work.id === 'task-3')).toBe(true)
    expect(gateway.calls).toEqual([])
  })
})
