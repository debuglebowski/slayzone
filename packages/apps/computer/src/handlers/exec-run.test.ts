/**
 * `exec.run`: a one-shot shell command the hub asks for (an automation action),
 * run HERE in a jailed cwd — a project's own folder on this computer when the hub
 * names the project — answering its output; a timeout kills the whole tree.
 *
 * Real child processes only where the behaviour IS the OS boundary (argv reaching a
 * program unsplit, stdin, shell + cwd, exit status + stderr, a real process tree
 * killed). Even there the handler's own watchdog is a hand-driven clock that never
 * fires on its own, so a slow box can't turn a pass into `timedOut`. Path / jail /
 * resolution contracts and the timeout sequence run against an injected spawn.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { type ExecRunDeps, KILL_GRACE_MS, createExecRunHandlers } from './exec-run'

const isWin = process.platform === 'win32'

let dir: string

/** A watchdog clock that only fires when the test says so. */
function manualClock() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      pending.set(id, { fn, ms })
      return id
    },
    clearTimer: (id: unknown) => {
      pending.delete(id as number)
    },
    /** Delays of the timers armed and not yet fired/cleared, in arming order. */
    armed: () => [...pending.values()].map((t) => t.ms),
    /** Fire the earliest-armed pending timer with delay `ms`. */
    fire(ms: number) {
      const entry = [...pending.entries()].find(([, t]) => t.ms === ms)
      if (!entry) throw new Error(`no pending ${ms}ms timer (armed: ${this.armed()})`)
      pending.delete(entry[0])
      entry[1].fn()
    }
  }
}

function handlersWith(deps: ExecRunDeps): (params: unknown) => Promise<unknown> {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [realpathSync(tmpdir())],
    capabilities: []
  }
  const handlers = createExecRunHandlers(
    { dialer: { notify: () => true }, config, log: () => {} },
    () => ({ get: (id: string) => (id === 'p1' ? { path: dir } : null) }),
    deps
  )
  return (params) =>
    Promise.resolve((handlers[HubToComputerMethods.execRun] as (p: unknown) => unknown)(params))
}

/** Real processes; the handler's watchdog never fires by itself. */
const realRun = (params: unknown) => handlersWith(manualClock())(params)

type FakeChild = ChildProcess & {
  stdout: PassThrough
  stderr: PassThrough
  close(code: number | null): void
}

/** A child that does nothing until the test drives its streams and its exit. */
function fakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild
  Object.assign(child, {
    pid,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    close(code: number | null) {
      child.stdout.end()
      child.stderr.end()
      // After the streams drain, as a real child's 'close' comes after its output.
      setImmediate(() => child.emit('close', code))
    }
  })
  return child
}

/** An injected spawn that hands out `child` and records how it was called. */
function fakeSpawn(child: FakeChild = fakeChild()) {
  const calls: { file: string; args: string[]; opts: { cwd?: string } }[] = []
  const spawnFn = ((file: string, args: string[], opts: { cwd?: string }) => {
    calls.push({ file, args, opts })
    return child
  }) as unknown as typeof spawn
  return { spawn: spawnFn, calls, child }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-exec-run-')))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

// A program the hub names by argv (the conflict analysis's agent CLI) is resolved
// and run HERE with no shell: no hub-side POSIX quoting or `$HOME`, which broke on a
// Windows computer. A bare name is looked up on this computer's PATH, then under its
// home (`homeFallbacks`).
describe('exec.run with argv', () => {
  it.skipIf(isWin)(
    'runs the program unsplit, no shell — args with spaces and quotes stay one each',
    async () => {
      const res = (await realRun({
        argv: { file: 'printf', args: ['%s|', "it's a $(prompt)", 'two words'] },
        cwd: dir,
        timeoutMs: 5000
      })) as { stdout: string; status: number }
      expect(res.status).toBe(0)
      expect(res.stdout).toBe("it's a $(prompt)|two words|")
    }
  )

  // Resolution is the contract here; running a resolved file is the case above.
  it.skipIf(isWin)('a home fallback when not on PATH', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'computer-home-')))
    const savedHome = process.env.HOME
    try {
      mkdirSync(join(home, 'bin-x'), { recursive: true })
      const tool = join(home, 'bin-x', 'my-agent-cli')
      writeFileSync(tool, '#!/bin/sh\necho from-home "$1"\n')
      chmodSync(tool, 0o755)
      process.env.HOME = home
      const fake = fakeSpawn()
      const pending = handlersWith({ ...manualClock(), spawn: fake.spawn })({
        argv: { file: 'my-agent-cli', args: ['ok'], homeFallbacks: ['bin-x/my-agent-cli'] },
        cwd: dir,
        timeoutMs: 5000
      })
      // The home tool itself, its args unsplit, no shell in between.
      expect(fake.calls).toEqual([
        { file: tool, args: ['ok'], opts: expect.objectContaining({ cwd: dir }) }
      ])
      fake.child.stdout.write('from-home ok\n')
      fake.child.close(0)
      const res = (await pending) as { stdout: string; status: number }
      expect(res.stdout.trim()).toBe('from-home ok')
    } finally {
      process.env.HOME = savedHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  // A multi-line prompt cannot ride a Windows cmd line (it ends at the first
  // newline): it goes to the program's stdin, intact.
  it.skipIf(isWin)('stdin reaches the program intact', async () => {
    const res = (await realRun({
      argv: { file: 'cat', args: [], stdin: 'line one\nline "two"\n' },
      cwd: dir,
      timeoutMs: 5000
    })) as { stdout: string; status: number }
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('line one\nline "two"\n')
  })

  it('a program found nowhere: status 127, naming it', async () => {
    const fake = fakeSpawn()
    const res = (await handlersWith({ ...manualClock(), spawn: fake.spawn })({
      argv: { file: 'no-such-agent-cli-x', args: [] },
      cwd: dir,
      timeoutMs: 5000
    })) as { stderr: string; status: number }
    expect(res.status).toBe(127)
    expect(res.stderr).toMatch(/no-such-agent-cli-x/)
    expect(fake.calls).toEqual([])
  })
})

describe('exec.run', () => {
  it('runs the command through the shell in the given folder', async () => {
    expect(
      await realRun({ command: 'echo "$((1+2))" && pwd', cwd: dir, timeoutMs: 10_000 })
    ).toEqual({
      stdout: `3\n${dir}\n`,
      stderr: '',
      status: 0,
      timedOut: false
    })
  })

  // Final review M4: each pipe chunk was decoded on its own, so a character split
  // across two chunks came out as U+FFFD. A 3-byte character delivered as 1 + 2
  // bytes in two explicitly separate chunks (a later macrotask), on stdout and
  // stderr — a real pipe may coalesce the writes and never exercise the split.
  it('a multi-byte character split across pipe chunks survives', async () => {
    const fake = fakeSpawn()
    const pending = handlersWith({ ...manualClock(), spawn: fake.spawn })({
      command: 'agent',
      cwd: dir,
      timeoutMs: 10_000
    })
    const euro = Buffer.from('€')
    const { stdout, stderr } = fake.child
    for (const s of [stdout, stderr]) s.write(euro.subarray(0, 1))
    await new Promise((r) => setImmediate(r))
    for (const s of [stdout, stderr]) s.write(euro.subarray(1))
    fake.child.close(0)
    const out = (await pending) as { stdout: string; stderr: string }
    expect(out.stdout).toBe('€')
    expect(out.stderr).toBe('€')
  })

  it("a project id: the project's folder on this computer", async () => {
    const fake = fakeSpawn()
    const pending = handlersWith({ ...manualClock(), spawn: fake.spawn })({
      command: 'pwd',
      projectId: 'p1',
      timeoutMs: 10_000
    })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.opts.cwd).toBe(dir)
    fake.child.close(0)
    await pending
  })

  it('answers a failing command with its status and stderr', async () => {
    expect(await realRun({ command: 'echo no >&2; exit 3', cwd: dir, timeoutMs: 10_000 })).toEqual({
      stdout: '',
      stderr: 'no\n',
      status: 3,
      timedOut: false
    })
  })

  // The sequence, on a hand-driven clock: at the timeout the whole group gets TERM;
  // a tree that ignores it gets KILL after the grace; when the leader closes, the
  // group is KILLed once more (a backgrounded child may still hold it).
  it.skipIf(isWin)('a timeout ends the whole tree and says so', async () => {
    const clock = manualClock()
    const fake = fakeSpawn(fakeChild(4242))
    const signals: [number, NodeJS.Signals][] = []
    const pending = handlersWith({
      ...clock,
      spawn: fake.spawn,
      killGroup: (pgid, sig) => signals.push([pgid, sig])
    })({ command: 'sleep 30 & sleep 30', cwd: dir, timeoutMs: 300 })

    expect(clock.armed()).toEqual([300])
    clock.fire(300)
    expect(signals).toEqual([[4242, 'SIGTERM']])
    clock.fire(KILL_GRACE_MS)
    expect(signals).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL']
    ])
    fake.child.close(null)
    const out = (await pending) as { timedOut: boolean }
    expect(out.timedOut).toBe(true)
    expect(signals.at(-1)).toEqual([4242, 'SIGKILL'])
  })

  // The real tree: a shell with two backgrounded descendants. Once both report
  // their pids, the watchdog fires; the answer arrives only when every holder of
  // the output pipe is gone, and each captured pid is then dead (or a zombie
  // awaiting its reaper) — proven per pid, not inferred from elapsed time.
  it.skipIf(isWin)('a timeout ends a real process tree, every descendant', async () => {
    const clock = manualClock()
    const pids: number[] = []
    let ready!: () => void
    const descendantsUp = new Promise<void>((r) => {
      ready = r
    })
    const watchingSpawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args)
      let seen = ''
      child.stdout?.on('data', (d: string | Buffer) => {
        seen += String(d)
        const found = seen.match(/\d+/g) ?? []
        if (found.length >= 2 && pids.length === 0) {
          pids.push(...found.slice(0, 2).map(Number))
          ready()
        }
      })
      return child
    }) as typeof spawn
    const pending = handlersWith({ ...clock, spawn: watchingSpawn })({
      command: 'sleep 30 & echo $!; sleep 30 & echo $!; wait',
      cwd: dir,
      timeoutMs: 300
    })

    await descendantsUp
    clock.fire(300)
    const out = (await pending) as { timedOut: boolean }
    expect(out.timedOut).toBe(true)
    for (const pid of pids) expect(isGone(pid), `pid ${pid}`).toBe(true)
  })

  it('refuses a folder outside its roots', async () => {
    const fake = fakeSpawn()
    await expect(
      handlersWith({ ...manualClock(), spawn: fake.spawn })({
        command: 'pwd',
        cwd: '/etc',
        timeoutMs: 1000
      })
    ).rejects.toThrow(/outside/)
    expect(fake.calls).toEqual([])
  })
})

/** Exited: no such process, or a zombie only its reaper still has to collect. */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'
  }
  let stat = ''
  try {
    stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
  } catch {
    return true // ps found nothing: gone between the two checks
  }
  return stat === '' || stat.startsWith('Z')
}
