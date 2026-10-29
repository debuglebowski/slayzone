import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { createProcHandlers, ProcMethods, ProcNotifications } from './proc'
import type { ComputerDialer } from './types'

interface Notify {
  method: string
  params: Record<string, unknown>
}

function makeCtx(
  roots: string[],
  { online = true, config: extra = {} }: { online?: boolean; config?: Partial<ComputerConfig> } = {}
) {
  const notifies: Notify[] = []
  const dialer: ComputerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return online
    }
  }
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['proc'],
    ...extra
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
        n.params.sessionId === id &&
        n.params.stream === stream
    )
    .map((n) => n.params.data as string)
    .join('')
}

function exitFor(notifies: Notify[], id: string): Record<string, unknown> | undefined {
  return notifies.find((n) => n.method === ProcNotifications.procExit && n.params.sessionId === id)
    ?.params
}

let dir: string
let roots: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computer-proc-'))
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
      sessionId: id,
      command: 'sh',
      args: ['-c', 'printf hello']
    })) as { pid: number | null }
    expect(res.pid).toBeGreaterThan(0)

    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(dataFor(notifies, id, 'stdout')).toBe('hello')
    expect(exitFor(notifies, id)).toMatchObject({ exitCode: 0, signal: null })
    proc.disposeAll()
  })

  it('sanitizes the inherited process.env base: strips SlayZone infra/secret, keeps PATH', async () => {
    // A computer-hosted background process must not inherit the computer's own
    // SlayZone infra/secret env (it would leak creds + confuse any nested slay).
    // User env (PATH) survives.
    const saved: Record<string, string | undefined> = {}
    const inject: Record<string, string> = {
      SLAYZONE_HUB_TOKEN: 'inherited-secret',
      SLAYZONE_HUB_ADDRESS: 'hub.example:8443',
      SLAYZONE_FUTURE_UNLISTED: 'fail-closed',
      ELECTRON_RUN_AS_NODE: '1'
    }
    for (const [k, v] of Object.entries(inject)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      const { notifies, ctx } = makeCtx(roots)
      const proc = createProcHandlers(ctx)
      const id = 'p-sanitize'
      await proc.handlers[ProcMethods.procSpawn]({
        sessionId: id,
        command: 'sh',
        args: [
          '-c',
          'echo TOK=[$SLAYZONE_HUB_TOKEN]; echo ADDR=[$SLAYZONE_HUB_ADDRESS]; ' +
            'echo FUT=[$SLAYZONE_FUTURE_UNLISTED]; echo ERAN=[$ELECTRON_RUN_AS_NODE]; ' +
            'echo PATHSET=[${PATH:+yes}]'
        ]
      })
      await waitFor(() => exitFor(notifies, id) !== undefined)
      const out = dataFor(notifies, id, 'stdout')
      expect(out).toContain('TOK=[]')
      expect(out).toContain('ADDR=[]')
      expect(out).toContain('FUT=[]')
      expect(out).toContain('ERAN=[]')
      expect(out).toContain('PATHSET=[yes]')
      proc.disposeAll()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('captures stderr separately from stdout', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-err'
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: id,
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
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: id,
      command: 'sh',
      args: ['-c', 'exit 3']
    })
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
      sessionId: id,
      command: 'definitely-not-a-real-binary-xyz'
    })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    await new Promise((r) => setTimeout(r, 100))
    const exits = notifies.filter(
      (n) => n.method === ProcNotifications.procExit && n.params.sessionId === id
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
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: id,
      command: 'pwd',
      cwd: realpathSync(dir)
    })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(dataFor(notifies, id, 'stdout').trim()).toBe(realpathSync(dir))
    proc.disposeAll()
  })

  it('merges env overrides over the inherited environment', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-env'
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: id,
      command: 'sh',
      args: ['-c', 'printf "%s" "$COMPUTER_TEST_VAR"'],
      env: { COMPUTER_TEST_VAR: 'injected' }
    })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    expect(dataFor(notifies, id, 'stdout')).toBe('injected')
    proc.disposeAll()
  })
})

describe('createProcHandlers — binOverrideDir', () => {
  it('a binary in the override dir shadows the same name further down PATH', async () => {
    // The e2e fake `claude` relies on this: the computer resolves an agent's bare
    // command name on its own PATH, whose login-shell entries come first.
    const shadowed = join(dir, 'path-bin')
    const override = join(dir, 'override-bin')
    mkdirSync(shadowed)
    mkdirSync(override)
    writeFileSync(join(shadowed, 'slz-probe'), '#!/bin/sh\necho REAL\n', { mode: 0o755 })
    writeFileSync(join(override, 'slz-probe'), '#!/bin/sh\necho FAKE\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = [shadowed, savedPath].join(delimiter)
    try {
      const { notifies, ctx } = makeCtx(roots, { config: { binOverrideDir: override } })
      const proc = createProcHandlers(ctx)
      const id = 'p-override'
      await proc.handlers[ProcMethods.procSpawn]({ sessionId: id, command: 'slz-probe' })
      await waitFor(() => exitFor(notifies, id) !== undefined)
      expect(dataFor(notifies, id, 'stdout')).toBe('FAKE\n')
      proc.disposeAll()
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('createProcHandlers — proc.kill', () => {
  it('kills a long-running process and emits a signalled exit', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'p-kill'
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: id,
      command: 'sh',
      args: ['-c', 'sleep 30']
    })
    // Give the child a moment to be live before signalling.
    await new Promise((r) => setTimeout(r, 100))
    const res = await proc.handlers[ProcMethods.procKill]({ sessionId: id })
    expect(res).toEqual({ ok: true })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    const exit = exitFor(notifies, id)!
    // Killed by signal → exitCode null, signal populated.
    expect(exit.exitCode).toBeNull()
    expect(exit.signal).toBeTruthy()
    proc.disposeAll()
  })

  // A shell-wrapped spawn (`pnpm dev`) is a tree: the shell, and what it started.
  // Signalling only the shell left the rest running with the stdout pipe open, so
  // the exit never arrived and the dev server outlived its Stop. Seen on Linux,
  // where `sh` (dash) forks even a lone `sleep 30`; forced here with a background
  // child so it reproduces on every POSIX shell.
  it.skipIf(process.platform === 'win32')(
    'kills the whole process tree, and the exit arrives',
    async () => {
      const { notifies, ctx } = makeCtx(roots)
      const proc = createProcHandlers(ctx)
      const id = 'p-tree'
      await proc.handlers[ProcMethods.procSpawn]({
        sessionId: id,
        command: 'sh',
        args: ['-c', 'sleep 30 & echo $!; wait']
      })
      await waitFor(() => /^\d+\n/.test(dataFor(notifies, id, 'stdout')))
      const grandchild = Number(dataFor(notifies, id, 'stdout').trim())
      await proc.handlers[ProcMethods.procKill]({ sessionId: id })
      await waitFor(() => exitFor(notifies, id) !== undefined, 3000)
      expect(() => process.kill(grandchild, 0)).toThrow()
      proc.disposeAll()
    }
  )

  it('kill on an unknown id is a no-op that still acks ok', async () => {
    const { ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    expect(await proc.handlers[ProcMethods.procKill]({ sessionId: 'ghost' })).toEqual({ ok: true })
    proc.disposeAll()
  })
})

describe('createProcHandlers — same-id replacement', () => {
  it('re-spawning an id kills the old process; the superseded one does not emit exit', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const id = 'dup'
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: id,
      command: 'sh',
      args: ['-c', 'sleep 30']
    })
    await new Promise((r) => setTimeout(r, 50))
    // Replace under the same id (kills the first) with a short-lived command.
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: id,
      command: 'sh',
      args: ['-c', 'printf done']
    })
    await waitFor(() => exitFor(notifies, id) !== undefined)
    await new Promise((r) => setTimeout(r, 100))

    // Only the replacement's exit fires — the killed original was superseded.
    const exits = notifies.filter(
      (n) => n.method === ProcNotifications.procExit && n.params.sessionId === id
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
    expect(() =>
      proc.handlers[ProcMethods.procSpawn]({ sessionId: 'x', command: 'pwd', cwd: '/' })
    ).toThrow(/allowedRoots/)
    proc.disposeAll()
  })

  it('disposeAll kills every live process and suppresses their exit notifications', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const r1 = (await proc.handlers[ProcMethods.procSpawn]({
      sessionId: 'd1',
      command: 'sh',
      args: ['-c', 'sleep 30']
    })) as { pid: number }
    const r2 = (await proc.handlers[ProcMethods.procSpawn]({
      sessionId: 'd2',
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
          (n.params.sessionId === 'd1' || n.params.sessionId === 'd2')
      )
    ).toEqual([])
  })
})

// The proc twin of the pty handler's lifecycle rules (chat agents ride this path):
// a repeat of the same spawn attempt returns the running process, and exits are
// remembered so a hub that was away settles them with the real code.
describe('createProcHandlers — spawn attempts and tombstones', () => {
  type ListResult = {
    sessions: Array<{ sessionId: string; spawnId?: string; pid?: number; seq: number }>
    exited?: Array<{ sessionId: string; spawnId?: string; exitCode: number | null }>
  }

  it('a repeated spawn of the SAME attempt returns the running process', async () => {
    const { ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const params = { sessionId: 'p-dup', spawnId: 'attempt-1', command: 'sleep', args: ['30'] }

    const first = (await proc.handlers[ProcMethods.procSpawn](params)) as { pid: number }
    const again = (await proc.handlers[ProcMethods.procSpawn](params)) as { pid: number }

    expect(again.pid).toBe(first.pid)
    const listed = (await proc.handlers[ProcMethods.procList]({})) as ListResult
    expect(listed.sessions).toEqual([
      { sessionId: 'p-dup', spawnId: 'attempt-1', pid: first.pid, seq: -1 }
    ])
    proc.disposeAll()
  })

  it('an exit is remembered with its real code, and that attempt is never run twice', async () => {
    const { notifies, ctx } = makeCtx(roots)
    const proc = createProcHandlers(ctx)
    const params = {
      sessionId: 'p-once',
      spawnId: 'attempt-1',
      command: 'sh',
      args: ['-c', 'exit 5']
    }
    await proc.handlers[ProcMethods.procSpawn](params)
    await waitFor(() => exitFor(notifies, 'p-once') !== undefined)

    const listed = (await proc.handlers[ProcMethods.procList]({})) as ListResult
    expect(listed.exited).toMatchObject([
      { sessionId: 'p-once', spawnId: 'attempt-1', exitCode: 5 }
    ])
    await expect(
      Promise.resolve().then(() => proc.handlers[ProcMethods.procSpawn](params))
    ).rejects.toThrow(/already ran/)
    proc.disposeAll()
  })

  it('an exit the hub could not receive keeps its stdout for replay', async () => {
    const { ctx } = makeCtx(roots, { online: false })
    const proc = createProcHandlers(ctx)
    await proc.handlers[ProcMethods.procSpawn]({
      sessionId: 'p-offline',
      spawnId: 'attempt-1',
      command: 'sh',
      args: ['-c', 'printf "last words"']
    })
    await waitFor(
      () => ((proc.handlers[ProcMethods.procList]({}) as ListResult).exited ?? []).length > 0
    )

    const replay = (await proc.handlers[ProcMethods.procGetBufferSince]({
      sessionId: 'p-offline',
      seq: -1
    })) as { frames: Array<{ data: string }> }
    expect(replay.frames.map((f) => f.data).join('')).toBe('last words')
    proc.disposeAll()
  })
})
