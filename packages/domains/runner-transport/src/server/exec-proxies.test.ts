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
  createRoutingPtyBackend,
  type PtyExitEvent,
  type RoutingGateway
} from './exec-proxies'
import type { RunnerGatewayEvents } from './hub-gateway'

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

  /** Drive a gateway event to all subscribers. */
  emit<K extends keyof RunnerGatewayEvents>(event: K, payload: RunnerGatewayEvents[K]): void {
    this.events.emit(event, payload)
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
  it('runs locally (no gateway traffic) when resolveRunnerId returns null', () => {
    const gateway = new FakeGateway()
    const localHandle: PtyHandle = {
      pid: 7,
      process: 'bash',
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {}
    }
    const local: PtyBackend = { spawn: vi.fn(() => localHandle) }
    const backend = createRoutingPtyBackend({ gateway, local, resolveRunnerId: () => null })

    const handle = backend.spawn(ptySpec({ runnerId: null }))

    expect(handle).toBe(localHandle)
    expect(local.spawn).toHaveBeenCalledTimes(1)
    expect(gateway.calls).toHaveLength(0)
  })

  it('remote: monotonic delivery, backfills a gap via getBufferSince, sets pid, cleans up on exit', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 4242 }))
    gateway.onMethod('pty.getBufferSince', () => ({
      frames: [
        { seq: 3, data: 'c' },
        { seq: 4, data: 'd' },
        { seq: 5, data: 'e' }
      ]
    }))
    const backend = createRoutingPtyBackend({
      gateway,
      local: throwingPty,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 1, data: 'a' })
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 2, data: 'b' })
    // Gap: seq 5 arrives before 3 & 4 → backfill from lastSeq (2).
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 5, data: 'e' })

    await vi.waitFor(() => expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e']))
    await vi.waitFor(() => expect(handle.pid).toBe(4242))

    expect(requireCall(gateway, 'pty.getBufferSince').params).toEqual({ sessionId: 'sess-1', seq: 2 })

    // Duplicate / stale frame is ignored (no double delivery).
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 3, data: 'DUP' })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])

    gateway.emit('pty.exit', { runnerId: 'runner-1', sessionId: 'sess-1', exitCode: 0, signal: null })
    expect(exit).toEqual({ exitCode: 0, signal: undefined })

    // Post-exit frames are dropped (session disposed).
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 6, data: 'zzz' })
    expect(chunks).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('maps the spawn spec to a pty.spawn frame and issues write/resize/kill frames', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      local: throwingPty,
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

  it('disposes the session on runner-lost (exit emitted, later frames dropped)', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      local: throwingPty,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    const chunks: string[] = []
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 1, data: 'a' })
    gateway.emit('runner-lost', { runnerId: 'runner-1', reason: 'heartbeat-timeout' })

    // The terminal PtyHandle.onExit seam can't carry a null exitCode or a string
    // signal, so runner-loss is coerced to abnormal exit (exitCode 1) — pty-manager
    // only reads exitCode. The raw null/'runner-lost' payload is internal.
    expect(exit).toEqual({ exitCode: 1, signal: undefined })

    // Session removed from the demux Map → no further delivery.
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 2, data: 'b' })
    expect(chunks).toEqual(['a'])
  })

  it('disposes the session on runner-disconnected', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      local: throwingPty,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = (await backend.spawn(ptySpec())) as PtyHandle
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('runner-disconnected', { runnerId: 'runner-1', reason: 'socket-closed' })
    // Coerced to the terminal seam shape (see runner-lost test above).
    expect(exit).toEqual({ exitCode: 1, signal: undefined })
  })
})

// ===========================================================================
// Routing process backend
// ===========================================================================

describe('createRoutingProcessBackend', () => {
  it('runs locally when resolveRunnerId returns null', () => {
    const gateway = new FakeGateway()
    const localHandle: ProcHandle = {
      pid: 3,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      kill: () => {}
    }
    const local: ProcessBackend = { spawn: vi.fn(() => localHandle) }
    const backend = createRoutingProcessBackend({ gateway, local, resolveRunnerId: () => null })

    const handle = backend.spawn(procSpec({ runnerId: null }))
    expect(handle).toBe(localHandle)
    expect(local.spawn).toHaveBeenCalledTimes(1)
    expect(gateway.calls).toHaveLength(0)
  })

  it('remote: forwards proc.spawn, delivers proc.data in order, kill frame, exit cleanup', async () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 555 }))
    const backend = createRoutingProcessBackend({
      gateway,
      local: throwingProc,
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

  it('disposes the session on runner-lost', () => {
    const gateway = new FakeGateway()
    gateway.onMethod('proc.spawn', () => ({ pid: 1 }))
    const backend = createRoutingProcessBackend({
      gateway,
      local: throwingProc,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = backend.spawn(procSpec())
    let exit: { code: number | null; signal: string | null } | null = null
    handle.onExit((e) => {
      exit = e
    })
    gateway.emit('runner-lost', { runnerId: 'runner-1', reason: 'heartbeat-timeout' })
    expect(exit).toEqual({ code: null, signal: 'runner-lost' })
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
    removeArtifactDir: vi.fn(async () => {}),
    ...over
  }
}

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

    expect(await adapters.isGitRepo('/repo')).toBe(true)
    expect(requireCall(gateway, 'git.isGitRepo').params).toEqual({ path: '/repo' })

    expect(await adapters.getCurrentBranch('/repo')).toBe('main')
    expect(requireCall(gateway, 'git.getCurrentBranch').params).toEqual({ repoPath: '/repo' })

    await adapters.createWorktree('/repo', '/wt', 'feature', 'main')
    expect(requireCall(gateway, 'git.createWorktree').params).toEqual({
      repoPath: '/repo',
      worktreePath: '/wt',
      branch: 'feature',
      sourceBranch: 'main'
    })

    expect(await adapters.removeWorktree('/proj', '/wt')).toEqual({ branchDeleted: true })
    expect(requireCall(gateway, 'git.removeWorktree').params).toEqual({ projectPath: '/proj', worktreePath: '/wt' })

    expect(await adapters.runWorktreeSetupScript('/wt', '/repo', null)).toEqual({
      ran: true,
      success: true,
      output: 'ok'
    })
    expect(requireCall(gateway, 'git.runWorktreeSetupScript').params).toEqual({
      worktreePath: '/wt',
      repoPath: '/repo',
      sourceBranch: null
    })

    await adapters.copyIgnoredFiles('/repo', '/wt', 'custom', ['.env'])
    expect(requireCall(gateway, 'git.copyIgnoredFiles').params).toEqual({
      repoPath: '/repo',
      worktreePath: '/wt',
      behavior: 'custom',
      customPaths: ['.env']
    })

    expect(await adapters.pathExists('/some/path')).toBe(true)
    expect(requireCall(gateway, 'fs.pathExists').params).toEqual({ path: '/some/path' })

    await adapters.removeArtifactDir('/artifacts/x')
    expect(requireCall(gateway, 'fs.removeDir').params).toEqual({ path: '/artifacts/x' })

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

  it('degrades every method to local when resolveRunnerId returns null', async () => {
    const gateway = new FakeGateway()
    const local = makeLocalWorktrees({ isGitRepo: vi.fn(async () => true), pathExists: vi.fn(async () => true) })
    const adapters = createRemoteWorktreeAdapters({ gateway, local, resolveRunnerId: () => null })

    expect(await adapters.isGitRepo('/repo')).toBe(true)
    expect(await adapters.pathExists('/x')).toBe(true)
    await adapters.removeArtifactDir('/dir')

    expect(local.isGitRepo).toHaveBeenCalledWith('/repo')
    expect(local.pathExists).toHaveBeenCalledWith('/x')
    expect(local.removeArtifactDir).toHaveBeenCalledWith('/dir')
    expect(gateway.calls).toHaveLength(0)
  })
})

// ===========================================================================
// Runner-OFF / no-runner fall-through
//
// The composition wires these routing backends under `SLAYZONE_RUNNERS_ENABLED=1`,
// but with no runner registered `resolveTaskRunnerId` returns null, so the
// spec's runnerId is null and EVERY spawn must route to the in-process local
// backend WITHOUT any gateway contact — byte-identical to runner-OFF. This
// pins that guarantee across all three backends against a gateway whose
// `request` throws (so any accidental routing is a hard failure).
// ===========================================================================

describe('runner-off / no-runner fall-through (byte-identical to local)', () => {
  class ExplodingGateway extends FakeGateway {
    override request<T = unknown>(_runnerId: string, method: string, _params?: unknown): Promise<T> {
      throw new Error(`no-runner spawn must never reach the gateway (got ${method})`)
    }
  }

  it('pty/proc/worktree all resolve to local, zero gateway traffic', async () => {
    const gateway = new ExplodingGateway()

    const ptyHandle: PtyHandle = {
      pid: 11,
      process: 'bash',
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {}
    }
    const localPty: PtyBackend = { spawn: vi.fn(() => ptyHandle) }
    const pty = createRoutingPtyBackend({ gateway, local: localPty, resolveRunnerId: () => null })
    expect(pty.spawn(ptySpec({ runnerId: null }))).toBe(ptyHandle)
    expect(localPty.spawn).toHaveBeenCalledTimes(1)

    const procHandle: ProcHandle = {
      pid: 22,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      kill: () => {}
    }
    const localProc: ProcessBackend = { spawn: vi.fn(() => procHandle) }
    const proc = createRoutingProcessBackend({ gateway, local: localProc, resolveRunnerId: () => null })
    expect(proc.spawn(procSpec({ runnerId: null }))).toBe(procHandle)
    expect(localProc.spawn).toHaveBeenCalledTimes(1)

    const localWt = makeLocalWorktrees({ isGitRepo: vi.fn(async () => true) })
    const wt = createRemoteWorktreeAdapters({ gateway, local: localWt, resolveRunnerId: () => null })
    expect(await wt.isGitRepo('/repo')).toBe(true)
    expect(localWt.isGitRepo).toHaveBeenCalledWith('/repo')

    expect(gateway.calls).toHaveLength(0)
  })
})
