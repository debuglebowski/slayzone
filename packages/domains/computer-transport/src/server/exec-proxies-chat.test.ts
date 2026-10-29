/**
 * The routed `ChatProcHandle` (createRoutingChatBackend): it reports a start only
 * once the computer confirmed it, says why a start failed, confirms every write,
 * and never lets one spawn's frames or writes reach another.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const diagnostics = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }))
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: (e: Record<string, unknown>) => diagnostics.events.push(e)
}))

import { ComputerTransportErrorCodes, RpcError, TypedEventEmitter } from '../shared'
import { createRoutingChatBackend, type RoutingGateway } from './exec-proxies'
import type { ComputerDescriptor, ComputerGatewayEvents } from './hub-gateway'
import type { ChatProcHandle, ChatSpawnSpec } from '@slayzone/terminal/server'

interface Call {
  computerId: string
  method: string
  params: Record<string, unknown>
}

class Gateway implements RoutingGateway {
  readonly calls: Call[] = []
  readonly events = new TypedEventEmitter<ComputerGatewayEvents>()
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
  connected = true
  on(method: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, handler)
  }
  request<T = unknown>(computerId: string, method: string, params?: unknown): Promise<T> {
    if (!this.connected) {
      return Promise.reject(
        new RpcError(ComputerTransportErrorCodes.unknownComputer, `${computerId} not connected`)
      )
    }
    const p = (params ?? {}) as Record<string, unknown>
    this.calls.push({ computerId, method, params: p })
    const handler = this.handlers.get(method)
    if (!handler) return Promise.resolve(undefined as T)
    try {
      return Promise.resolve(handler(p)) as Promise<T>
    } catch (err) {
      return Promise.reject(err)
    }
  }
  listComputers(): ComputerDescriptor[] {
    return []
  }
  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method)
  }
}

const spec = (over: Partial<ChatSpawnSpec> = {}): ChatSpawnSpec => ({
  sessionId: 'task-1:tab-1',
  taskId: 'task-1',
  computerId: 'computer-1',
  binaryName: 'claude',
  args: ['-p'],
  cwd: '/repo',
  env: {},
  ...over
})

function backendFor(gateway: Gateway) {
  return createRoutingChatBackend({ gateway, resolveComputerId: (s) => s.computerId })
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function spawnIdOf(gateway: Gateway, i = 0): string {
  return gateway.of('proc.spawn')[i]!.params.spawnId as string
}

afterEach(() => {
  diagnostics.events.length = 0
})

describe('routed chat start', () => {
  it('reports the start only after the computer confirmed it', async () => {
    const gateway = new Gateway()
    const reply = deferred<{ pid: number }>()
    gateway.on('proc.spawn', () => reply.promise)
    const handle = await backendFor(gateway).spawn(spec())
    let spawned = false
    handle.onSpawn(() => (spawned = true))
    await tick(20)
    expect(spawned).toBe(false)
    reply.resolve({ pid: 42 })
    await vi.waitFor(() => expect(spawned).toBe(true))
    expect(handle.pid).toBe(42)
  })

  it('a missing binary is a typed start failure naming it; no start is reported', async () => {
    const gateway = new Gateway()
    gateway.on('proc.spawn', () => {
      throw new RpcError(
        ComputerTransportErrorCodes.refusedByComputer,
        "claude was not found on this computer's PATH",
        { reason: 'binary-not-found', binary: 'claude' }
      )
    })
    const handle = await backendFor(gateway).spawn(spec())
    let spawned = false
    handle.onSpawn(() => (spawned = true))
    const err = await new Promise<Error>((resolve) => handle.onError(resolve))
    expect(err).toMatchObject({ code: 'cli-not-installed', binary: 'claude' })
    expect(err.message).toContain('not found')
    await tick(10)
    expect(spawned).toBe(false)
  })

  it('any other refusal is a start failure carrying the computer’s words', async () => {
    const gateway = new Gateway()
    gateway.on('proc.spawn', () => {
      throw new RpcError(ComputerTransportErrorCodes.refusedByComputer, 'outside allowed roots')
    })
    const handle = await backendFor(gateway).spawn(spec())
    const err = await new Promise<Error>((resolve) => handle.onError(resolve))
    expect(err).toMatchObject({ code: 'spawn-refused' })
    expect(err.message).toContain('outside allowed roots')
  })

  it('a pid-less start that exits with an error is a start failure', async () => {
    const gateway = new Gateway()
    gateway.on('proc.spawn', () => ({ pid: null }))
    const handle = await backendFor(gateway).spawn(spec())
    let spawned = false
    handle.onSpawn(() => (spawned = true))
    const failed = new Promise<Error>((resolve) => handle.onError(resolve))
    await tick(10)
    gateway.events.emit('proc.exit', {
      computerId: 'computer-1',
      sessionId: 'task-1:tab-1',
      spawnId: spawnIdOf(gateway),
      exitCode: null,
      signal: null,
      error: 'spawn claude ENOENT'
    })
    const err = await failed
    expect(err).toMatchObject({ code: 'cli-not-installed' })
    expect(spawned).toBe(false)
  })

  it('passes the admission lane to the computer', async () => {
    const gateway = new Gateway()
    gateway.on('proc.spawn', () => ({ pid: 1 }))
    await backendFor(gateway).spawn(spec({ admission: 'background' }))
    expect(gateway.of('proc.spawn')[0]!.params.admission).toBe('background')
  })
})

describe('routed chat writes', () => {
  async function started(gateway: Gateway): Promise<ChatProcHandle> {
    gateway.on('proc.spawn', () => ({ pid: 7 }))
    const handle = await backendFor(gateway).spawn(spec())
    await new Promise<void>((resolve) => handle.onSpawn(resolve))
    return handle
  }

  it('resolves once the computer confirms delivery, tagged with the attempt + writeId', async () => {
    const gateway = new Gateway()
    gateway.on('proc.write', () => ({ ok: true, delivered: true }))
    const handle = await started(gateway)
    await expect(handle.write('hi\n', { writeId: 'msg-1' })).resolves.toBeUndefined()
    expect(gateway.of('proc.write')[0]!.params).toEqual({
      sessionId: 'task-1:tab-1',
      spawnId: spawnIdOf(gateway),
      writeId: 'msg-1',
      data: 'hi\n'
    })
  })

  it('a refused write rejects as not delivered', async () => {
    const gateway = new Gateway()
    gateway.on('proc.write', () => {
      throw new RpcError(ComputerTransportErrorCodes.refusedByComputer, 'no process', {
        reason: 'unknown-session'
      })
    })
    const handle = await started(gateway)
    await expect(handle.write('hi\n')).rejects.toMatchObject({ code: 'not-delivered' })
  })

  it('a write while the computer is unreachable rejects as link-down, sending nothing', async () => {
    const gateway = new Gateway()
    const handle = await started(gateway)
    gateway.connected = false
    await expect(handle.write('hi\n')).rejects.toMatchObject({ code: 'link-down' })
  })

  it('a write while the session is detached rejects as link-down without a request', async () => {
    const gateway = new Gateway()
    const handle = await started(gateway)
    gateway.events.emit('computer-lost', { computerId: 'computer-1', reason: 'heartbeat-timeout' })
    const before = gateway.calls.length
    await expect(handle.write('hi\n')).rejects.toMatchObject({ code: 'link-down' })
    expect(gateway.of('proc.write')).toHaveLength(0)
    expect(gateway.calls.length).toBe(before)
  })

  it('a write after the process exited rejects as not delivered', async () => {
    const gateway = new Gateway()
    const handle = await started(gateway)
    gateway.events.emit('proc.exit', {
      computerId: 'computer-1',
      sessionId: 'task-1:tab-1',
      spawnId: spawnIdOf(gateway),
      exitCode: 0,
      signal: null
    })
    await expect(handle.write('late\n')).rejects.toMatchObject({ code: 'not-delivered' })
  })

  it('an old computer (unconfirmed {ok:true}) is reported once per computer', async () => {
    const gateway = new Gateway()
    gateway.on('proc.write', () => ({ ok: true }))
    const handle = await started(gateway)
    await handle.write('a\n')
    await handle.write('b\n')
    const second = await backendFor(gateway).spawn(spec({ sessionId: 'task-1:tab-2' }))
    await new Promise<void>((resolve) => second.onSpawn(resolve))
    await second.write('c\n')
    const unconfirmed = diagnostics.events.filter((e) => e.event === 'chat.write_unconfirmed')
    expect(unconfirmed).toHaveLength(1)
    expect(unconfirmed[0]!.payload).toMatchObject({ computerId: 'computer-1' })
  })

  it('a kill names its attempt, so it can never hit a replacement', async () => {
    const gateway = new Gateway()
    const handle = await started(gateway)
    handle.kill('SIGTERM')
    expect(gateway.of('proc.kill')[0]!.params).toEqual({
      sessionId: 'task-1:tab-1',
      spawnId: spawnIdOf(gateway),
      signal: 'SIGTERM'
    })
  })
})

describe('routed chat frames', () => {
  it('drops output tagged with another spawn attempt', async () => {
    const gateway = new Gateway()
    gateway.on('proc.spawn', () => ({ pid: 7 }))
    const handle = await backendFor(gateway).spawn(spec())
    await new Promise<void>((resolve) => handle.onSpawn(resolve))
    const out: string[] = []
    handle.onStdout((c) => out.push(c))
    const base = { computerId: 'computer-1', sessionId: 'task-1:tab-1' }
    gateway.events.emit('proc.data', { ...base, spawnId: 'someone-else', seq: 0, data: 'stale' })
    gateway.events.emit('proc.data', { ...base, spawnId: spawnIdOf(gateway), seq: 0, data: 'mine' })
    expect(out).toEqual(['mine'])
  })

  it('every spawn shares one listener pair on the gateway (no per-spawn leak)', async () => {
    const gateway = new Gateway()
    gateway.on('proc.spawn', () => ({ pid: 7 }))
    const backend = backendFor(gateway)
    const listeners = (gateway.events as unknown as { listeners: Map<string, Set<unknown>> })
      .listeners
    const count = (): number =>
      (listeners.get('proc.data')?.size ?? 0) + (listeners.get('proc.exit')?.size ?? 0)
    const handles: ChatProcHandle[] = []
    handles.push(await backend.spawn(spec({ sessionId: 's:0' })))
    const after1 = count()
    for (let i = 1; i < 20; i++) handles.push(await backend.spawn(spec({ sessionId: `s:${i}` })))
    expect(count()).toBe(after1)
  })
})
