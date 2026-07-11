/**
 * Unit tests for the hub-side exec proxies, driven by a fake in-memory gateway
 * (implements request / notify / events / listRunners). No sockets, no runner.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createRemoteWorktreeAdapters,
  createRoutingProcessBackend,
  createRoutingPtyBackend,
  type ProcHandle,
  type ProcSpawnSpec,
  type PtyBackend,
  type PtyExitEvent,
  type PtyHandle,
  type PtySpawnSpec,
  type ProcessBackend,
  type RoutingGateway,
  type RoutingGatewayEvents,
  type WorktreeExecAdapters
} from './exec-proxies'

// ---------------------------------------------------------------------------
// Fake gateway
// ---------------------------------------------------------------------------

interface RecordedCall {
  runnerId: string
  method: string
  params: unknown
  kind: 'request' | 'notify'
}

class FakeGateway implements RoutingGateway {
  readonly calls: RecordedCall[] = []
  readonly runners: Array<{ runnerId: string }> = []
  private readonly handlers = new Map<string, (params: unknown) => unknown>()
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()

  /** Register a canned responder for a hub → runner request method. */
  onMethod(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler)
  }

  request<T = unknown>(runnerId: string, method: string, params?: unknown): Promise<T> {
    this.calls.push({ runnerId, method, params, kind: 'request' })
    const handler = this.handlers.get(method)
    if (!handler) return Promise.resolve(undefined as T)
    try {
      return Promise.resolve(handler(params) as T)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  notify(runnerId: string, method: string, params?: unknown): void {
    this.calls.push({ runnerId, method, params, kind: 'notify' })
  }

  listRunners(): Array<{ runnerId: string }> {
    return this.runners
  }

  readonly events = {
    on: <K extends keyof RoutingGatewayEvents>(
      event: K,
      listener: (payload: RoutingGatewayEvents[K]) => void
    ): (() => void) => {
      const key = event as string
      let set = this.listeners.get(key)
      if (!set) {
        set = new Set()
        this.listeners.set(key, set)
      }
      set.add(listener as (payload: unknown) => void)
      return () => set!.delete(listener as (payload: unknown) => void)
    }
  }

  /** Drive a gateway event to all subscribers. */
  emit<K extends keyof RoutingGatewayEvents>(event: K, payload: RoutingGatewayEvents[K]): void {
    for (const listener of [...(this.listeners.get(event as string) ?? [])]) listener(payload)
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
  runnerId: 'runner-1',
  file: 'bash',
  args: [],
  options: { cwd: '/tmp' },
  ...over
})

const procSpec = (over: Partial<ProcSpawnSpec> = {}): ProcSpawnSpec => ({
  sessionId: 'proc-1',
  runnerId: 'runner-1',
  file: 'git',
  args: ['status'],
  options: { cwd: '/repo' },
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

    const handle = backend.spawn(ptySpec())
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

  it('maps the spawn spec to a pty.spawn frame and issues write/resize/kill frames', () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      local: throwingPty,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = backend.spawn(
      ptySpec({ file: 'zsh', args: ['-l'], options: { cwd: '/work', env: { FOO: 'bar' }, cols: 100, rows: 30 } })
    )

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

  it('disposes the session on runner-lost (exit emitted, later frames dropped)', () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      local: throwingPty,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = backend.spawn(ptySpec())
    const chunks: string[] = []
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 1, data: 'a' })
    gateway.emit('runner-lost', { runnerId: 'runner-1', reason: 'heartbeat-timeout' })

    expect(exit).toEqual({ exitCode: null, signal: 'runner-lost' })

    // Session removed from the demux Map → no further delivery.
    gateway.emit('pty.data', { runnerId: 'runner-1', sessionId: 'sess-1', seq: 2, data: 'b' })
    expect(chunks).toEqual(['a'])
  })

  it('disposes the session on runner-disconnected', () => {
    const gateway = new FakeGateway()
    gateway.onMethod('pty.spawn', () => ({ pid: 1 }))
    const backend = createRoutingPtyBackend({
      gateway,
      local: throwingPty,
      resolveRunnerId: (spec) => spec.runnerId ?? null
    })

    const handle = backend.spawn(ptySpec())
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })

    gateway.emit('runner-disconnected', { runnerId: 'runner-1', reason: 'socket-closed' })
    expect(exit).toEqual({ exitCode: null, signal: 'runner-disconnected' })
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
    let exit: PtyExitEvent | null = null
    handle.onData((d) => chunks.push(d))
    handle.onExit((e) => {
      exit = e
    })

    expect(requireCall(gateway, 'proc.spawn')).toMatchObject({
      runnerId: 'runner-1',
      params: { sessionId: 'proc-1', command: 'git', args: ['status'], cwd: '/repo' }
    })
    await vi.waitFor(() => expect(handle.pid).toBe(555))

    gateway.emit('proc.data', { runnerId: 'runner-1', sessionId: 'proc-1', data: 'one' })
    gateway.emit('proc.data', { runnerId: 'runner-1', sessionId: 'proc-1', data: 'two', stream: 'stderr' })
    expect(chunks).toEqual(['one', 'two'])

    handle.kill('SIGKILL')
    expect(requireCall(gateway, 'proc.kill').params).toEqual({ sessionId: 'proc-1', signal: 'SIGKILL' })

    gateway.emit('proc.exit', { runnerId: 'runner-1', sessionId: 'proc-1', exitCode: 1, signal: null })
    expect(exit).toEqual({ exitCode: 1, signal: undefined })

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
    let exit: PtyExitEvent | null = null
    handle.onExit((e) => {
      exit = e
    })
    gateway.emit('runner-lost', { runnerId: 'runner-1', reason: 'heartbeat-timeout' })
    expect(exit).toEqual({ exitCode: null, signal: 'runner-lost' })
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
