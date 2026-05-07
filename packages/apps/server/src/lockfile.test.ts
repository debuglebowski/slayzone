import { test, expect, describe } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LockHeldError } from './lockfile'

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'slayzone-lock-'))
}

describe('lockfile', () => {
  test('acquire writes lock file with expected fields', () => {
    const root = makeRoot()
    const lock = acquireLock({
      dataRoot: root,
      info: { host: '127.0.0.1', port: 1234, mcpPort: null, version: '1.2.3' },
    })
    expect(existsSync(lock.path)).toBe(true)
    const parsed = JSON.parse(readFileSync(lock.path, 'utf-8'))
    expect(parsed.pid).toBe(process.pid)
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBe(1234)
    expect(parsed.version).toBe('1.2.3')
    expect(typeof parsed.startedAt).toBe('string')
    expect(typeof parsed.hostname).toBe('string')
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
    rmSync(root, { recursive: true })
  })

  test('release is idempotent', () => {
    const root = makeRoot()
    const lock = acquireLock({
      dataRoot: root,
      info: { host: '127.0.0.1', port: 0, mcpPort: null, version: '0.0.0' },
    })
    lock.release()
    expect(() => lock.release()).not.toThrow()
    rmSync(root, { recursive: true })
  })

  test('second acquire on live holder throws LockHeldError', () => {
    const root = makeRoot()
    const first = acquireLock({
      dataRoot: root,
      info: { host: '127.0.0.1', port: 1, mcpPort: null, version: '0.0.0' },
    })
    expect(() => acquireLock({
      dataRoot: root,
      info: { host: '127.0.0.1', port: 2, mcpPort: null, version: '0.0.0' },
    })).toThrow(LockHeldError)
    first.release()
    rmSync(root, { recursive: true })
  })

  test('stale lock (dead pid) is recovered automatically', () => {
    const root = makeRoot()
    const lockPath = join(root, 'server.lock')
    const stale = {
      pid: 99999999, // deliberately non-existent pid
      hostname: require('node:os').hostname(),
      host: '127.0.0.1',
      port: 1,
      mcpPort: null,
      startedAt: new Date().toISOString(),
      version: '0.0.0',
    }
    require('node:fs').writeFileSync(lockPath, JSON.stringify(stale))
    const lock = acquireLock({
      dataRoot: root,
      info: { host: '127.0.0.1', port: 2, mcpPort: null, version: '0.0.0' },
    })
    const parsed = JSON.parse(readFileSync(lock.path, 'utf-8'))
    expect(parsed.pid).toBe(process.pid)
    lock.release()
    rmSync(root, { recursive: true })
  })
})
