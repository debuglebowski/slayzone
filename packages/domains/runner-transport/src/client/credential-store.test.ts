import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileCredentialStore, credentialsFilePath, hubHostFromUrl } from './credential-store'

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'runner-creds-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

const CREDS = { runnerId: 'runner-1', apiKey: 'key-abc', pinnedFingerprint: 'a'.repeat(64) }

describe('createFileCredentialStore', () => {
  it('round-trips credentials through the shared runner.state.json map', async () => {
    const store = createFileCredentialStore('hub.example_8443', { baseDir })
    expect(await store.load()).toBeNull()
    await store.save(CREDS)
    expect(await store.load()).toEqual(CREDS)
    expect(store.filePath).toBe(join(baseDir, 'runner.state.json'))
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
    await writeFile(store.filePath, JSON.stringify({ 'hub.example': { runnerId: '' } }), 'utf8')
    expect(await store.load()).toBeNull()
  })

  it('clear removes the entry idempotently', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    await store.clear()
    expect(await store.load()).toBeNull()
    await store.clear() // second clear must not throw
  })

  it('clear on the last remaining entry deletes the whole file', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    await store.clear()
    await expect(stat(store.filePath)).rejects.toThrow()
  })

  it('persists pretty JSON that a human can inspect', async () => {
    const store = createFileCredentialStore('hub.example', { baseDir })
    await store.save(CREDS)
    const raw = await readFile(store.filePath, 'utf8')
    expect(JSON.parse(raw)).toEqual({ 'hub.example': CREDS })
    expect(raw.endsWith('\n')).toBe(true)
  })
})

describe('multi-hub isolation (the reason this is a map, not a per-host file)', () => {
  it('two hubs share one file without clobbering each other', async () => {
    const storeA = createFileCredentialStore('hub-a.example', { baseDir })
    const storeB = createFileCredentialStore('hub-b.example', { baseDir })
    expect(storeA.filePath).toBe(storeB.filePath)

    await storeA.save(CREDS)
    await storeB.save({ runnerId: 'runner-b', apiKey: 'key-b' })

    expect(await storeA.load()).toEqual(CREDS)
    expect(await storeB.load()).toEqual({ runnerId: 'runner-b', apiKey: 'key-b' })
  })

  it("clearing one hub's entry leaves the other hub's entry intact", async () => {
    const storeA = createFileCredentialStore('hub-a.example', { baseDir })
    const storeB = createFileCredentialStore('hub-b.example', { baseDir })
    await storeA.save(CREDS)
    await storeB.save({ runnerId: 'runner-b', apiKey: 'key-b' })

    await storeA.clear()

    expect(await storeA.load()).toBeNull()
    expect(await storeB.load()).toEqual({ runnerId: 'runner-b', apiKey: 'key-b' })
  })

  it("one hub's corrupt entry does not hide another hub's valid entry", async () => {
    const store = createFileCredentialStore('hub-a.example', { baseDir })
    await store.save(CREDS)
    const { writeFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(store.filePath, 'utf8'))
    raw['hub-b.example'] = { runnerId: '' } // fails schema (min length 1)
    await writeFile(store.filePath, JSON.stringify(raw), 'utf8')

    expect(await store.load()).toEqual(CREDS)
    expect(await createFileCredentialStore('hub-b.example', { baseDir }).load()).toBeNull()
  })
})

describe('credential map path + host validation', () => {
  it('hubHostFromUrl folds host and port', () => {
    expect(hubHostFromUrl('wss://hub.example:8443/runners')).toBe('hub.example_8443')
    expect(hubHostFromUrl('wss://hub.example/runners')).toBe('hub.example')
    expect(hubHostFromUrl('ws://127.0.0.1:9000')).toBe('127.0.0.1_9000')
  })

  it('credentialsFilePath is one shared file, independent of hub host', () => {
    expect(credentialsFilePath(baseDir)).toBe(join(baseDir, 'runner.state.json'))
  })

  it('rejects an empty/whitespace-only hub host rather than silently storing a garbage key', () => {
    expect(() => createFileCredentialStore('', { baseDir })).toThrow(/invalid hub host/)
    expect(() => createFileCredentialStore('   ', { baseDir })).toThrow(/invalid hub host/)
  })
})
