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
  createRemoteFsAdapters,
  createRemoteWorktreeAdapters,
  createRoutingProcessBackend,
  createRoutingChatBackend,
  createRoutingPtyBackend,
  NoComputerAvailableError,
  type PtyExitEvent,
  type RoutingGateway
} from './exec-proxies'
import type { ComputerDescriptor, ComputerGatewayEvents } from './hub-gateway'

// ---------------------------------------------------------------------------
// Fake gateway
// ---------------------------------------------------------------------------

interface RecordedCall {
  computerId: string
  method: string
  params: unknown
}

class FakeGateway implements RoutingGateway {
  readonly calls: RecordedCall[] = []
  readonly events = new TypedEventEmitter<ComputerGatewayEvents>()
  private readonly handlers = new Map<string, (params: unknown) => unknown>()

  /** Register a canned responder for a hub → computer request method. */
  onMethod(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler)
  }

  request<T = unknown>(computerId: string, method: string, params?: unknown): Promise<T> {
    this.calls.push({ computerId, method, params })
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
    const backend = createRoutingPtyBackend({ gateway, resolveComputerId: () => null })

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
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 0, data: 'a' })
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 1, data: 'b' })
    // Gap: seq 4 arrives before 2 & 3 → backfill from lastSeq (1).
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 4, data: 'e' })

    await vi.waitFor(() => expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e']))
    await vi.waitFor(() => expect(handle.pid).toBe(4242))

    expect(requireCall(gateway, 'pty.getBufferSince').params).toEqual({
      sessionId: 'sess-1',
      seq: 1
    })

    // Duplicate / stale frame is ignored (no double delivery).
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 2, data: 'DUP' })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])

    gateway.emit('pty.exit', {
      computerId: 'computer-1',
      sessionId: 'sess-1',
      exitCode: 0,
      signal: null
    })
    expect(exit).toEqual({ exitCode: 0, signal: undefined })

    // Post-exit frames are dropped (session disposed).
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 5, data: 'zzz' })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('adopt: seeds warm output first, then drains frames that raced the reply', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.warmAdopt', () => ({ pid: 4242, data: 'BOOT-BANNER', seq: 5 }))
    const backend = createRoutingPtyBackend({ gateway, resolveComputerId: () => 'computer-1' })

    const chunks: string[] = []
    // Start the adopt but do not await it yet, so we can emit a live frame while
    // the request is still in flight — the real race, since the computer begins
    // streaming the instant it rekeys.
    const pending = backend.adopt!('computer-1', 'warm-1', 'sess-warm', 'bash')
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
      sessionId: 'sess-warm'
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
    const backend = createRoutingPtyBackend({ gateway, resolveComputerId: () => 'computer-1' })

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
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 2, data: 'two' })

    await vi.waitFor(() => expect(chunks).toEqual(['zero', 'one', 'two']))
    // `getBufferSince` returns `seq > params.seq`, so -1 is what includes seq 0.
    expect(requireCall(gateway, 'pty.getBufferSince').params).toEqual({
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
        options: { cwd: '/work', env: { FOO: 'bar' }, cols: 100, rows: 30, name: 'xterm-256color' }
      })
    )) as PtyHandle

    expect(requireCall(gateway, 'pty.spawn')).toMatchObject({
      computerId: 'computer-1',
      params: {
        sessionId: 'sess-1',
        command: 'zsh',
        args: ['-l'],
        cwd: '/work',
        env: { FOO: 'bar' },
        cols: 100,
        rows: 30
      }
    })

    handle.write('input')
    expect(requireCall(gateway, 'pty.write').params).toEqual({ sessionId: 'sess-1', data: 'input' })

    handle.resize(120, 40)
    expect(requireCall(gateway, 'pty.resize').params).toEqual({
      sessionId: 'sess-1',
      cols: 120,
      rows: 40
    })

    handle.kill('SIGTERM')
    expect(requireCall(gateway, 'pty.kill').params).toEqual({
      sessionId: 'sess-1',
      signal: 'SIGTERM'
    })

    handle.kill()
    expect(gateway.requestsOf('pty.kill')[1]?.params).toEqual({ sessionId: 'sess-1' })
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
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 0, data: 'a' })
    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    return { chunks, exit: () => exit }
  }

  it('computer-lost detaches the session rather than declaring it dead', async () => {
    const gateway = new FakeGateway()
    const { chunks, exit } = await spawnDetached(gateway)

    // The regression this whole mechanism exists for: closing a laptop lid must
    // not report a running agent as crashed.
    expect(exit()).toBeNull()

    // Still tracked, so anything that does arrive is still delivered.
    gateway.emit('pty.data', { computerId: 'computer-1', sessionId: 'sess-1', seq: 1, data: 'b' })
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

    gateway.emit('computer-disconnected', { computerId: 'computer-1', reason: 'socket-closed' })
    expect(exit).toBeNull()
  })

  it('reconnect with the SAME epoch reattaches sessions the computer still holds, backfilling the gap', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({ sessions: [{ sessionId: 'sess-1', pid: 1, seq: 1 }] }))
    gateway.onMethod('pty.getBufferSince', () => ({ frames: [{ seq: 1, data: 'b' }] }))
    const { chunks, exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-a') // same process came back

    await vi.waitFor(() => expect(chunks).toEqual(['a', 'b']))
    expect(exit()).toBeNull()
    // Backfill resumes from the last seq actually delivered, not from scratch.
    expect(requireCall(gateway, 'pty.getBufferSince').params).toEqual({
      sessionId: 'sess-1',
      seq: 0
    })
  })

  it('reconnect with the same epoch ends the sessions the computer no longer holds', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({ sessions: [] }))
    const { exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-a')

    // Absent from the computer's own list ⇒ it really did exit while we were away.
    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 1, signal: undefined }))
  })

  it('reconnect as a DIFFERENT process ends every detached session without asking', async () => {
    const gateway = new FakeGateway()
    const { exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-b') // computer restarted

    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 1, signal: undefined }))
    // A new process provably holds nothing of ours — no point listing.
    expect(gateway.requestsOf('pty.list')).toHaveLength(0)
  })

  it('a computer that reports no epoch keeps the conservative pre-epoch behavior', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({ sessions: [{ sessionId: 'sess-1', pid: 1, seq: 0 }] }))
    const { exit } = await spawnDetached(gateway, undefined)

    connect(gateway, undefined)

    // Identity unverified ⇒ never reattach on it, even though the computer says
    // it still holds the session. Absence of an epoch is not a match.
    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 1, signal: undefined }))
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
      expect(exit()).toEqual({ exitCode: 1, signal: undefined })
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
})

// ===========================================================================
// Routing process backend
// ===========================================================================

describe('createRoutingProcessBackend', () => {
  it('throws NoComputerAvailableError when no computer resolves', () => {
    const gateway = new FakeGateway()
    const backend = createRoutingProcessBackend({ gateway, resolveComputerId: () => null })

    expect(() => backend.spawn(procSpec({ computerId: null }))).toThrow(NoComputerAvailableError)
    expect(gateway.calls).toHaveLength(0)
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

    gateway.emit('proc.data', { computerId: 'computer-1', sessionId: 'proc-1', data: 'one' })
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
      signal: 'SIGKILL'
    })

    gateway.emit('proc.exit', {
      computerId: 'computer-1',
      sessionId: 'proc-1',
      exitCode: 1,
      signal: null
    })
    expect(exit).toEqual({ code: 1, signal: null })

    gateway.emit('proc.data', { computerId: 'computer-1', sessionId: 'proc-1', data: 'after-exit' })
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
    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    return { exit: () => exit }
  }

  it('computer-lost detaches the process rather than declaring it dead', () => {
    const gateway = new FakeGateway()
    expect(spawnDetachedProc(gateway).exit()).toBeNull()
  })

  it('reconnect with the same epoch resumes a process the computer still holds', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.list', () => ({ sessions: [{ sessionId: 'proc-1', pid: 1, seq: 0 }] }))
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

    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
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
})

// ===========================================================================
// Remote worktree adapters
// ===========================================================================

function makeLocalWorktrees(over: Partial<WorktreeExecAdapters> = {}): WorktreeExecAdapters {
  return {
    createWorktree: vi.fn(async () => {}),
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
    expect(requireCall(gateway, 'git.isGitRepo').params).toEqual({ path: '/repo' })

    expect(await adapters.getCurrentBranch(TASK, '/repo')).toBe('main')
    expect(requireCall(gateway, 'git.getCurrentBranch').params).toEqual({ repoPath: '/repo' })

    await adapters.createWorktree(TASK, '/repo', '/wt', 'feature', 'main')
    expect(requireCall(gateway, 'git.createWorktree').params).toEqual({
      repoPath: '/repo',
      worktreePath: '/wt',
      branch: 'feature',
      sourceBranch: 'main'
    })

    expect(await adapters.removeWorktree(TASK, '/proj', '/wt')).toEqual({ branchDeleted: true })
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
    expect(requireCall(gateway, 'fs.pathExists').params).toEqual({ path: '/some/path' })

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
    const adapters = createRemoteWorktreeAdapters({ gateway, local, resolveComputerId: () => null })

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
    const adapters = createRemoteWorktreeAdapters({ gateway, local, resolveComputerId: () => null })

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
    const pty = createRoutingPtyBackend({ gateway, resolveComputerId: () => null })
    expect(() => pty.spawn(ptySpec({ computerId: null }))).toThrow(NoComputerAvailableError)

    const proc = createRoutingProcessBackend({ gateway, resolveComputerId: () => null })
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
    const backend = createRoutingPtyBackend({ gateway, resolveComputerId: () => null })

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
    const chat = createRoutingChatBackend({ gateway, resolveComputerId: () => null })
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

    const proc = createRoutingProcessBackend({ gateway, resolveComputerId: () => null })
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
      entries: [{ name: 'app', path: '/srv/work/app', type: 'directory', isGitRepo: true }]
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
    const listed = await fs.listDir('computer-1', '/srv/work', { dirsOnly: true })
    expect(listed.entries[0]?.isGitRepo).toBe(true)
    expect(requireCall(gateway, 'fs.listDir').params).toMatchObject({
      path: '/srv/work',
      dirsOnly: true
    })
    expect(await fs.mkdir('computer-1', '/srv/work/new')).toEqual({ path: '/srv/work/new' })

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
    const fs = createRemoteFsAdapters({ gateway: new FakeGateway(), local: makeLocalFs() })
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
    gateway.onMethod('fs.gitStatus', () => ({ files: { 'a.ts': 'modified' }, isGitRepo: true }))
    gateway.onMethod('fs.listAllFiles', () => ({ files: ['a.ts'], truncated: true }))
    gateway.onMethod('fs.searchFiles', () => ({ results: [], truncated: false }))

    const local = makeLocalFs()
    const fs = createRemoteFsAdapters({ gateway, local })

    expect(await fs.readDir('computer-1', '/srv/app', '')).toEqual([
      { name: 'src', path: 'src', type: 'directory' }
    ])
    expect(await fs.readFile('computer-1', '/srv/app', 'a.ts')).toEqual({ content: 'remote' })
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
    gateway.onMethod('fs.listAllFiles', () => ({ files: ['a.ts'], truncated: true }))
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
    expect(requireCall(gateway, 'fs.watchStop').params).toEqual({ watchId: 'watch-1' })
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
    gateway.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })

    gateway.emit('fs.change', {
      computerId: 'computer-1',
      watchId: 'watch-1',
      type: 'changed',
      relPath: 'a.ts'
    })
    expect(seen).toEqual([])
  })
})
