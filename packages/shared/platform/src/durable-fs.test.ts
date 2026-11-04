/**
 * Real filesystem on the actual host. CI's check-windows job runs this on Windows,
 * where FlushFileBuffers rejects a read-only handle. Emulated Windows semantics on
 * mac/Linux are covered where the helper is used (task-artifacts working-copy.test,
 * chat-runtime windows-fsync.test): the emulator lives in @slayzone/test-utils,
 * which depends on this package, so importing it here would close a cycle.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fsyncFile, fsyncFileSync } from './durable-fs'

let dir: string, file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'durable-fs-'))
  file = join(dir, 'data')
  writeFileSync(file, 'bytes')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('on this host', () => {
  it('flushes a regular file', async () => {
    expect(() => fsyncFileSync(file)).not.toThrow()
    await expect(fsyncFile(file)).resolves.toBeUndefined()
  })
  it('surfaces a missing file', async () => {
    expect(() => fsyncFileSync(join(dir, 'missing'))).toThrow(/ENOENT/)
    await expect(fsyncFile(join(dir, 'missing'))).rejects.toThrow(/ENOENT/)
  })
})
