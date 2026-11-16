/**
 * The local request log (T-27) off the request path (FU5 computer stalls): every hub
 * request appended its line with open + write + close, synchronously, on the main
 * thread — ~2,100 blocking file calls per 10 s in the request bursts that stalled the
 * computer. Lines are now queued and appended in order, batched, by one writer on the
 * libuv pool; the file's content, rotation, mode and re-creation are as before.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const syncCalls = vi.hoisted(() => ({ n: 0, counting: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const counted = <F extends (...args: never[]) => unknown>(f: F): F =>
    ((...args: never[]) => {
      if (syncCalls.counting) syncCalls.n++
      return f(...args)
    }) as F
  const wrapped = {
    ...fs,
    openSync: counted(fs.openSync),
    writeSync: counted(fs.writeSync),
    closeSync: counted(fs.closeSync),
    appendFileSync: counted(fs.appendFileSync),
    renameSync: counted(fs.renameSync),
    statSync: counted(fs.statSync)
  }
  return { ...wrapped, default: wrapped }
})

const { createRequestLog, REQUEST_LOG_DIR_NAME, REQUEST_LOG_FILE_NAME } = await import(
  './request-log'
)

const dirs: string[] = []
afterEach(() => {
  syncCalls.counting = false
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function stateDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'request-log-')))
  dirs.push(d)
  return d
}
const at = new Date('2026-11-15T12:00:00.000Z')
const entry = (i: number) => ({
  hub: 'hub.example.com',
  method: 'fs.pathExists',
  actor: { userId: null, route: `r${i}` },
  params: { path: `/repo/f${i}` },
  result: 'ok' as const
})
const lineOf = (i: number) =>
  `${JSON.stringify({
    ts: at.toISOString(),
    hub: 'hub.example.com',
    method: 'fs.pathExists',
    actor: { userId: null, route: `r${i}` },
    target: { path: `/repo/f${i}` },
    result: 'ok'
  })}\n`

describe('request log: off the request path, same file', () => {
  test('record() makes no synchronous file call', () => {
    const log = createRequestLog({ stateDir: stateDir(), now: () => at })
    syncCalls.n = 0
    syncCalls.counting = true
    for (let i = 0; i < 100; i++) log.record(entry(i))
    syncCalls.counting = false
    expect(syncCalls.n).toBe(0)
  })

  test('lines land in order, byte-identical to the synchronous log', async () => {
    const log = createRequestLog({ stateDir: stateDir(), now: () => at })
    for (let i = 0; i < 50; i++) log.record(entry(i))
    await log.flush()
    expect(readFileSync(log.filePath, 'utf8')).toBe(
      Array.from({ length: 50 }, (_, i) => lineOf(i)).join('')
    )
    expect(statSync(log.filePath).mode & 0o777).toBe(0o600)
  })

  test('rotates by size exactly where the synchronous log did', async () => {
    const dir = stateDir()
    const maxBytes = 600
    const log = createRequestLog({ stateDir: dir, now: () => at, maxBytes, keep: 2 })
    for (let i = 0; i < 25; i++) log.record(entry(i))
    await log.flush()
    // The old rule, line by line: rotate before a line that would pass maxBytes.
    const generations: string[] = ['']
    for (let i = 0; i < 25; i++) {
      const line = lineOf(i)
      const live = generations[0]!
      if (live.length > 0 && live.length + line.length > maxBytes) generations.unshift('')
      generations[0] += line
    }
    const file = join(dir, REQUEST_LOG_DIR_NAME, REQUEST_LOG_FILE_NAME)
    expect(readFileSync(file, 'utf8')).toBe(generations[0])
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(generations[1])
    expect(readFileSync(`${file}.2`, 'utf8')).toBe(generations[2])
    expect(() => statSync(`${file}.3`)).toThrow()
  })

  test('a log file removed meanwhile (a shell) is created again, 0600', async () => {
    const log = createRequestLog({ stateDir: stateDir(), now: () => at })
    log.record(entry(0))
    await log.flush()
    unlinkSync(log.filePath)
    log.record(entry(1))
    await log.flush()
    expect(readFileSync(log.filePath, 'utf8')).toBe(lineOf(1))
    expect(statSync(log.filePath).mode & 0o777).toBe(0o600)
  })

  test('flushSync() writes what is queued at once (stop / process exit)', () => {
    const log = createRequestLog({ stateDir: stateDir(), now: () => at })
    for (let i = 0; i < 3; i++) log.record(entry(i))
    log.flushSync()
    expect(readFileSync(log.filePath, 'utf8')).toBe(lineOf(0) + lineOf(1) + lineOf(2))
  })

  test('a write that fails is reported, never thrown into a request', async () => {
    const dir = stateDir()
    const errors: unknown[] = []
    const log = createRequestLog({ stateDir: dir, now: () => at, onError: (e) => errors.push(e) })
    rmSync(join(dir, REQUEST_LOG_DIR_NAME), { recursive: true, force: true })
    expect(() => log.record(entry(0))).not.toThrow()
    await log.flush()
    expect(errors.length).toBeGreaterThan(0)
  })

  test('a rotation that fails (the file was removed) still writes the batch, and is reported (review R2)', async () => {
    const dir = stateDir()
    const errors: unknown[] = []
    const log = createRequestLog({
      stateDir: dir,
      now: () => at,
      maxBytes: 400,
      keep: 2,
      onError: (e) => errors.push(e)
    })
    // Two lines (~320 bytes): the next one passes maxBytes and rotates first.
    for (let i = 0; i < 2; i++) log.record(entry(i))
    await log.flush()
    expect(lineOf(0).length * 3).toBeGreaterThan(400)
    // A shell removes the live file: that rotation's rename fails …
    unlinkSync(log.filePath)
    log.record(entry(2))
    await log.flush()
    // … but the line is not lost: the append re-creates the file.
    expect(readFileSync(log.filePath, 'utf8')).toBe(lineOf(2))
    expect(errors.length).toBeGreaterThan(0)
  })
})
