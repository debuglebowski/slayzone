import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { createHubRequestHandler } from '../main'
import { createRequestLog } from '../request-log'
import { createDirectGrantStore } from './grants'

const ACTOR = { userId: 'u-1', route: 'trpc test' }
const config: ComputerConfig = {
  hubUrl: 'ws://localhost:0/computers',
  name: 'c',
  allowedRoots: ['/tmp'],
  capabilities: ['pty']
}
const TOKEN = 't'.repeat(64)
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'computer-direct-'))
  dirs.push(stateDir)
  const store = createDirectGrantStore()
  const requestLog = createRequestLog({ stateDir })
  const hub = (hubScope: string) =>
    createHubRequestHandler({
      shutdown: () => {},
      dialer: { notify: () => true },
      config,
      hubScope,
      hubHost: hubScope,
      directGrants: store,
      requestLog,
      // A login-shell probe that never settles: grant bookkeeping must not wait on it.
      pathReady: new Promise(() => {})
    })
  return { store, hubA: hub('a.example'), hubB: hub('b.example'), logFile: requestLog.filePath }
}

const grantParams = {
  grantId: 'g1',
  tokenHash: HASH,
  userId: 'u-1',
  resource: { kind: 'pty', sessionId: 's1' },
  ttlMs: 60_000
}

describe('direct.* hub methods on the computer', () => {
  it('registers a grant under the hub whose link it came from, without waiting on PATH', async () => {
    const { store, hubA, hubB } = setup()
    await expect(
      hubA.handle(HubToComputerMethods.directGrant, grantParams, ACTOR)
    ).resolves.toEqual({
      ok: true
    })
    expect(store.authenticate(TOKEN)).toMatchObject({ grantId: 'g1', hubKey: 'a.example' })
    // Another hub can neither revoke nor reset it away.
    await expect(
      hubB.handle(HubToComputerMethods.directRevoke, { by: 'all' }, ACTOR)
    ).resolves.toEqual({ revoked: 0 })
    await expect(
      hubB.handle(HubToComputerMethods.directReset, { keep: [] }, ACTOR)
    ).resolves.toEqual({ dropped: 0 })
    expect(store.authenticate(TOKEN)).not.toBeNull()
    await expect(
      hubA.handle(HubToComputerMethods.directReset, { keep: [] }, ACTOR)
    ).resolves.toEqual({ dropped: 1 })
    expect(store.authenticate(TOKEN)).toBeNull()
  })

  it('refuses malformed params (a raw token where the hash goes)', async () => {
    const { hubA } = setup()
    await expect(
      hubA.handle(HubToComputerMethods.directGrant, { ...grantParams, tokenHash: TOKEN }, ACTOR)
    ).rejects.toThrow()
  })

  it('logs the grant id, never the token hash', async () => {
    const { hubA, logFile } = setup()
    await hubA.handle(HubToComputerMethods.directGrant, grantParams, ACTOR)
    const log = readFileSync(logFile, 'utf8')
    expect(log).toContain('"grantId":"g1"')
    expect(log).not.toContain(HASH)
  })
})
