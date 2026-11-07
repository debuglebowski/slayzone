/**
 * proc.* end-to-end contract: hub routing backend ⇄ REAL computer handler.
 *
 * Every other proc test exercises ONE side — `computer/handlers/proc.test.ts` calls
 * the handler directly, `exec-proxies.test.ts` drives a fake gateway. Neither
 * catches a hub/computer DISAGREEMENT, which is exactly the class of bug that
 * shipped: the hub sent `{sessionId}` while the handler parsed `{id}`, and the
 * computer emitted `{id}` while the hub validated `{sessionId}` — so every routed
 * `proc.spawn` threw and every `proc.data` was dropped. Invisible in production
 * only because `ProcSpawnSpec.computerId` was hardcoded null (→ always local).
 *
 * This test wires the two real implementations to each other through the shared
 * frame schemas, so a param-name or notification-shape divergence fails here.
 *
 * It lives here, in the computer, because it needs both sides: the computer depends
 * on `@slayzone/computer-transport` (the hub side), never the reverse.
 *
 * @module computer/handlers/proc-roundtrip.test
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ComputerNotificationMethods,
  procDataParamsSchema,
  procExitParamsSchema,
  TypedEventEmitter
} from '@slayzone/computer-transport/shared'
import {
  createRoutingProcessBackend,
  type ComputerGatewayEvents,
  type RoutingGateway
} from '@slayzone/computer-transport/server'
import { createProcHandlers } from './proc'

const COMPUTER_ID = 'computer-1'

type ProcHandlerTable = Record<string, (params: unknown) => Promise<unknown> | unknown>

/**
 * Bridge the hub's `RoutingGateway` surface onto a real computer handler table:
 * `request` dispatches into the handler, and the handler's `dialer.notify`
 * re-enters the gateway event bus tagged with `computerId` — the same demux the
 * production `HubComputerGateway` performs.
 */
function bridge(
  handlers: ProcHandlerTable,
  events: TypedEventEmitter<ComputerGatewayEvents>
): RoutingGateway {
  return {
    // Same contract as the real gateway: the caller names the reply type `T`.
    request: async <T = unknown>(_computerId: string, method: string, params?: unknown) => {
      const handler = handlers[method]
      if (!handler) throw new Error(`computer has no handler for ${method}`)
      return (await handler(params)) as T
    },
    events,
    // These round-trips never disconnect, so the detach controller's epoch
    // baseline is never consulted — an empty roster is the honest answer.
    listComputers: () => []
  }
}

let dir: string
let cleanup: Array<() => void>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proc-roundtrip-'))
  cleanup = []
})
afterEach(() => {
  for (const fn of cleanup.reverse()) fn()
  rmSync(dir, { recursive: true, force: true })
})

interface LoadedComputer {
  handlers: ProcHandlerTable
  disposeAll: () => void
  events: TypedEventEmitter<ComputerGatewayEvents>
}

function loadComputerProcHandlers(): LoadedComputer {
  const events = new TypedEventEmitter<ComputerGatewayEvents>()
  const created = createProcHandlers({
    dialer: {
      notify: (method: string, params?: unknown) => {
        // Validate like the real gateway's demux does before re-emitting.
        if (method === ComputerNotificationMethods.procData) {
          events.emit('proc.data', {
            computerId: COMPUTER_ID,
            ...procDataParamsSchema.parse(params)
          })
        } else if (method === ComputerNotificationMethods.procExit) {
          events.emit('proc.exit', {
            computerId: COMPUTER_ID,
            ...procExitParamsSchema.parse(params)
          })
        }
        return true
      }
    },
    config: {
      hubUrl: 'ws://127.0.0.1:0/computers',
      name: 'roundtrip',
      allowedRoots: [realpathSync(tmpdir())],
      capabilities: ['proc']
    },
    log: () => {}
  })
  return { handlers: created.handlers, disposeAll: created.disposeAll, events }
}

type RoutedTestHandle = {
  onData(cb: (chunk: string, stream?: string) => void): unknown
  onSpawned(cb: (e: { pid: number }) => void): unknown
  write(data: string): Promise<void>
  kill(): void
}

/** Resolves once the routed process is running on the computer (its spawn reply). */
function spawned(handle: RoutedTestHandle): Promise<void> {
  return new Promise((resolve) => handle.onSpawned(() => resolve()))
}

/** Resolves with the stdout delivered so far once `done` holds for it. */
function stdoutUntil(handle: RoutedTestHandle, done: (out: string) => boolean): Promise<string> {
  let out = ''
  return new Promise((resolve) =>
    handle.onData((chunk, stream) => {
      if (stream === 'stderr') return
      out += chunk
      if (done(out)) resolve(out)
    })
  )
}

/** The computer's next `proc.data` frame for `sessionId` with `seq`, as it leaves the computer. */
function frameLeaves(
  events: TypedEventEmitter<ComputerGatewayEvents>,
  sessionId: string,
  seq: number
): Promise<string> {
  return new Promise((resolve) => {
    const off = events.on('proc.data', (p) => {
      if (p.sessionId !== sessionId || p.seq !== seq || p.stream === 'stderr') return
      off()
      resolve(p.data)
    })
  })
}

describe('proc.* hub⇄computer round trip', () => {
  it('routes a spawn, streams sequenced stdout back, and reports exit', async () => {
    const computer = loadComputerProcHandlers()
    cleanup.push(() => computer.disposeAll())

    const backend = createRoutingProcessBackend({
      gateway: bridge(computer.handlers, computer.events),
      resolveComputerId: () => COMPUTER_ID
    })

    const handle = backend.spawn({
      id: 'rt-1',
      taskId: 'task-1',
      projectId: null,
      computerId: COMPUTER_ID,
      command: 'printf "alpha\\nbeta\\n"',
      cwd: dir
    } as never)

    let out = ''
    handle.onData((chunk) => {
      out += chunk
    })
    const exited = new Promise<{ code: number | null }>((resolve) => {
      handle.onExit((e) => resolve(e))
    })

    const result = await exited
    expect(result.code).toBe(0)
    // Ordering is the contract: 'alpha' must precede 'beta'. A dropped or
    // out-of-order frame corrupts an NDJSON protocol stream irrecoverably.
    expect(out).toContain('alpha')
    expect(out).toContain('beta')
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('beta'))
  })

  it('writes to stdin over the wire (duplex — required for a chat protocol)', async () => {
    const computer = loadComputerProcHandlers()
    cleanup.push(() => computer.disposeAll())

    const backend = createRoutingProcessBackend({
      gateway: bridge(computer.handlers, computer.events),
      resolveComputerId: () => COMPUTER_ID
    })

    // `cat` echoes stdin to stdout — proves the write reached the child.
    const handle = backend.spawn({
      id: 'rt-2',
      taskId: 'task-1',
      projectId: null,
      computerId: COMPUTER_ID,
      command: 'cat',
      cwd: dir
    } as never) as unknown as RoutedTestHandle
    const echoed = stdoutUntil(handle, (out) => out.includes('ping'))
    await spawned(handle)

    // The duplex direction the channel lacked entirely before this change.
    await handle.write('ping\n')
    expect(await echoed).toContain('ping')
    handle.kill()
  })

  it('recovers a dropped stdout frame via proc.getBufferSince, preserving order', async () => {
    const computer = loadComputerProcHandlers()
    cleanup.push(() => computer.disposeAll())

    // Swallow ONE mid-stream stdout notification to simulate a lost frame. The
    // computer still buffered it, so the hub's gap detection must backfill it and
    // deliver the stream contiguously — never skipping ahead.
    let dropped = 0
    const lossy = new TypedEventEmitter<ComputerGatewayEvents>()
    computer.events.on('proc.data', (p) => {
      if (p.stream !== 'stderr' && p.seq === 1 && dropped === 0) {
        dropped++
        return
      }
      lossy.emit('proc.data', p)
    })
    computer.events.on('proc.exit', (p) => lossy.emit('proc.exit', p))

    const backend = createRoutingProcessBackend({
      gateway: {
        request: bridge(computer.handlers, computer.events).request,
        events: lossy,
        listComputers: () => []
      },
      resolveComputerId: () => COMPUTER_ID
    })

    // `cat` echoes each write as it arrives. The next write goes in only once the
    // previous chunk has left the computer, so each is its own seq (0, 1, 2) and
    // seq 1 is a real mid-stream frame, never part of one coalesced chunk.
    const handle = backend.spawn({
      id: 'rt-3',
      taskId: 'task-1',
      projectId: null,
      computerId: COMPUTER_ID,
      command: 'cat',
      cwd: dir
    } as never) as unknown as RoutedTestHandle
    const delivered = stdoutUntil(handle, (out) => out.includes('three'))
    await spawned(handle)
    for (const [seq, word] of ['one', 'two', 'three'].entries()) {
      const left = frameLeaves(computer.events, 'rt-3', seq)
      await handle.write(word)
      expect(await left).toBe(word)
    }

    // Seq 2 arriving after the lost seq 1 is the gap; `three` is only delivered after it.
    expect(dropped).toBe(1) // the drop actually happened
    expect(await delivered).toBe('onetwothree') // …and was invisible downstream
    handle.kill()
  })
})
