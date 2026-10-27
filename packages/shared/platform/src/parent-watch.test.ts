import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchParent, type ParentDeathReason } from './parent-watch'

/**
 * Unit tests for the parent-death detection of a supervised hub or computer. The
 * real process-level behaviour (a SIGKILLed app takes its hub and its computer with
 * it) is proven end to end against each built bundle in
 * packages/apps/app/src/main/sidecar-server-supervisor.test.ts and
 * local-computer-supervisor.test.ts; these pin each signal in isolation, including
 * the ones a single OS cannot show (Windows never reparents, so only the liveness
 * probe and the pipe see it there).
 */

const APP_PID = 4242

function fakeStdin() {
  return Object.assign(new PassThrough(), { unref: vi.fn() })
}

function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

function harness(opts: { platform?: NodeJS.Platform; ppid?: number } = {}) {
  const stdin = fakeStdin()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const parentPid = opts.ppid ?? APP_PID
  let ppid = parentPid
  const alive = new Set([parentPid])
  const reasons: ParentDeathReason[] = []
  const watch = watchParent({
    onParentDeath: (reason) => reasons.push(reason),
    stdin,
    outputs: [stdout, stderr],
    getPpid: () => ppid,
    isAlive: (pid) => alive.has(pid),
    pollIntervalMs: 1000,
    platform: opts.platform ?? 'darwin'
  })
  return {
    stdin,
    stdout,
    stderr,
    reasons,
    watch,
    reparent: (to: number) => {
      ppid = to
    },
    appExits: () => alive.delete(parentPid)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('watchParent — the stdin pipe', () => {
  it('reports parent death when the app’s end of stdin closes', async () => {
    const h = harness()
    const closed = new Promise<void>((r) => h.stdin.once('close', r))
    h.stdin.end()
    await closed
    // 'end' and 'close' both land; reported once.
    expect(h.reasons).toEqual(['parent-pipe-closed'])
  })

  it('reports parent death when stdin errors (a pipe broken from the other side)', () => {
    const h = harness()
    h.stdin.emit('error', new Error('read ECONNRESET'))
    expect(h.reasons).toEqual(['parent-pipe-closed'])
  })

  it('never holds the event loop open on stdin', () => {
    const h = harness()
    // Unreferenced: a child that is done must still exit on its own (a computer
    // whose dialer gave up reports it through its exit code), not idle forever on a
    // pipe nobody writes.
    expect(h.stdin.unref).toHaveBeenCalledTimes(1)
  })
})

describe('watchParent — the parent poll', () => {
  it('reports parent death when the child is reparented (POSIX orphan)', () => {
    const h = harness()
    vi.advanceTimersByTime(1000)
    expect(h.reasons).toEqual([])
    h.reparent(1)
    vi.advanceTimersByTime(1000)
    expect(h.reasons).toEqual(['parent-reparented'])
  })

  it('reports a reparent to a subreaper, not only to pid 1', () => {
    const h = harness()
    h.reparent(777)
    vi.advanceTimersByTime(1000)
    expect(h.reasons).toEqual(['parent-reparented'])
  })

  it('reports parent death when the app pid is gone but ppid never changed (Windows)', () => {
    const h = harness({ platform: 'win32' })
    h.appExits()
    vi.advanceTimersByTime(1000)
    expect(h.reasons).toEqual(['parent-exited'])
  })

  it('treats a POSIX parent of pid 1 at start as already orphaned', () => {
    // The app died before the child armed its watch; init/launchd adopted it.
    const h = harness({ ppid: 1 })
    expect(h.reasons).toEqual(['parent-reparented'])
  })

  it('does not treat pid 1 specially on Windows', () => {
    const h = harness({ platform: 'win32', ppid: 1 })
    vi.advanceTimersByTime(5000)
    expect(h.reasons).toEqual([])
  })
})

describe('watchParent — the output pipes', () => {
  it('reports parent death on EPIPE from stdout, and survives it', () => {
    const h = harness()
    // No listener = an uncaught exception that kills the child mid-teardown (a
    // computer before its agent ptys are disposed, a hub before its stop began).
    expect(() => h.stdout.emit('error', brokenPipe())).not.toThrow()
    expect(h.reasons).toEqual(['parent-output-closed'])
  })

  it('keeps swallowing EPIPE on every later write once the reader is gone', () => {
    const h = harness()
    h.stderr.emit('error', brokenPipe())
    expect(() => h.stderr.emit('error', brokenPipe())).not.toThrow()
    expect(() => h.stdout.emit('error', brokenPipe())).not.toThrow()
    expect(h.reasons).toEqual(['parent-output-closed'])
  })

  it('does not swallow an output error that is not a closed pipe', () => {
    const h = harness()
    const err = Object.assign(new Error('write EIO'), { code: 'EIO' })
    expect(() => h.stdout.emit('error', err)).toThrow('write EIO')
    expect(h.reasons).toEqual([])
  })
})

describe('watchParent — lifecycle', () => {
  it('reports at most once, whichever signal lands first', () => {
    const h = harness()
    h.stdin.emit('error', new Error('gone'))
    h.stdout.emit('error', brokenPipe())
    h.reparent(1)
    vi.advanceTimersByTime(3000)
    expect(h.reasons).toEqual(['parent-pipe-closed'])
  })

  it('stop() disarms every signal', () => {
    const h = harness()
    h.watch.stop()
    h.stdin.emit('error', new Error('gone'))
    h.reparent(1)
    vi.advanceTimersByTime(3000)
    expect(h.reasons).toEqual([])
    // Still no crash on a broken output pipe after stop: the reader is gone either way.
    expect(() => h.stdout.emit('error', brokenPipe())).not.toThrow()
  })

  it('stays quiet while the app is alive', () => {
    const h = harness()
    vi.advanceTimersByTime(60_000)
    expect(h.reasons).toEqual([])
  })
})
