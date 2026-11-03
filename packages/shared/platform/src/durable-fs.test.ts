/**
 * Portable (runs in CI's check-windows job): the real-filesystem cases prove the
 * flush handle on the actual host; the emulated cases prove Windows semantics anywhere.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emulateWindowsFsync } from '../../test-utils/windows-fsync'
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

describe('Windows flush semantics (FlushFileBuffers needs a writable handle)', () => {
  let restore: () => void
  beforeEach(() => {
    restore = emulateWindowsFsync()
  })
  afterEach(() => restore())
  it('flushes through a writable handle', async () => {
    expect(() => fsyncFileSync(file)).not.toThrow()
    await expect(fsyncFile(file)).resolves.toBeUndefined()
  })
})
