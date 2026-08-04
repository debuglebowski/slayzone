/**
 * proc.* end-to-end contract: hub routing backend ⇄ REAL runner handler.
 *
 * Every other proc test exercises ONE side — `runner/handlers/proc.test.ts` calls
 * the handler directly, `exec-proxies.test.ts` drives a fake gateway. Neither
 * catches a hub/runner DISAGREEMENT, which is exactly the class of bug that
 * shipped: the hub sent `{sessionId}` while the handler parsed `{id}`, and the
 * runner emitted `{id}` while the hub validated `{sessionId}` — so every routed
 * `proc.spawn` threw and every `proc.data` was dropped. Invisible in production
 * only because `ProcSpawnSpec.runnerId` was hardcoded null (→ always local).
 *
 * This test wires the two real implementations to each other through the shared
 * frame schemas, so a param-name or notification-shape divergence fails here.
 *
 * The runner handler lives in `@slayzone/runner` (an app, not a dep of this
 * package), so it is loaded dynamically and skipped if unresolvable — the suite
 * must not go red merely because the runner bundle is absent.
 *
 * @module runner/server/proc-roundtrip.test
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TypedEventEmitter } from '../shared/events'
import { RunnerNotificationMethods } from '../shared/frames'
import { createRoutingProcessBackend, type RoutingGateway } from './exec-proxies'
import type { RunnerGatewayEvents } from './hub-gateway'

const RUNNER_ID = 'runner-1'

type ProcHandlerTable = Record<string, (params: unknown) => Promise<unknown> | unknown>

/**
 * Bridge the hub's `RoutingGateway` surface onto a real runner handler table:
 * `request` dispatches into the handler, and the handler's `dialer.notify`
 * re-enters the gateway event bus tagged with `runnerId` — the same demux the
 * production `HubRunnerGateway` performs.
 */
function bridge(
  handlers: ProcHandlerTable,
  events: TypedEventEmitter<RunnerGatewayEvents>
): RoutingGateway {
  return {
    request: async (_runnerId: string, method: string, params?: unknown) => {
      const handler = handlers[method]
      if (!handler) throw new Error(`runner has no handler for ${method}`)
      return await handler(params)
    },
    events,
    // These round-trips never disconnect, so the detach controller's epoch
    // baseline is never consulted — an empty roster is the honest answer.
    listRunners: () => []
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

interface LoadedRunner {
  handlers: ProcHandlerTable
  disposeAll: () => void
  events: TypedEventEmitter<RunnerGatewayEvents>
}

async function loadRunnerProcHandlers(): Promise<LoadedRunner | null> {
  // Resolved by path, not package name: the runner is an app, not a dependency
  // of this package, so there is no bare specifier to import.
  let mod: {
    createProcHandlers: (ctx: unknown) => { handlers: ProcHandlerTable; disposeAll: () => void }
  }
  try {
    mod = await import('../../../../apps/runner/src/handlers/proc')
  } catch {
    return null
  }
  const events = new TypedEventEmitter<RunnerGatewayEvents>()
  const created = mod.createProcHandlers({
    dialer: {
      notify: (method: string, params?: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>
        if (method === RunnerNotificationMethods.procData) {
          events.emit('proc.data', { runnerId: RUNNER_ID, ...p })
        } else if (method === RunnerNotificationMethods.procExit) {
          events.emit('proc.exit', { runnerId: RUNNER_ID, ...p })
        }
        return true
      }
    },
    config: {
      hubUrl: 'ws://127.0.0.1:0/runners',
      name: 'roundtrip',
      allowedRoots: [realpathSync(tmpdir())],
      capabilities: ['proc']
    },
    log: () => {}
  })
  return { handlers: created.handlers, disposeAll: created.disposeAll, events }
}

describe('proc.* hub⇄runner round trip', () => {
  it('routes a spawn, streams sequenced stdout back, and reports exit', async () => {
    const runner = await loadRunnerProcHandlers()
    if (!runner) return // runner app unavailable in this context
    cleanup.push(() => runner.disposeAll())

    const backend = createRoutingProcessBackend({
      gateway: bridge(runner.handlers, runner.events),
      local: {
        spawn: () => {
          throw new Error('must not fall back to local: a runnerId was resolved')
        }
      },
      resolveRunnerId: () => RUNNER_ID
    })

    const handle = backend.spawn({
      id: 'rt-1',
      taskId: 'task-1',
      projectId: null,
      runnerId: RUNNER_ID,
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
    const runner = await loadRunnerProcHandlers()
    if (!runner) return
    cleanup.push(() => runner.disposeAll())

    const backend = createRoutingProcessBackend({
      gateway: bridge(runner.handlers, runner.events),
      local: {
        spawn: () => {
          throw new Error('must not fall back to local')
        }
      },
      resolveRunnerId: () => RUNNER_ID
    })

    // `cat` echoes stdin to stdout — proves the write reached the child.
    const handle = backend.spawn({
      id: 'rt-2',
      taskId: 'task-1',
      projectId: null,
      runnerId: RUNNER_ID,
      command: 'cat',
      cwd: dir
    } as never)

    let out = ''
    handle.onData((chunk) => {
      out += chunk
    })

    // The duplex direction the channel lacked entirely before this change.
    await new Promise((r) => setTimeout(r, 150))
    ;(handle as unknown as { write: (d: string) => void }).write('ping\n')

    const start = Date.now()
    while (!out.includes('ping') && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(out).toContain('ping')
    handle.kill()
  })

  it('recovers a dropped stdout frame via proc.getBufferSince, preserving order', async () => {
    const runner = await loadRunnerProcHandlers()
    if (!runner) return
    cleanup.push(() => runner.disposeAll())

    // Swallow ONE mid-stream stdout notification to simulate a lost frame. The
    // runner still buffered it, so the hub's gap detection must backfill it and
    // deliver the stream contiguously — never skipping ahead.
    let dropped = 0
    const lossy = new TypedEventEmitter<RunnerGatewayEvents>()
    runner.events.on('proc.data', (p) => {
      if (p.stream !== 'stderr' && typeof p.seq === 'number' && p.seq === 1 && dropped === 0) {
        dropped++
        return
      }
      lossy.emit('proc.data', p)
    })
    runner.events.on('proc.exit', (p) => lossy.emit('proc.exit', p))

    const backend = createRoutingProcessBackend({
      gateway: {
        request: bridge(runner.handlers, runner.events).request,
        events: lossy,
        listRunners: () => []
      },
      local: {
        spawn: () => {
          throw new Error('must not fall back to local')
        }
      },
      resolveRunnerId: () => RUNNER_ID
    })

    // Three separate writes with gaps → three distinct seqs, so seq 1 is a real
    // mid-stream frame rather than part of one coalesced chunk.
    const handle = backend.spawn({
      id: 'rt-3',
      taskId: 'task-1',
      projectId: null,
      runnerId: RUNNER_ID,
      command: 'printf one; sleep 0.2; printf two; sleep 0.2; printf three',
      shell: true,
      cwd: dir
    } as never)

    let out = ''
    handle.onData((chunk, stream) => {
      if (stream === 'stdout') out += chunk
    })
    const exited = new Promise<{ code: number | null }>((resolve) => {
      handle.onExit((e) => resolve(e))
    })
    await exited
    // Give the async backfill a moment to land after exit.
    const start = Date.now()
    while (!out.includes('two') && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(dropped).toBe(1) // the drop actually happened
    expect(out).toBe('onetwothree') // …and was invisible downstream
  })
})
