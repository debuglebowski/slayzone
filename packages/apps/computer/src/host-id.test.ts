/**
 * Host-id reconciliation. Every test here pins a property that, if it broke,
 * would fail SILENTLY — the id would still resolve, computers would just stop
 * grouping (or group wrongly) with nothing in any log.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_ID_REFRESH_MS, hostIdFilePath, reconcileHostId, sharedHostIdPath } from './host-id'

let dir: string
let shared: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-id-'))
  shared = join(dir, 'shared-host-id')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('reconcileHostId', () => {
  it('generates and persists an id when nothing exists', async () => {
    const id = await reconcileHostId({ baseDir: dir, sharedPath: shared })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(readFileSync(shared, 'utf-8').trim()).toBe(id)
    // Second call must be stable, not a fresh uuid.
    expect(await reconcileHostId({ baseDir: dir, sharedPath: shared })).toBe(id)
  })

  it('copies an existing shared id rather than inventing a second one', async () => {
    writeFileSync(shared, 'shared-abc\n')
    expect(await reconcileHostId({ baseDir: dir, sharedPath: shared })).toBe('shared-abc')
  })

  // The convergence rule. Two OS users that first-start simultaneously each
  // generate one; without this they stay split forever and render as two machines.
  it('adopts the shared value when it disagrees with the durable one', async () => {
    await reconcileHostId({ baseDir: dir, sharedPath: shared })
    writeFileSync(shared, 'winner\n')
    expect(await reconcileHostId({ baseDir: dir, sharedPath: shared })).toBe('winner')
    // …and the adoption is persisted, so it survives the next boot.
    const durable = JSON.parse(readFileSync(hostIdFilePath(dir), 'utf-8')) as { hostId: string }
    expect(durable.hostId).toBe('winner')
  })

  // The whole point of the durable copy: /tmp being wiped must not change the id.
  it('rewrites the shared file from the durable one after /tmp is cleared', async () => {
    const id = await reconcileHostId({ baseDir: dir, sharedPath: shared })
    rmSync(shared)
    expect(await reconcileHostId({ baseDir: dir, sharedPath: shared })).toBe(id)
    expect(readFileSync(shared, 'utf-8').trim()).toBe(id)
  })

  // The shared file exists to be written by OTHER OS users. `writeFile`'s mode is
  // masked by umask (022 → 0644), which would lock everyone else out, so the
  // implementation fchmods explicitly.
  it('leaves the shared file world-writable', async () => {
    await reconcileHostId({ baseDir: dir, sharedPath: shared })
    expect(statSync(shared).mode & 0o666).toBe(0o666)
  })

  it('treats a corrupt durable file as absent rather than throwing', async () => {
    writeFileSync(hostIdFilePath(dir), '{not json')
    const id = await reconcileHostId({ baseDir: dir, sharedPath: shared })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  // Windows has no world-writable temp, so the shared channel is absent by design.
  // The id must still resolve; only grouping degrades.
  it('works with the shared channel disabled', async () => {
    const id = await reconcileHostId({ baseDir: dir, sharedPath: null })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await reconcileHostId({ baseDir: dir, sharedPath: null })).toBe(id)
  })

  // An unwritable shared path is a degraded grouping, never a failed boot.
  it('still returns an id when the shared path cannot be written', async () => {
    const id = await reconcileHostId({
      baseDir: dir,
      sharedPath: join(dir, 'no-such-dir', 'shared')
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('sharedHostIdPath', () => {
  // NOT os.tmpdir(): on macOS that honours $TMPDIR, which is per-user
  // (/var/folders/…), so the "shared" file would be invisible to every other
  // account and the mechanism would no-op with all tests still passing.
  it('is the literal /tmp on posix, never os.tmpdir()', () => {
    if (process.platform === 'win32') {
      expect(sharedHostIdPath()).toBeNull()
    } else {
      expect(sharedHostIdPath()).toBe('/tmp/slayzone-host-id')
      expect(sharedHostIdPath()).not.toContain(tmpdir())
    }
  })
})

describe('HOST_ID_REFRESH_MS', () => {
  // Comfortably inside a daily tmp-cleaner window; the refresh is what covers a
  // long-uptime box whose /tmp is swept while no computer ever restarts.
  it('is well under a day', () => {
    expect(HOST_ID_REFRESH_MS).toBeLessThan(24 * 60 * 60 * 1000)
  })
})
