/**
 * initStorageDir — the app's whole first-launch sequence, run end to end against fake
 * user dirs, for the main database rename (`slayzone.sqlite` → `slayzone.data.sqlite`,
 * dev: `slayzone.dev.sqlite` → `slayzone.dev.data.sqlite`).
 *
 * THE HAZARD THIS PINS. Every legacy SOURCE (v0.35.0 userData, the flat beta storage)
 * still uses the old name, and the copy migrations only copy when the destination is
 * absent. A beta hub root that still holds its live DB under the OLD name has no file at
 * the new name, so if a copy ran first it would plant a years-old userData database at
 * the new name and the user's real, current database would be stranded beside it. The
 * rename in place therefore has to happen BEFORE either copy. Every scenario below
 * asserts WHICH database ended up at the new name, by content.
 *
 * Pure Node (real temp dirs, no electron/native deps).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initStorageDir } from './data-paths'

/** Content, or a marker when the file is absent — so a missing file is a reported
 *  failure with a readable name, not an uncaught exception that hides the rest. */
const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '<missing>')

const prevRoot = process.env.SLAYZONE_ROOT
const prevChannel = process.env.SLAYZONE_RELEASE_CHANNEL

function setup(channel: 'stable' | 'dev'): {
  home: string
  userData: string
  flat: string
  hub: string
} {
  const base = mkdtempSync(join(tmpdir(), 'slz-datapaths-'))
  const home = join(base, 'dotslayzone')
  const userData = join(base, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  process.env.SLAYZONE_ROOT = home
  process.env.SLAYZONE_RELEASE_CHANNEL = channel
  return { home, userData, flat: join(home, 'storage'), hub: join(home, channel, 'hub') }
}

afterAll(() => {
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
  if (prevChannel === undefined) delete process.env.SLAYZONE_RELEASE_CHANNEL
  else process.env.SLAYZONE_RELEASE_CHANNEL = prevChannel
})

type Dirs = ReturnType<typeof setup>

// --- v0.35.0 → new minor: copied to the NEW name, source untouched -----------------
describe('v0.35.0 → new minor: copied to the NEW name, source untouched', () => {
  let d: Dirs
  beforeAll(() => {
    d = setup('stable')
    writeFileSync(join(d.userData, 'slayzone.sqlite'), 'V035-DB')
    writeFileSync(join(d.userData, 'slayzone.sqlite-wal'), 'V035-WAL')
    initStorageDir(d.userData, true, true)
  })
  test('v0.35.0 DB lands at the new name', () => {
    expect(read(join(d.hub, 'slayzone.data.sqlite'))).toBe('V035-DB')
  })
  test('its WAL comes with it', () => {
    expect(read(join(d.hub, 'slayzone.data.sqlite-wal'))).toBe('V035-WAL')
  })
  test('the legacy name is NOT created in the hub root', () => {
    expect(existsSync(join(d.hub, 'slayzone.sqlite'))).toBe(false)
  })
  test('v0.35.0 source is untouched', () => {
    expect(read(join(d.userData, 'slayzone.sqlite'))).toBe('V035-DB')
  })
})

// --- beta.13-17: live DB under the old name in the hub root ------------------------
describe('beta.13-17: live DB under the old name in the hub root', () => {
  let d: Dirs
  beforeAll(() => {
    d = setup('stable')
    mkdirSync(d.hub, { recursive: true })
    writeFileSync(join(d.hub, 'slayzone.sqlite'), 'BETA-LIVE')
    writeFileSync(join(d.hub, 'slayzone.sqlite-wal'), 'BETA-WAL')
    writeFileSync(join(d.userData, 'slayzone.sqlite'), 'STALE-USERDATA') // would shadow it if copied first
    // NOTE: no .storage-migrated sentinel, i.e. the worst case for the hazard.
    initStorageDir(d.userData, true, true)
  })
  test('the live beta DB is adopted, NOT shadowed by the old userData copy', () => {
    expect(read(join(d.hub, 'slayzone.data.sqlite'))).toBe('BETA-LIVE')
  })
  test('its WAL moved with it', () => {
    expect(read(join(d.hub, 'slayzone.data.sqlite-wal'))).toBe('BETA-WAL')
  })
  test('the old name is gone from the hub root', () => {
    expect(existsSync(join(d.hub, 'slayzone.sqlite'))).toBe(false)
  })
  test('userData source is untouched', () => {
    expect(read(join(d.userData, 'slayzone.sqlite'))).toBe('STALE-USERDATA')
  })
})

// --- beta.4-12: flat ~/.slayzone/storage ------------------------------------------
describe('beta.4-12: flat ~/.slayzone/storage', () => {
  let d: Dirs
  beforeAll(() => {
    d = setup('stable')
    mkdirSync(d.flat, { recursive: true })
    writeFileSync(join(d.flat, 'slayzone.sqlite'), 'FLAT-DB')
    writeFileSync(join(d.userData, 'slayzone.sqlite'), 'OLDER-USERDATA')
    initStorageDir(d.userData, true, true)
  })
  test('flat beta DB wins (newest source) at the new name', () => {
    expect(read(join(d.hub, 'slayzone.data.sqlite'))).toBe('FLAT-DB')
  })
  test('flat source is untouched', () => {
    expect(read(join(d.flat, 'slayzone.sqlite'))).toBe('FLAT-DB')
  })
})

// --- dev channel -------------------------------------------------------------------
describe('dev channel', () => {
  let d: Dirs
  beforeAll(() => {
    d = setup('dev')
    mkdirSync(d.hub, { recursive: true })
    writeFileSync(join(d.hub, 'slayzone.dev.sqlite'), 'DEV-LIVE')
    writeFileSync(join(d.userData, 'slayzone.dev.sqlite'), 'DEV-STALE')
    writeFileSync(join(d.userData, 'slayzone.sqlite'), 'PROD-DB-MUST-NOT-MOVE')
    initStorageDir(d.userData, false, true)
  })
  test('dev DB adopted under slayzone.dev.data.sqlite', () => {
    expect(read(join(d.hub, 'slayzone.dev.data.sqlite'))).toBe('DEV-LIVE')
  })
  test('dev never takes the prod DB', () => {
    expect(existsSync(join(d.hub, 'slayzone.data.sqlite'))).toBe(false)
    expect(existsSync(join(d.hub, 'slayzone.sqlite'))).toBe(false)
  })
  test('prod source untouched by the dev channel', () => {
    expect(read(join(d.userData, 'slayzone.sqlite'))).toBe('PROD-DB-MUST-NOT-MOVE')
  })
})

// --- fresh install: nothing invented ------------------------------------------------
describe('fresh install: nothing invented', () => {
  test('a fresh install creates no database file', () => {
    const { userData, hub } = setup('stable')
    initStorageDir(userData, true, true)
    expect(existsSync(join(hub, 'slayzone.data.sqlite'))).toBe(false)
    expect(existsSync(join(hub, 'slayzone.sqlite'))).toBe(false)
  })
})

// --- no instance lock: touch NOTHING ---------------------------------------------------
// A second launch while the old app still runs (v0.35.0 holds the same lock, same
// userData) must not copy its live WAL database, nor rename a live hub's. The caller
// passes whether it holds the lock; without it the whole first-launch pass is skipped.
describe('no instance lock: touch NOTHING', () => {
  describe('a v0.35.0 userData DB', () => {
    let d: Dirs
    let target: string
    beforeAll(() => {
      d = setup('stable')
      writeFileSync(join(d.userData, 'slayzone.sqlite'), 'V035-DB')
      target = initStorageDir(d.userData, true, false)
    })
    test('without the lock the hub root is still returned', () => {
      expect(target).toBe(d.hub)
    })
    test('without the lock nothing is copied', () => {
      expect(existsSync(join(d.hub, 'slayzone.data.sqlite'))).toBe(false)
    })
    test('without the lock not even the hub root is created', () => {
      expect(existsSync(d.hub)).toBe(false)
    })
    test('without the lock the source is untouched', () => {
      expect(read(join(d.userData, 'slayzone.sqlite'))).toBe('V035-DB')
    })
    test('the next launch that DOES hold the lock imports it', () => {
      initStorageDir(d.userData, true, true)
      expect(read(join(d.hub, 'slayzone.data.sqlite'))).toBe('V035-DB')
    })
  })

  test('without the lock a live hub root is not renamed under its owner', () => {
    const { userData, hub } = setup('stable')
    mkdirSync(hub, { recursive: true })
    writeFileSync(join(hub, 'slayzone.sqlite'), 'LIVE-BETA-DB')
    initStorageDir(userData, true, false)
    expect(read(join(hub, 'slayzone.sqlite'))).toBe('LIVE-BETA-DB')
    expect(existsSync(join(hub, 'slayzone.data.sqlite'))).toBe(false)
  })
})

// --- idempotent ------------------------------------------------------------------------
describe('idempotent', () => {
  test('a second boot never touches the live DB', () => {
    const { userData, hub } = setup('stable')
    writeFileSync(join(userData, 'slayzone.sqlite'), 'V035-DB')
    initStorageDir(userData, true, true)
    writeFileSync(join(hub, 'slayzone.data.sqlite'), 'NEW-WORK') // the user has since used the app
    initStorageDir(userData, true, true)
    expect(read(join(hub, 'slayzone.data.sqlite'))).toBe('NEW-WORK')
  })
})
