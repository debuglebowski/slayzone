import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunnerConfig } from '../config'
import { createProcHandlers, ProcMethods, ProcNotifications } from './proc'
import type { RunnerDialer } from './types'

interface Notify {
  method: string
  params: Record<string, unknown>
}

function makeCtx(roots: string[]) {
  const notifies: Notify[] = []
  const dialer: RunnerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return true
    }
  }
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/runners',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['proc']
  }
  return { notifies, ctx: { dialer, config, log: () => {} } }
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function dataFor(notifies: Notify[], id: string, stream: 'stdout' | 'stderr'): string {
  return notifies
    .filter(
      (n) =>
        n.method === ProcNotifications.procData &&
        n.params.id === id &&
        n.params.stream === stream
    )
    .map((n) => n.params.data as string)
    .join('')
}

function exitFor(notifies: Notify[], id: string): Record<string, unknown> | undefined {
  return notifies.find((n) => n.method === ProcNotifications.procExit && n.params.id === id)?.params
}

let dir: string
let roots: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-proc-'))
  roots = [realpathSync(tmpdir())]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createProcHandlers — proc.spawn streaming', () => {
  it('streams stdout then emits proc.exit(0) for a short-lived command', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p1'
    const res = (await proc.handlers[ProcMethods.procSpawn]({
      id,
      command: 'sh',
      args: ['-c', 'printf hello']
    })) as { pid: number | null }
    expect(res.pid).toBeGreaterThan(0)

    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(dataFor(notifies, id, 'stdout')).toBe('hello')
    expect(exitFor(notifies, id)).toMatchObject({ exitCode: 0, signal: null })
    proc.disposeAll()
  })

  it('captures stderr separately from stdout', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-err'
    await proc.handlers[ProcMethods.procSpawn]({
      id,
      command: 'sh',
      args: ['-c', 'printf out; printf err 1>&2']
    })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(dataFor(notifies, id, 'stdout')).toBe('out')
    expect(dataFor(notifies, id, 'stderr')).toBe('err')
    proc.disposeAll()
  })

  it('propagates a non-zero exit code', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-fail'
    await proc.handlers[ProcMethods.procSpawn]({ id, command: 'sh', args: ['-c', 'exit 3'] })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(exitFor(notifies, id)).toMatchObject({ exitCode: 3 })
    proc.disposeAll()
  })

  it('reports a single errored exit (null code + error) for a missing binary — no double-fire', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-enoent'
    // ENOENT emits both 'error' and 'close'; settle() must dedupe to one exit.
    await proc.handlers[ProcMethods.procSpawn]({
      id,
      command: 'definitely-not-a-real-binary-xyz'
    })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    await new Promise((r) => setTimeout(r, 100))
    const exits = notifies.filter(
      (n) => n.method === ProcNotifications.procExit && n.params.id === id
    )
    expect(exits.length).toBe(1)
    expect(exits[0].params.exitCode).toBeNull()
    expect(typeof exits[0].params.error).toBe('string')
    proc.disposeAll()
  })
})

describe('createProcHandlers — env + cwd', () => {
  it('runs in the supplied cwd (inside an allowed root)', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-cwd'
    await proc.handlers[ProcMethods.procSpawn]({ id, command: 'pwd', cwd: realpathSync(dir) })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(dataFor(notifies, id, 'stdout').trim()).toBe(realpathSync(dir))
    proc.disposeAll()
  })

  it('merges env overrides over the inherited environment', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-env'
    await proc.handlers[ProcMethods.procSpawn]({
      id,
      command: 'sh',
      args: ['-c', 'printf "%s" "$RUNNER_TEST_VAR"'],
      env: { RUNNER_TEST_VAR: 'injected' }
    })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(dataFor(notifies, id, 'stdout')).toBe('injected')
    proc.disposeAll()
  })
})

describe('createProcHandlers — proc.kill', () => {
  it('kills a long-running process and emits a signalled exit', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-kill'
    await proc.handlers[ProcMethods.procSpawn]({ id, command: 'sh', args: ['-c', 'sleep 30'] })
    // Give the child a moment to be live before signalling.
    await new Promise((r) => setTimeout(r, 100))
    const res = await proc.handlers[ProcMethods.procKill]({ id })
    expect(res).toEqual({ ok: true })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    const exit = exitFor(notifies, id)!
    // Killed by signal → exitCode null, signal populated.
    expect(exit.exitCode).toBeNull()
    expect(exit.signal).toBeTruthy()
    proc.disposeAll()
  })

  it('kill on an unknown id is a no-op that still acks ok', async () => {
    const { ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    expect(await proc.handlers[ProcMethods.procKill]({ id: 'ghost' })).toEqual({ ok: true })
    proc.disposeAll()
  })
})

describe('createProcHandlers — same-id replacement', () => {
  it('re-spawning an id kills the old process; the superseded one does not emit exit', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'dup'
    await proc.handlers[ProcMethods.procSpawn]({ id, command: 'sh', args: ['-c', 'sleep 30'] })
    await new Promise((r) => setTimeout(r, 50))
    // Replace under the same id (kills the first) with a short-lived command.
    await proc.handlers[ProcMethods.procSpawn]({ id, command: 'sh', args: ['-c', 'printf done'] })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    await new Promise((r) => setTimeout(r, 100))

    // Only the replacement's exit fires — the killed original was superseded.
    const exits = notifies.filter(
      (n) => n.method === ProcNotifications.procExit && n.params.id === id
    )
    expect(exits.length).toBe(1)
    expect(dataFor(notifies, id, 'stdout')).toBe('done')
    proc.disposeAll()
  })
})

describe('createProcHandlers — allowedRoots guard + dispose', () => {
  it('rejects a cwd outside every allowed root before spawning', () => {
    const { ctx } = makeCtx([realpathSync(dir)])
    const proc = createProcHandlers(ctx)
    // procSpawn validates + guards synchronously, so it throws rather than
    // returning a rejected promise.
    expect(() => proc.handlers[ProcMethods.procSpawn]({ id: 'x', command: 'pwd', cwd: '/' })).toThrow(
      /allowedRoots/
    )
    proc.disposeAll()
  })

  it('disposeAll kills every live process and suppresses their exit notifications', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const r1 = (await proc.handlers[ProcMethods.procSpawn]({
      id: 'd1',
      command: 'sh',
      args: ['-c', 'sleep 30']
    })) as { pid: number }
    const r2 = (await proc.handlers[ProcMethods.procSpawn]({
      id: 'd2',
      command: 'sh',
      args: ['-c', 'sleep 30']
    })) as { pid: number }
    await new Promise((r) => setTimeout(r, 100))

    proc.disposeAll()

    // disposeAll kills then clears the map, so the async close handler's settle()
    // short-circuits (procs.get(id) !== child) — no proc.exit is emitted on
    // shutdown. Assert the processes are genuinely dead (process.kill(pid,0)
    // throws ESRCH once reaped) rather than looking for a notification.
    const isDead = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }
    await waitFor(() => isDead(r1.pid) && isDead(r2.pid))
    expect(
      notifies.filter(
        (n) =>
          n.method === ProcNotifications.procExit &&
          (n.params.id === 'd1' || n.params.id === 'd2')
      )
    ).toEqual([])
  })
})
