/**
 * channel-storage-migration — COPY-ONLY move of the desktop app's state from
 * the legacy FLAT, shared `~/.slayzone` into the new channel-scoped hub/computer
 * roots. The legacy dir is treated as STRICTLY READ-ONLY, same rule and same
 * reason as `storage-migration.ts`: dev/beta/stable currently share one flat
 * root, so an old, not-yet-updated build could still be live and writing to it
 * while a newer build runs this migration — deleting/moving the source out
 * from under a still-running peer is exactly the incident that already
 * happened once (see `storage-migration.ts`'s file header). This migration
 * never calls `rm`/`rename`/`unlink` on the legacy root, only copies out of it.
 *
 * Pure Node (real temp dirs, no electron/native deps).
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureChannelScopedStorage } from './channel-storage-migration'

/** `computer.state.json` legitimately may not exist on disk when there was no
 *  legacy credential data to migrate — `credential-store.ts`'s reader already
 *  treats a missing file as an empty map, so the migration doesn't force-create
 *  one just to have something present. Mirror that same graceful read here. */
function readState(computerRoot: string): Record<string, unknown> {
  const path = join(computerRoot, 'computer.state.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
}

function setup(): { legacyRoot: string; hubRoot: string; computerRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'slz-channel-mig-'))
  return {
    legacyRoot: join(base, 'legacy'),
    hubRoot: join(base, 'dev', 'hub'),
    computerRoot: join(base, 'dev', 'computer')
  }
}

type Roots = ReturnType<typeof setup>

// --- hub slice: DB + content + backups + loose files, source untouched -------
describe('hub slice: DB + content + backups + loose files, source untouched', () => {
  let r: Roots
  let legacyStorage: string
  beforeAll(() => {
    r = setup()
    const { legacyRoot, hubRoot, computerRoot } = r
    legacyStorage = join(legacyRoot, 'storage')
    mkdirSync(legacyStorage, { recursive: true })
    writeFileSync(join(legacyStorage, 'slayzone.dev.sqlite'), 'DEVDB')
    writeFileSync(join(legacyStorage, 'slayzone.dev.sqlite-wal'), 'WAL')
    writeFileSync(join(legacyStorage, 'slayzone.dev.sqlite-shm'), 'SHM')
    mkdirSync(join(legacyStorage, 'artifacts', 't1'), { recursive: true })
    writeFileSync(join(legacyStorage, 'artifacts', 't1', 'a.md'), 'ART')
    mkdirSync(join(legacyStorage, 'blobs', 'd8'), { recursive: true })
    writeFileSync(join(legacyStorage, 'blobs', 'd8', '3c76abcd'), 'BLOBCONTENT')
    const bdir = join(legacyStorage, 'backups')
    mkdirSync(bdir, { recursive: true })
    writeFileSync(join(bdir, 'slayzone.dev.2026-01-01T00-00-00-000Z.manual.sqlite'), 'B1')
    writeFileSync(join(bdir, 'slayzone.dev.2026-03-01T00-00-00-000Z.manual.sqlite'), 'B3')
    writeFileSync(join(legacyStorage, 'boot-config.json'), '{"server_mode":"local"}')
    writeFileSync(join(legacyStorage, 'hub-tokens.json'), '{"hub-a":"cipher"}')

    ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false })
  })

  // Source keeps the legacy name; the copy lands under the renamed main DB.
  test('DB copied', () => {
    expect(readFileSync(join(r.hubRoot, 'slayzone.dev.data.sqlite'), 'utf8')).toBe('DEVDB')
  })
  test('legacy name NOT created in the hub root', () => {
    expect(existsSync(join(r.hubRoot, 'slayzone.dev.sqlite'))).toBe(false)
  })
  test('wal + shm copied', () => {
    expect(existsSync(join(r.hubRoot, 'slayzone.dev.data.sqlite-wal'))).toBe(true)
    expect(existsSync(join(r.hubRoot, 'slayzone.dev.data.sqlite-shm'))).toBe(true)
  })
  test('artifacts copied (recursive)', () => {
    expect(readFileSync(join(r.hubRoot, 'artifacts', 't1', 'a.md'), 'utf8')).toBe('ART')
  })
  test('blobs copied (recursive)', () => {
    expect(readFileSync(join(r.hubRoot, 'blobs', 'd8', '3c76abcd'), 'utf8')).toBe('BLOBCONTENT')
  })
  test('most-recent backup copied, older one left behind', () => {
    expect(
      existsSync(
        join(r.hubRoot, 'backups', 'slayzone.dev.2026-03-01T00-00-00-000Z.manual.sqlite')
      )
    ).toBe(true)
  })
  test('boot-config.json copied (missed by storage-migration.ts scope)', () => {
    expect(existsSync(join(r.hubRoot, 'boot-config.json'))).toBe(true)
  })
  test('hub-tokens.json copied (missed by storage-migration.ts scope)', () => {
    expect(existsSync(join(r.hubRoot, 'hub-tokens.json'))).toBe(true)
  })

  test('source DB PRESERVED', () => {
    expect(readFileSync(join(legacyStorage, 'slayzone.dev.sqlite'), 'utf8')).toBe('DEVDB')
  })
  test('source artifacts PRESERVED', () => {
    expect(readFileSync(join(legacyStorage, 'artifacts', 't1', 'a.md'), 'utf8')).toBe('ART')
  })
  test('source boot-config.json / hub-tokens.json PRESERVED', () => {
    expect(existsSync(join(legacyStorage, 'boot-config.json'))).toBe(true)
    expect(existsSync(join(legacyStorage, 'hub-tokens.json'))).toBe(true)
  })
})

// --- computer slice: TRANSFORM, per-host files → one shared map ----------------
describe('computer slice: TRANSFORM, per-host files → one shared map', () => {
  let legacyComputers: string
  let statePath: string
  beforeAll(() => {
    const { legacyRoot, hubRoot, computerRoot } = setup()
    legacyComputers = join(legacyRoot, 'computers')
    mkdirSync(legacyComputers, { recursive: true })
    writeFileSync(
      join(legacyComputers, 'hub-a.example_8443.json'),
      JSON.stringify({ computerId: 'r-a', apiKey: 'key-a' })
    )
    writeFileSync(
      join(legacyComputers, 'hub-b.example_9000.json'),
      JSON.stringify({ computerId: 'r-b', apiKey: 'key-b', pinnedFingerprint: 'f'.repeat(64) })
    )

    ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false })
    statePath = join(computerRoot, 'computer.state.json')
  })
  const state = (): Record<string, unknown> =>
    JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>

  test('computer.state.json created (single file, not a directory of files)', () => {
    expect(existsSync(statePath)).toBe(true)
  })
  test('first hub entry merged in, keyed by hub-host derived from filename', () => {
    expect(state()['hub-a.example_8443']).toStrictEqual({ computerId: 'r-a', apiKey: 'key-a' })
  })
  test('second hub entry merged in alongside the first — not overwritten', () => {
    expect(state()['hub-b.example_9000']).toStrictEqual({
      computerId: 'r-b',
      apiKey: 'key-b',
      pinnedFingerprint: 'f'.repeat(64)
    })
  })
  test('exactly two entries — no stray keys', () => {
    expect(Object.keys(state())).toHaveLength(2)
  })
  test('legacy per-host files PRESERVED (copy semantics, not move)', () => {
    expect(existsSync(join(legacyComputers, 'hub-a.example_8443.json'))).toBe(true)
    expect(existsSync(join(legacyComputers, 'hub-b.example_9000.json'))).toBe(true)
  })
})

// --- a malformed legacy credential file is skipped, not fatal ----------------
describe('a malformed legacy credential file is skipped, not fatal', () => {
  let r: Roots
  let thrown: unknown
  beforeAll(() => {
    r = setup()
    const { legacyRoot, hubRoot, computerRoot } = r
    const legacyComputers = join(legacyRoot, 'computers')
    mkdirSync(legacyComputers, { recursive: true })
    writeFileSync(
      join(legacyComputers, 'good-hub.json'),
      JSON.stringify({ computerId: 'r1', apiKey: 'k1' })
    )
    writeFileSync(join(legacyComputers, 'corrupt-hub.json'), 'not json at all')

    try {
      ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false })
    } catch (err) {
      thrown = err ?? new Error('threw')
    }
  })
  const state = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(r.computerRoot, 'computer.state.json'), 'utf8')) as Record<
      string,
      unknown
    >

  test('does not throw on one corrupt legacy file', () => {
    expect(thrown).toBeUndefined()
  })
  test('the good entry still migrated despite the corrupt sibling', () => {
    expect(state()).toHaveProperty('good-hub')
  })
  test('the corrupt entry is simply absent, not a garbage value', () => {
    expect(state()).not.toHaveProperty('corrupt-hub')
  })
})

// --- independent sentinels: hub and computer slices don't gate on each other ---
describe("independent sentinels: hub and computer slices don't gate on each other", () => {
  let r: Roots
  beforeAll(() => {
    r = setup()
    const { legacyRoot, hubRoot, computerRoot } = r
    mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
    writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'DB')
    // No legacy computers/ dir at all this time.

    ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false })
  })

  test('hub slice completed independently', () => {
    expect(existsSync(join(r.hubRoot, 'slayzone.dev.data.sqlite'))).toBe(true)
  })
  test('computer slice completed independently (empty state, no legacy creds)', () => {
    expect(Object.keys(readState(r.computerRoot))).toHaveLength(0)
  })
  test('hub sentinel written', () => {
    expect(existsSync(join(r.hubRoot, '.channel-migrated'))).toBe(true)
  })
  test('computer sentinel written', () => {
    expect(existsSync(join(r.computerRoot, '.channel-migrated'))).toBe(true)
  })
})

// --- sentinel makes a re-run a genuine no-op --------------------------------
describe('sentinel makes a re-run a genuine no-op', () => {
  let r: Roots
  beforeAll(() => {
    r = setup()
    const { legacyRoot, hubRoot, computerRoot } = r
    mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
    writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'DB')
    mkdirSync(join(legacyRoot, 'computers'), { recursive: true })
    writeFileSync(
      join(legacyRoot, 'computers', 'hub-a.json'),
      JSON.stringify({ computerId: 'r1', apiKey: 'k1' })
    )

    ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false })

    // Simulate the legacy shared dir gaining new content after the first boot
    // (an old, not-yet-updated peer build still writing to it).
    writeFileSync(
      join(legacyRoot, 'computers', 'hub-b.json'),
      JSON.stringify({ computerId: 'r2', apiKey: 'k2' })
    )
    mkdirSync(join(legacyRoot, 'storage', 'blobs', 'ff'), { recursive: true })
    writeFileSync(join(legacyRoot, 'storage', 'blobs', 'ff', 'laterblob'), 'LATER')

    ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false }) // second boot
  })

  test('sentinel makes 2nd run a no-op — later hub blob NOT picked up', () => {
    expect(existsSync(join(r.hubRoot, 'blobs', 'ff', 'laterblob'))).toBe(false)
  })
  test('sentinel makes 2nd run a no-op — later computer credential NOT picked up', () => {
    const state = JSON.parse(
      readFileSync(join(r.computerRoot, 'computer.state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(state).not.toHaveProperty('hub-b')
  })
})

// --- never clobbers already-populated destination content --------------------
describe('never clobbers already-populated destination content', () => {
  let r: Roots
  beforeAll(() => {
    r = setup()
    const { legacyRoot, hubRoot, computerRoot } = r
    mkdirSync(hubRoot, { recursive: true })
    writeFileSync(join(hubRoot, 'slayzone.dev.data.sqlite'), 'EXISTING')
    writeFileSync(join(hubRoot, 'boot-config.json'), '{"already":"here"}')
    mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
    writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'INCOMING')
    writeFileSync(join(legacyRoot, 'storage', 'boot-config.json'), '{"incoming":"value"}')

    ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false })
  })

  test('existing DB not clobbered', () => {
    expect(readFileSync(join(r.hubRoot, 'slayzone.dev.data.sqlite'), 'utf8')).toBe('EXISTING')
  })
  test('existing boot-config.json not clobbered', () => {
    expect(readFileSync(join(r.hubRoot, 'boot-config.json'), 'utf8')).toBe('{"already":"here"}')
  })
})

// --- no-op when there is nothing to migrate (fresh install) ------------------
describe('no-op when there is nothing to migrate (fresh install)', () => {
  let r: Roots
  beforeAll(() => {
    r = setup()
    ensureChannelScopedStorage({ ...r, packaged: false })
  })
  test('fresh install: hub root created, no throw', () => {
    expect(existsSync(r.hubRoot)).toBe(true)
  })
  test('fresh install: computer root created, no throw', () => {
    expect(existsSync(r.computerRoot)).toBe(true)
  })
  test('fresh install: no computer.state.json forced into existence with nothing to migrate', () => {
    expect(Object.keys(readState(r.computerRoot))).toHaveLength(0)
  })
})

// --- REGRESSION GUARD: a copy failure must never touch the legacy source -----
// The direct test for the safety lesson storage-migration.ts's file header
// describes: a migration that can fail partway through a copy must still
// leave the legacy source completely intact, since it may be a still-live
// peer's only copy of that data.
// Not run on Windows (POSIX mode bits are not enforced there) or as root
// (root ignores permission bits).
describe.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
  'REGRESSION GUARD: a copy failure must never touch the legacy source',
  () => {
    let r: Roots
    let threw = false
    beforeAll(() => {
      r = setup()
      const { legacyRoot, hubRoot, computerRoot } = r
      mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
      writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'DEVDB')
      mkdirSync(hubRoot, { recursive: true })
      chmodSync(hubRoot, 0o555) // read-only: the DB copy into it must fail

      try {
        ensureChannelScopedStorage({ legacyRoot, hubRoot, computerRoot, packaged: false })
      } catch {
        threw = true
      } finally {
        chmodSync(hubRoot, 0o755) // restore so the tmpdir can be cleaned up below
      }
    })

    test('a write failure into the destination propagates (does not fail silently)', () => {
      expect(threw).toBe(true)
    })
    test('legacy source DB is COMPLETELY UNTOUCHED after a failed copy', () => {
      expect(readFileSync(join(r.legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'utf8')).toBe(
        'DEVDB'
      )
    })
    test('no sentinel was written for the failed slice (a retry can still happen)', () => {
      expect(existsSync(join(r.hubRoot, '.channel-migrated'))).toBe(false)
    })
  }
)
