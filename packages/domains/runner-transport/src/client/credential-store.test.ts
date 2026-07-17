import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileCredentialStore, credentialFilePathFor, hubHostFromUrl } from './credential-store'

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'runner-creds-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

const CREDS = { runnerId: 'runner-1', apiKey: 'key-abc', pinnedFingerprint: 'a'.repeat(64) }

describe('createFileCredentialStore', () => {
  it('round-trips credentials through <hub-host>.json', async () => {
    const store = createFileCredentialStore('hub.example_8443', { baseDir })
    expect(await store.load()).toBeNull()
    await store.save(CREDS)
    expect(await store.load()).toEqual(CREDS)
    expect(store.filePath).toBe(join(baseDir, 'hub.example_8443.json'))
  })

  it('writes the file with 0600 permissions', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    const mode = (await stat(store.filePath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('overwrites atomically on re-save', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    await store.save({ runnerId: 'runner-2', apiKey: 'key-new' })
    expect(await store.load()).toEqual({ runnerId: 'runner-2', apiKey: 'key-new' })
    const mode = (await stat(store.filePath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('treats corrupt or invalid JSON as absent', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(store.filePath, 'not json', 'utf8')
    expect(await store.load()).toBeNull()
    await writeFile(store.filePath, JSON.stringify({ runnerId: '' }), 'utf8')
    expect(await store.load()).toBeNull()
  })

  it('clear removes the file idempotently', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    await store.clear()
    expect(await store.load()).toBeNull()
    await store.clear() // second clear must not throw
  })

  it('persists pretty JSON that a human can inspect', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    const raw = await readFile(store.filePath, 'utf8')
    expect(JSON.parse(raw)).toEqual(CREDS)
    expect(raw.endsWith('\n')).toBe(true)
  })
})

describe('credential file naming', () => {
  it('hubHostFromUrl folds host and port', () => {
    expect(hubHostFromUrl('wss://hub.example:8443/runners')).toBe('hub.example_8443')
    expect(hubHostFromUrl('wss://hub.example/runners')).toBe('hub.example')
    expect(hubHostFromUrl('ws://127.0.0.1:9000')).toBe('127.0.0.1_9000')
  })

  it('sanitizes hostile hub-host strings out of path traversal', () => {
    const path = credentialFilePathFor('../../evil', baseDir)
    expect(path).toBe(join(baseDir, '.._.._evil.json'))
    expect(() => credentialFilePathFor('///', baseDir)).not.toThrow()
    expect(() => credentialFilePathFor('..', baseDir)).toThrow(/invalid hub host/)
  })
})
