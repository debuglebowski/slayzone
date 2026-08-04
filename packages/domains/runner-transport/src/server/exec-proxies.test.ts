/**
 * Unit tests for the hub-side exec proxies, driven by a fake in-memory gateway
 * (request + a real typed event bus). No sockets, no runner. The routing
 * backends consume the REAL seam types (terminal `PtyBackend`, processes
 * `ProcessBackend`, task `WorktreeExecAdapters`); the fake gateway is the
 * `RoutingGateway` slice of `HubRunnerGateway`.
 */
import type { ProcHandle, ProcSpawnSpec, ProcessBackend } from '@slayzone/processes/server'
import type { WorktreeExecAdapters } from '@slayzone/task/server'
import type { PtyBackend, PtyHandle, PtySpawnSpec } from '@slayzone/terminal/server'
import { describe, expect, it, vi } from 'vitest'
import { TypedEventEmitter } from '../shared/events'
import {
  createRemoteWorktreeAdapters,
  createRoutingProcessBackend,
  createRoutingChatBackend,
  createRoutingPtyBackend,
  NoRunnerAvailableError,
  type PtyExitEvent,
  type RoutingGateway
} from './exec-proxies'
import type { RunnerDescriptor, RunnerGatewayEvents } from './hub-gateway'

// ---------------------------------------------------------------------------
// Fake gateway
// ---------------------------------------------------------------------------

interface RecordedCall {
  runnerId: string
  method: string
  params: unknown
}

class FakeGateway implements RoutingGateway {
  readonly calls: RecordedCall[] = []
  readonly events = new TypedEventEmitter<RunnerGatewayEvents>()
  private readonly handlers = new Map<string, (params: unknown) => unknown>()

  /** Register a canned responder for a hub → runner request method. */
  onMethod(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler)
  }

  request<T = unknown>(runnerId: string, method: string, params?: unknown): Promise<T> {
    this.calls.push({ runnerId, method, params })
    const handler = this.handlers.get(method)
    if (!handler) return Promise.resolve(undefined as T)
    try {
      return Promise.resolve(handler(params) as T)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * Drive a gateway event to all subscribers, keeping the connected-runner
   * roster consistent with it — the real gateway registers on connect and
   * removes on loss, and the detach controller reads that roster for its epoch
   * baseline.
   */
  emit<K extends keyof RunnerGatewayEvents>(event: K, payload: RunnerGatewayEvents[K]): void {
    if (event === 'runner-connected') {
      const { runner } = payload as RunnerGatewayEvents['runner-connected']
      this.runners.set(runner.runnerId, runner)
    } else if (event === 'runner-disconnected' || event === 'runner-lost') {
      const { runnerId } = payload as { runnerId: string }
      this.runners.delete(runnerId)
    }
    this.events.emit(event, payload)
  }

  private readonly runners = new Map<string, RunnerDescriptor>()

  listRunners(): RunnerDescriptor[] {
    return [...this.runners.values()]
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

const throwingPty: PtyBackend = {
  spawn: () => {
    throw new Error('local pty.spawn must not run for a routed spec')
  }
}
const throwingProc: ProcessBackend = {
  spawn: () => {
    throw new Error('local proc.spawn must not run for a routed spec')
  }
}

const ptySpec = (over: Partial<PtySpawnSpec> = {}): PtySpawnSpec => ({
  sessionId: 'sess-1',
  taskId: 'task-1',
  runnerId: 'runner-1',
  file: 'bash',
  args: [],
  transport: false,
  ...over,
  options: { cwd: '/tmp', env: {}, cols: 80, rows: 24, name: 'xterm-256color', ...(over.options ?? {}) }
})

const procSpec = (over: Partial<ProcSpawnSpec> = {}): ProcSpawnSpec => ({
  id: 'proc-1',
  taskId: 'task-1',
  projectId: 'proj-1',
  runnerId: 'runner-1',
  command: 'git status',
  cwd: '/repo',
  ...over
})

// ===========================================================================
// Routing pty backend
// ===========================================================================

describe('createRoutingPtyBackend', () => {
  it('throws NoRunnerAvailableError when no runner resolves (never spawns on the hub)', () => {
    const gateway = new FakeGateway()
    const backend = createRoutingPtyBackend({ gateway, resolveRunnerId: () => null })

    // Runners run the agents. This used to fall through to an in-process spawn,
    // which made "which machine ran this?" invisible DB state.
    expect(() => backend.spawn(ptySpec({ runnerId: null }))).toThrow(NoRunnerAvailableError)
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
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })

    // Sequences start at 0 — that is what the runner's RingBuffer emits.
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 0, data: 'a' })
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 1, data: 'b' })
    // Gap: seq 4 arrives before 2 & 3 → backfill from lastSeq (1).
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 4, data: 'e' })

    await vi.waitFor(() => expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e']))
    await vi.waitFor(() => expect(handle.pid).toBe(4242))

    expect(requireCall(gateway, 'pty.getBufferSince').params).toEqual({ sessionId: 'sess-1', seq: 1 })

    // Duplicate / stale frame is ignored (no double delivery).
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 2, data: 'DUP' })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])

    gateway.emit('pty.exit', { runnerId: 'runner-1', sessionId: 'sess-1', exitCode: 0, signal: null })
    expect(exit).toEqual({ exitCode: 0, signal: undefined })

    // Post-exit frames are dropped (session disposed).
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 5, data: 'zzz' })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('adopt: seeds warm output first, then drains frames that raced the reply', async () => {
    const gateway = new FakeGateway()
    let releaseAdopt: (() => void) | null = null
    gateway.onMethod('pty.warmAdopt', () => ({ pid: 4242, data: 'BOOT-BANNER', seq: 5 }))
    const backend = createRoutingPtyBackend({ gateway, resolveRunnerId: () => 'runner-1' })

    const chunks: string[] = []
    // Start the adopt but do not await it yet, so we can emit a live frame while
    // the request is still in flight — the real race, since the runner begins
    // streaming the instant it rekeys.
    const pending = backend.adopt!('runner-1', 'warm-1', 'sess-warm', 'bash')
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-warm', seq: 6, data: 'AFTER' })

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
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-warm', seq: 5, data: 'DUP' })
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-warm', seq: 7, data: '-NEXT' })
    await new Promise((r) => setTimeout(r, 0))
    expect(chunks.join('')).toBe('BOOT-BANNERAFTER-NEXT')
  })

  it('adopt: a failed warmAdopt disposes the session instead of leaking it', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.warmAdopt', () => {
      throw new Error('no warm session warm-gone to adopt')
    })
    const backend = createRoutingPtyBackend({ gateway, resolveRunnerId: () => 'runner-1' })

    await expect(backend.adopt!('runner-1', 'warm-gone', 'sess-x', 'bash')).rejects.toThrow(
      /no warm session/
    )
    // The caller cold-spawns after a failed adopt; a stale entry under the same
    // key would swallow that session's frames.
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    const handle = await backend.spawn(ptySpec({ sessionId: 'sess-x' }))
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-x', seq: 0, data: 'fresh' })
    await new Promise((r) => setTimeout(r, 0))
    expect(chunks.join('')).toBe('fresh')
  })

  it('skips forward instead of stalling when a gap is unrecoverable', async () => {
    // Starting delivery at seq -1 makes an unfillable seq 0 reachable: a session
    // whose opening chunk already aged out of the runner's ring buffer can never
    // produce it. Waiting for it would stall the pty forever — strictly worse
    // than the single dropped chunk this fix removes. So after a backfill has
    // run at a position and left the gap open, delivery advances.
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 9 }))
    // Runner no longer holds the missing frames.
    gateway.onMethod('pty.getBufferSince', () => ({ frames: [] }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))

    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 7, data: 'late' })

    await vi.waitFor(() => expect(chunks).toEqual(['late']))

    // And delivery continues normally from there.
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 8, data: 'next' })
    expect(chunks).toEqual(['late', 'next'])
  })

  it('delivers seq 0 — the runner numbers its FIRST chunk 0, not 1', async () => {
    // The runner's RingBuffer starts at `nextSeq = 0` (ring-buffer.ts), so the
    // very first chunk of every remote pty session carries seq 0. The hub used
    // to initialise `lastSeq: 0`, and `ingest` drops `seq <= lastSeq` — so that
    // first chunk was silently discarded on every session. Session start is
    // exactly where a shell's banner/prompt lives.
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 7 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))

    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 0, data: 'FIRST' })
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 1, data: 'second' })

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
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))

    // seq 2 first: gap at 0 and 1 → backfill must ask from BEFORE seq 0.
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 2, data: 'two' })

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
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(
      ptySpec({ file: 'zsh', args: ['-l'], options: { cwd: '/work', env: { FOO: 'bar' }, cols: 100, rows: 30, name: 'xterm-256color' } })
    )) as PtyHandle

    expect(requireCall(gateway, 'pty.spawn')).toMatchObject({
      runnerId: 'runner-1',
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
    expect(requireCall(gateway, 'pty.resize').params).toEqual({ sessionId: 'sess-1', cols: 120, rows: 40 })

    handle.kill('SIGTERM')
    expect(requireCall(gateway, 'pty.kill').params).toEqual({ sessionId: 'sess-1', signal: 'SIGTERM' })

    handle.kill()
    expect(gateway.requestsOf('pty.kill')[1]?.params).toEqual({ sessionId: 'sess-1' })
  })

  // ── Detach / reattach across a dropped runner connection ──────────────────
  //
  // These used to assert the opposite: that runner-lost / runner-disconnected
  // finalized every session on the runner. That was the bug — a lost socket is
  // not a dead agent, and coercing it to `exitCode: 1` surfaced one dropped
  // connection as N independent "Process exited with code 1" while every agent
  // was still running. A disconnect now resolves NOTHING; the runner does, on
  // reconnect.

  /** Drive the gateway's runner-connected event, optionally carrying an epoch. */
  const connect = (gateway: FakeGateway, epoch?: string): void => {
    gateway.emit('runner-connected', {
      runner: {
        runnerId: 'runner-1',
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
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })
    connect(gateway, epoch)
    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 0, data: 'a' })
    gateway.emit('runner-lost', { runnerId: 'runner-1', reason: 'heartbeat-timeout' })
    return { chunks, exit: () => exit }
  }

  it('runner-lost detaches the session rather than declaring it dead', async () => {
    const gateway = new FakeGateway()
    const { chunks, exit } = await spawnDetached(gateway)

    // The regression this whole mechanism exists for: closing a laptop lid must
    // not report a running agent as crashed.
    expect(exit()).toBeNull()

    // Still tracked, so anything that does arrive is still delivered.
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 1, data: 'b' })
    expect(chunks).toEqual(['a', 'b'])
  })

  it('runner-disconnected detaches too — a clean close is no more evidence than a silent one', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })
    connect(gateway, 'epoch-a')
    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('runner-disconnected', { runnerId: 'runner-1', reason: 'socket-closed' })
    expect(exit).toBeNull()
  })

  it('reconnect with the SAME epoch reattaches sessions the runner still holds, backfilling the gap', async () => {
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

  it('reconnect with the same epoch ends the sessions the runner no longer holds', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({ sessions: [] }))
    const { exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-a')

    // Absent from the runner's own list ⇒ it really did exit while we were away.
    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 1, signal: undefined }))
  })

  it('reconnect as a DIFFERENT process ends every detached session without asking', async () => {
    const gateway = new FakeGateway()
    const { exit } = await spawnDetached(gateway)

    connect(gateway, 'epoch-b') // runner restarted

    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 1, signal: undefined }))
    // A new process provably holds nothing of ours — no point listing.
    expect(gateway.requestsOf('pty.list')).toHaveLength(0)
  })

  it('a runner that reports no epoch keeps the conservative pre-epoch behavior', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.list', () => ({ sessions: [{ sessionId: 'sess-1', pid: 1, seq: 0 }] }))
    const { exit } = await spawnDetached(gateway, undefined)

    connect(gateway, undefined)

    // Identity unverified ⇒ never reattach on it, even though the runner says
    // it still holds the session. Absence of an epoch is not a match.
    await vi.waitFor(() => expect(exit()).toEqual({ exitCode: 1, signal: undefined }))
    expect(gateway.requestsOf('pty.list')).toHaveLength(0)
  })

  it('kills sessions the runner still holds that the hub no longer tracks', async () => {
    const gateway = new FakeGateway()
    // The runner reports one session the hub knows about and one it does not —
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
    // the hub's own bookkeeping (a runner that never returns would otherwise
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
      throw new Error('runner went away again mid-reattach')
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
  it('throws NoRunnerAvailableError when no runner resolves', () => {
    const gateway = new FakeGateway()
    const backend = createRoutingProcessBackend({ gateway, resolveRunnerId: () => null })

    expect(() => backend.spawn(procSpec({ runnerId: null }))).toThrow(NoRunnerAvailableError)
    expect(gateway.calls).toHaveLength(0)
  })

  it('remote: forwards proc.spawn, delivers proc.data in order, kill frame, exit cleanup', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 555 }))
    const backend = createRoutingProcessBackend({
      gateway,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = backend.spawn(procSpec())
    const chunks: string[] = []
    let exit: { code: number | null; signal: string | null } | null = null
    handle.onData((chunk) => chunks.push(chunk))
    handle.onExit((e) => {
      exit = e
    })

    expect(requireCall(gateway, 'proc.spawn')).toMatchObject({
      runnerId: 'runner-1',
      params: { sessionId: 'proc-1', command: 'git status', cwd: '/repo' }
    })
    await vi.waitFor(() => expect(handle.pid).toBe(555))

    gateway.emit('proc.data', { runnerId: 'runner-1', sessionId: 'proc-1', data: 'one' })
    gateway.emit('proc.data', { runnerId: 'runner-1', sessionId: 'proc-1', data: 'two', stream: 'stderr' })
    expect(chunks).toEqual(['one', 'two'])

    handle.kill('SIGKILL')
    expect(requireCall(gateway, 'proc.kill').params).toEqual({ sessionId: 'proc-1', signal: 'SIGKILL' })

    gateway.emit('proc.exit', { runnerId: 'runner-1', sessionId: 'proc-1', exitCode: 1, signal: null })
    expect(exit).toEqual({ code: 1, signal: null })

    gateway.emit('proc.data', { runnerId: 'runner-1', sessionId: 'proc-1', data: 'after-exit' })
    expect(chunks).toEqual(['one', 'two'])
  })

  // Routed child processes (which the chat agents ride on) detach and reattach
  // on exactly the same rule as ptys — same controller, `proc.list` instead of
  // `pty.list`. Previously a dropped socket finalized these too, which is why
  // one sleep killed both the terminals and the chat agents on a machine.
  const connectProc = (gateway: FakeGateway, epoch?: string): void => {
    gateway.emit('runner-connected', {
      runner: {
        runnerId: 'runner-1',
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
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })
    connectProc(gateway, 'epoch-a')
    const handle = backend.spawn(procSpec())
    let exit: { code: number | null; signal: string | null } | null = null
    handle.onExit((e) => {
      exit = e
    })
    gateway.emit('runner-lost', { runnerId: 'runner-1', reason: 'heartbeat-timeout' })
    return { exit: () => exit }
  }

  it('runner-lost detaches the process rather than declaring it dead', () => {
    const gateway = new FakeGateway()
    expect(spawnDetachedProc(gateway).exit()).toBeNull()
  })

  it('reconnect with the same epoch resumes a process the runner still holds', async () => {
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
        resolveRunnerId: (spec) => spec.runnerId ?? null
      })
      backend.spawn(procSpec({ id })).onExit((e) => {
        exits[i] = e
      })
    }

    gateway.emit('runner-lost', { runnerId: 'runner-1', reason: 'heartbeat-timeout' })
    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() => expect(gateway.requestsOf('proc.list')).toHaveLength(1))
    expect(exits).toEqual([null, null]) // both resumed, neither declared dead
  })

  it('reconnect with the same epoch ends a process the runner no longer holds', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.list', () => ({ sessions: [] }))
    const { exit } = spawnDetachedProc(gateway)

    connectProc(gateway, 'epoch-a')

    await vi.waitFor(() =>
      expect(exit()).toEqual({ code: null, signal: 'exited-while-detached' })
    )
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
    ensureProjectWorktreeColors: vi.fn(async () => new Map([['/wt', '#abcdef']]) as ReadonlyMap<string, string>),
    pathExists: vi.fn(async () => false),
  hubPathExists: vi.fn(() => false),
    removeArtifactDir: vi.fn(async () => {}),
    ...over
  }
}

/** Any task id: the local adapters ignore it; the routing ones resolve a runner from it. */
const TASK = 'task-1'

describe('createRemoteWorktreeAdapters', () => {
  it('forwards git/fs ops to the right frames and parses the runner replies', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('git.isGitRepo', () => ({ isGitRepo: true }))
    gateway.onMethod('git.getCurrentBranch', () => ({ branch: 'main' }))
    gateway.onMethod('git.createWorktree', () => ({}))
    gateway.onMethod('git.removeWorktree', () => ({ branchDeleted: true }))
    gateway.onMethod('git.runWorktreeSetupScript', () => ({ ran: true, success: true, output: 'ok' }))
    gateway.onMethod('git.copyIgnoredFiles', () => ({}))
    gateway.onMethod('fs.pathExists', () => ({ exists: true }))
    gateway.onMethod('fs.removeDir', () => ({}))
    const local = makeLocalWorktrees()
    const adapters = createRemoteWorktreeAdapters({ gateway, local, resolveRunnerId: () => 'runner-1' })

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
    expect(requireCall(gateway, 'git.removeWorktree').params).toEqual({ projectPath: '/proj', worktreePath: '/wt' })

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
    // impossible with no runner connected.
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
    const adapters = createRemoteWorktreeAdapters({ gateway, local, resolveRunnerId: () => 'runner-1' })

    expect(adapters.getWorktreeColor('/proj', '/wt')).toBe('#abcdef')
    expect(local.getWorktreeColor).toHaveBeenCalledWith('/proj', '/wt')

    expect(await adapters.ensureProjectWorktreeColors('/proj')).toEqual(new Map([['/wt', '#abcdef']]))
    expect(local.ensureProjectWorktreeColors).toHaveBeenCalledWith('/proj')

    expect(gateway.calls).toHaveLength(0)
  })

  it('throws for every WORKSPACE method, but keeps hub-owned ops working', async () => {
    const gateway = new FakeGateway()
    const local = makeLocalWorktrees()
    const adapters = createRemoteWorktreeAdapters({ gateway, local, resolveRunnerId: () => null })

    // Workspace work must land on the same machine as the agent that will use it,
    // so "no runner" cannot silently mean "do it on the hub".
    await expect(adapters.isGitRepo(TASK, '/repo')).rejects.toThrow(NoRunnerAvailableError)
    await expect(adapters.pathExists(TASK, '/x')).rejects.toThrow(NoRunnerAvailableError)
    await expect(adapters.createWorktree(TASK, '/r', '/wt', 'b')).rejects.toThrow(
      NoRunnerAvailableError
    )

    // …while the hub-owned ops keep working with zero runners — archiving a task
    // and rendering the task list must not require one (docs/exec-boundary.md).
    expect(await adapters.hubPathExists('/storage/artifacts/x')).toBe(false)
    await adapters.removeArtifactDir('/storage/artifacts/x')
    expect(adapters.getWorktreeColor('/proj', '/wt')).toBe('#abcdef')

    expect(gateway.calls).toHaveLength(0)
  })

  it('serves the color ops locally even with no runner (hub-local UI state)', async () => {
    const gateway = new FakeGateway()
    const local = makeLocalWorktrees()
    const adapters = createRemoteWorktreeAdapters({ gateway, local, resolveRunnerId: () => null })

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
// Runner-OFF / no-runner fall-through
//
// The composition wires these routing backends unconditionally (always-on),
// but with no runner registered `resolveTaskRunnerId` returns null, so the
// spec's runnerId is null and EVERY spawn must route to the in-process local
// backend WITHOUT any gateway contact — byte-identical to runner-OFF. This
// pins that guarantee across all three backends against a gateway whose
// `request` throws (so any accidental routing is a hard failure).
// ===========================================================================

describe('no-runner: every exec kind fails loudly, nothing reaches the gateway', () => {
  class ExplodingGateway extends FakeGateway {
    override request<T = unknown>(_runnerId: string, method: string, _params?: unknown): Promise<T> {
      throw new Error(`a no-runner spawn must never reach the gateway (got ${method})`)
    }
  }

  it('pty/proc/worktree all throw NoRunnerAvailableError', async () => {
    const gateway = new ExplodingGateway()

    // The invariant in one place: with no runner there is nowhere to run, and the
    // hub must not quietly become the execution host.
    const pty = createRoutingPtyBackend({ gateway, resolveRunnerId: () => null })
    expect(() => pty.spawn(ptySpec({ runnerId: null }))).toThrow(NoRunnerAvailableError)

    const proc = createRoutingProcessBackend({ gateway, resolveRunnerId: () => null })
    expect(() => proc.spawn(procSpec({ runnerId: null }))).toThrow(NoRunnerAvailableError)

    const wt = createRemoteWorktreeAdapters({
      gateway,
      local: makeLocalWorktrees(),
      resolveRunnerId: () => null
    })
    await expect(wt.isGitRepo(TASK, '/repo')).rejects.toThrow(NoRunnerAvailableError)

    expect(gateway.calls).toHaveLength(0)
  })
})

// ===========================================================================
// Per-task worktree routing
// ===========================================================================

describe('worktree routing is per-task', () => {
  it('routes each task to ITS runner; an unassigned task has nowhere to run', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('git.isGitRepo', () => ({ isGitRepo: true }))
    const local = makeLocalWorktrees({ isGitRepo: vi.fn(async () => true) })

    // The whole point of threading taskId: two tasks in one process can land on
    // different machines. Before this, the resolver took no argument and was
    // pinned to null, so every task's worktree work ran on the hub — including
    // tasks whose agents were running on a runner.
    const wt = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveRunnerId: (taskId) =>
        taskId === 'task-on-runner' ? 'runner-7' : taskId === 'task-on-other' ? 'runner-9' : null
    })

    await wt.isGitRepo('task-on-runner', '/repo-a')
    await wt.isGitRepo('task-on-other', '/repo-b')

    const routed = gateway.calls.filter((c) => c.method === 'git.isGitRepo')
    expect(routed).toHaveLength(2)
    expect(routed.map((c) => c.runnerId)).toEqual(['runner-7', 'runner-9'])

    // A task bound to nothing does not silently run on the hub.
    await expect(wt.isGitRepo('task-unassigned', '/repo-c')).rejects.toThrow(
      NoRunnerAvailableError
    )
    expect(local.isGitRepo).not.toHaveBeenCalled()
  })

  it('awaits an async resolver (the real one reads the DB)', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('fs.pathExists', () => ({ exists: true }))
    const local = makeLocalWorktrees()

    // `resolveTaskRunnerId` is async, so a resolver returning a Promise must be
    // awaited — not coerced to a truthy object (which would "route" to garbage).
    const wt = createRemoteWorktreeAdapters({
      gateway,
      local,
      resolveRunnerId: async (taskId) => (taskId === 'task-x' ? 'runner-3' : null)
    })

    expect(await wt.pathExists('task-x', '/some/path')).toBe(true)
    expect(requireCall(gateway, 'fs.pathExists').runnerId).toBe('runner-3')
    expect(local.pathExists).not.toHaveBeenCalled()
  })
})

describe('the no-runner error is actionable', () => {
  // Failing loudly is only an improvement if the message tells the user what to do.
  // A bare "cannot spawn" would be a worse experience than the silent hub fallback
  // it replaces.
  it('names the runner requirement and how to fix it', () => {
    const gateway = new FakeGateway()
    const backend = createRoutingPtyBackend({ gateway, resolveRunnerId: () => null })

    let caught: Error | null = null
    try {
      backend.spawn(ptySpec({ runnerId: null }))
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(NoRunnerAvailableError)
    expect(caught!.name).toBe('NoRunnerAvailableError')
    // WHAT could not run…
    expect(caught!.message).toContain('terminal session')
    // …WHY, and the fix.
    expect(caught!.message).toContain('run on runners')
    expect(caught!.message).toContain('Settings → Runners')
  })

  it('identifies which work failed, per exec kind', async () => {
    const gateway = new FakeGateway()
    const chat = createRoutingChatBackend({ gateway, resolveRunnerId: () => null })
    await expect(
      chat.spawn({
        sessionId: 's',
        taskId: 't',
        runnerId: null,
        binaryName: 'claude',
        args: [],
        cwd: '/tmp',
        env: {}
      })
    ).rejects.toThrow(/chat agent claude/)

    const proc = createRoutingProcessBackend({ gateway, resolveRunnerId: () => null })
    expect(() => proc.spawn(procSpec({ runnerId: null, id: 'proc-42' }))).toThrow(/process proc-42/)

    const wt = createRemoteWorktreeAdapters({
      gateway,
      local: makeLocalWorktrees(),
      resolveRunnerId: () => null
    })
    await expect(wt.createWorktree('task-9', '/r', '/wt', 'b')).rejects.toThrow(
      /worktree create for task task-9/
    )
  })
})
