/**
 * What saving terminal history costs the disk, and that the save stays correct when
 * a shutdown write overtakes one still in flight.
 *
 * Regression (2026-11-09): every task terminal rewrote its WHOLE scrollback (up to
 * 750 KiB) once a second for as long as its output kept changing — and an agent's
 * spinner never stops changing it. ~0.75 MB/s per busy terminal, ~200 GB a day for
 * ten agents. The shutdown write also shared the async writes' temp file and was not
 * ordered with them, so an older copy could land last.
 *
 * Every file write the computer makes goes through the wrapped `node:fs` below,
 * which counts the bytes (and lets a test act at the moment a write is issued).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as nodePty from 'node-pty'
import type { ComputerConfig } from '../config'
import { createPtyHandlers } from './pty'
import { createPtyHistory } from '../pty-history'

const io = vi.hoisted(() => ({
  bytes: 0,
  writes: 0,
  /** Runs once, synchronously, when the next async write is issued. */
  onAsyncWrite: undefined as (() => void) | undefined
}))

function count(data: unknown): void {
  io.writes++
  io.bytes +=
    typeof data === 'string' ? Buffer.byteLength(data) : ((data as Uint8Array)?.byteLength ?? 0)
}
function asyncWriteIssued(): void {
  const hook = io.onAsyncWrite
  io.onAsyncWrite = undefined
  hook?.()
}

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const wrapped = {
    ...fs,
    writeFileSync: ((file: never, data: unknown, ...rest: never[]) => {
      count(data)
      return fs.writeFileSync(file, data as never, ...rest)
    }) as typeof fs.writeFileSync,
    appendFileSync: ((file: never, data: unknown, ...rest: never[]) => {
      count(data)
      return fs.appendFileSync(file, data as never, ...rest)
    }) as typeof fs.appendFileSync,
    writeSync: ((fd: number, data: unknown, ...rest: never[]) => {
      count(data)
      return fs.writeSync(fd, data as never, ...rest)
    }) as typeof fs.writeSync,
    appendFile: ((file: never, data: unknown, ...rest: never[]) => {
      count(data)
      asyncWriteIssued()
      return fs.appendFile(file, data as never, ...(rest as [never]))
    }) as typeof fs.appendFile,
    writeFile: ((file: never, data: unknown, ...rest: never[]) => {
      count(data)
      asyncWriteIssued()
      return fs.writeFile(file, data as never, ...(rest as [never]))
    }) as typeof fs.writeFile
  }
  return { ...wrapped, default: wrapped }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof import('node:fs/promises')>()
  const wrapped = {
    ...fsp,
    writeFile: ((file: never, data: unknown, ...rest: never[]) => {
      count(data)
      asyncWriteIssued()
      return fsp.writeFile(file, data as never, ...rest)
    }) as typeof fsp.writeFile,
    appendFile: ((file: never, data: unknown, ...rest: never[]) => {
      count(data)
      asyncWriteIssued()
      return fsp.appendFile(file, data as never, ...rest)
    }) as typeof fsp.appendFile
  }
  return { ...wrapped, default: wrapped }
})

const TASK = '5decc957-277f-4e1e-82a7-02fd3668df54'
const SESSION = `${TASK}:3d5848be-0000-4000-8000-000000000001`

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  io.onAsyncWrite = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const historyDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'slz-pty-history-writes-'))
  dirs.push(d)
  return d
}

function ctx() {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [tmpdir(), process.cwd()],
    capabilities: ['pty']
  }
  return { dialer: { notify: () => true }, config, log: () => {} }
}

function computer(dir: string, flushMs?: number) {
  let onData: ((d: string) => void) | undefined
  let onExit: ((e: { exitCode: number; signal: number }) => void) | undefined
  const proc = {
    pid: 4321,
    kill: vi.fn(() => onExit?.({ exitCode: 0, signal: 1 })),
    write: vi.fn(),
    resize: vi.fn(),
    onData: (l: typeof onData) => {
      onData = l
      return { dispose() {} }
    },
    onExit: (l: typeof onExit) => {
      onExit = l
      return { dispose() {} }
    }
  } as unknown as nodePty.IPty
  const pty = createPtyHandlers(ctx(), undefined, {
    spawnPty: (() => proc) as unknown as typeof nodePty.spawn,
    history: createPtyHistory({ dir, ...(flushMs !== undefined ? { flushMs } : {}) })
  })
  const spawn = () =>
    pty.handlers['pty.spawn']({
      sessionId: SESSION,
      taskId: TASK,
      command: '/bin/sh',
      cwd: process.cwd()
    })
  const replay = async () => {
    const res = (await pty.handlers['pty.getReplay']({ sessionId: SESSION, afterSeq: -1 })) as {
      prelude?: string
      chunks: Array<{ data: string }>
    }
    return (res.prelude ?? '') + res.chunks.map((c) => c.data).join('')
  }
  return { pty, out: (d: string) => onData?.(d), spawn, replay }
}

/** Real time until no write has been issued for `quietMs` (fs callbacks are real I/O). */
async function ioQuiet(quietMs = 150): Promise<void> {
  let last = -1
  while (last !== io.writes) {
    last = io.writes
    await new Promise((r) => setTimeout(r, quietMs))
  }
}

const savedFile = (dir: string) => {
  const files = readdirSync(join(dir, TASK)).filter((f) => f.endsWith('.txt'))
  expect(files).toHaveLength(1)
  return readFileSync(join(dir, TASK, files[0]!), 'utf8')
}

/** One frame of an agent TUI's spinner: back to the status line, redraw it. */
const spinnerFrame = (i: number) =>
  `\r\x1b[2K\x1b[38;5;174m${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[i % 10]}\x1b[0m Thinking… \x1b[2m(${Math.floor(i / 10)}s · esc to interrupt)\x1b[0m`

describe('what saving terminal history writes', () => {
  it('a minute of spinner over a big scrollback writes about what the terminal printed, not the scrollback 60 times', async () => {
    const dir = historyDir()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const c = computer(dir) // the default flush interval
    await c.spawn()
    // An agent session that has already printed a lot: 512 KiB of scrollback.
    const line = `${'agent output '.repeat(9)}\r\n`
    let scrollback = 0
    while (scrollback < 512 * 1024) {
      c.out(line)
      scrollback += line.length
    }
    c.out('SCROLLBACK_END\r\n')
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    await ioQuiet()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    const startBytes = io.bytes
    let printed = 0
    // 60 s of spinner, a frame every 100 ms.
    for (let i = 0; i < 600; i++) {
      const frame = spinnerFrame(i)
      c.out(frame)
      printed += Buffer.byteLength(frame)
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    await ioQuiet()
    const written = io.bytes - startBytes
    console.log(`[pty-history] 60 s spinner over 512 KiB: printed ${printed} B, wrote ${written} B`)
    // Bound: what was printed, plus at most one rewrite of the whole scrollback.
    expect(written).toBeLessThanOrEqual(2 * printed + 600 * 1024)

    // Nothing lost: the saved file holds the scrollback and the last frame.
    const saved = savedFile(dir)
    expect(saved).toContain('SCROLLBACK_END')
    expect(saved.endsWith(spinnerFrame(599))).toBe(true)

    c.pty.disposeAll()
    const after = computer(dir)
    await after.spawn()
    const text = await after.replay()
    expect(text).toContain('SCROLLBACK_END')
    expect(text).toContain(spinnerFrame(599))
    after.pty.disposeAll()
  })

  it('a steady stream for half an hour keeps the file bounded and every write proportional', async () => {
    const dir = historyDir()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const c = computer(dir)
    await c.spawn()
    const startBytes = io.bytes
    let printed = 0
    // 4 KiB a second for 30 min: ~7 MiB through a 750 KiB scrollback (compacting ~9 times).
    const chunk = `${'x'.repeat(4094)}\r\n`
    for (let s = 0; s < 1800; s++) {
      c.out(chunk)
      printed += chunk.length
      await vi.advanceTimersByTimeAsync(1_000)
      if (s % 300 === 299) {
        vi.useRealTimers()
        await ioQuiet(30)
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
        })
      }
    }
    vi.useRealTimers()
    await ioQuiet()
    const written = io.bytes - startBytes
    console.log(`[pty-history] 30 min at 4 KiB/s: printed ${printed} B, wrote ${written} B`)
    expect(written).toBeLessThanOrEqual(3 * printed)
    // The file never grows past a small multiple of the scrollback cap.
    expect(Buffer.byteLength(savedFile(dir))).toBeLessThanOrEqual(3 * 750 * 1024)
    c.pty.disposeAll()
  }, 120_000)
})

describe('a shutdown write overtaking one in flight', () => {
  it('a full write still in flight when the computer shuts down never lands over the newer copy', async () => {
    const dir = historyDir()
    const c = computer(dir, 20)
    await c.spawn()
    c.out('OLDER_OUTPUT\r\n')
    // The moment the throttled write is issued (its bytes already read), more output
    // arrives and the computer shuts down: the shutdown write must be the one that stays.
    io.onAsyncWrite = () => {
      c.out('NEWER_OUTPUT_AT_SHUTDOWN\r\n')
      c.pty.disposeAll()
    }
    await new Promise((r) => setTimeout(r, 60))
    await ioQuiet()
    expect(io.onAsyncWrite).toBeUndefined() // the hook ran
    const saved = savedFile(dir)
    expect(saved).toContain('OLDER_OUTPUT')
    expect(saved).toContain('NEWER_OUTPUT_AT_SHUTDOWN')
    expect(readdirSync(join(dir, TASK)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('an append still in flight when the computer shuts down is neither lost nor doubled', async () => {
    const dir = historyDir()
    const c = computer(dir, 20)
    await c.spawn()
    c.out('FIRST\r\n')
    await new Promise((r) => setTimeout(r, 60))
    await ioQuiet(40)
    c.out('SECOND\r\n')
    io.onAsyncWrite = () => {
      c.out('THIRD\r\n')
      c.pty.disposeAll()
    }
    await new Promise((r) => setTimeout(r, 60))
    await ioQuiet()
    expect(io.onAsyncWrite).toBeUndefined()
    const saved = savedFile(dir)
    expect(saved).toBe('FIRST\r\nSECOND\r\nTHIRD\r\n')
  })
})
