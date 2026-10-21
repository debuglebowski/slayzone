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
 * Pure Node (real temp dirs, no electron/native deps) → plain `npx tsx`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initStorageDir } from './data-paths'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}
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

try {
  // --- v0.35.0 → new minor: copied to the NEW name, source untouched -----------------
  {
    const { userData, hub } = setup('stable')
    writeFileSync(join(userData, 'slayzone.sqlite'), 'V035-DB')
    writeFileSync(join(userData, 'slayzone.sqlite-wal'), 'V035-WAL')
    initStorageDir(userData, true, true)
    check('v0.35.0 DB lands at the new name', read(join(hub, 'slayzone.data.sqlite')) === 'V035-DB')
    check('its WAL comes with it', read(join(hub, 'slayzone.data.sqlite-wal')) === 'V035-WAL')
    check('the legacy name is NOT created in the hub root', !existsSync(join(hub, 'slayzone.sqlite')))
    check('v0.35.0 source is untouched', read(join(userData, 'slayzone.sqlite')) === 'V035-DB')
  }

  // --- beta.13-17: live DB under the old name in the hub root ------------------------
  {
    const { userData, hub } = setup('stable')
    mkdirSync(hub, { recursive: true })
    writeFileSync(join(hub, 'slayzone.sqlite'), 'BETA-LIVE')
    writeFileSync(join(hub, 'slayzone.sqlite-wal'), 'BETA-WAL')
    writeFileSync(join(userData, 'slayzone.sqlite'), 'STALE-USERDATA') // would shadow it if copied first
    // NOTE: no .storage-migrated sentinel, i.e. the worst case for the hazard.
    initStorageDir(userData, true, true)
    check(
      'the live beta DB is adopted, NOT shadowed by the old userData copy',
      read(join(hub, 'slayzone.data.sqlite')) === 'BETA-LIVE',
      `slayzone.data.sqlite is ${read(join(hub, 'slayzone.data.sqlite'))}`
    )
    check('its WAL moved with it', read(join(hub, 'slayzone.data.sqlite-wal')) === 'BETA-WAL')
    check('the old name is gone from the hub root', !existsSync(join(hub, 'slayzone.sqlite')))
    check('userData source is untouched', read(join(userData, 'slayzone.sqlite')) === 'STALE-USERDATA')
  }

  // --- beta.4-12: flat ~/.slayzone/storage ------------------------------------------
  {
    const { userData, flat, hub } = setup('stable')
    mkdirSync(flat, { recursive: true })
    writeFileSync(join(flat, 'slayzone.sqlite'), 'FLAT-DB')
    writeFileSync(join(userData, 'slayzone.sqlite'), 'OLDER-USERDATA')
    initStorageDir(userData, true, true)
    check('flat beta DB wins (newest source) at the new name', read(join(hub, 'slayzone.data.sqlite')) === 'FLAT-DB')
    check('flat source is untouched', read(join(flat, 'slayzone.sqlite')) === 'FLAT-DB')
  }

  // --- dev channel -------------------------------------------------------------------
  {
    const { userData, hub } = setup('dev')
    mkdirSync(hub, { recursive: true })
    writeFileSync(join(hub, 'slayzone.dev.sqlite'), 'DEV-LIVE')
    writeFileSync(join(userData, 'slayzone.dev.sqlite'), 'DEV-STALE')
    writeFileSync(join(userData, 'slayzone.sqlite'), 'PROD-DB-MUST-NOT-MOVE')
    initStorageDir(userData, false, true)
    check('dev DB adopted under slayzone.dev.data.sqlite', read(join(hub, 'slayzone.dev.data.sqlite')) === 'DEV-LIVE')
    check('dev never takes the prod DB', !existsSync(join(hub, 'slayzone.data.sqlite')) && !existsSync(join(hub, 'slayzone.sqlite')))
    check('prod source untouched by the dev channel', read(join(userData, 'slayzone.sqlite')) === 'PROD-DB-MUST-NOT-MOVE')
  }

  // --- fresh install: nothing invented ------------------------------------------------
  {
    const { userData, hub } = setup('stable')
    initStorageDir(userData, true, true)
    check(
      'a fresh install creates no database file',
      !existsSync(join(hub, 'slayzone.data.sqlite')) && !existsSync(join(hub, 'slayzone.sqlite'))
    )
  }

  // --- no instance lock: touch NOTHING ---------------------------------------------------
  // A second launch while the old app still runs (v0.35.0 holds the same lock, same
  // userData) must not copy its live WAL database, nor rename a live hub's. The caller
  // passes whether it holds the lock; without it the whole first-launch pass is skipped.
  {
    const { userData, hub } = setup('stable')
    writeFileSync(join(userData, 'slayzone.sqlite'), 'V035-DB')
    const target = initStorageDir(userData, true, false)
    check('without the lock the hub root is still returned', target === hub, target)
    check('without the lock nothing is copied', !existsSync(join(hub, 'slayzone.data.sqlite')))
    check('without the lock not even the hub root is created', !existsSync(hub))
    check('without the lock the source is untouched', read(join(userData, 'slayzone.sqlite')) === 'V035-DB')
    initStorageDir(userData, true, true)
    check('the next launch that DOES hold the lock imports it', read(join(hub, 'slayzone.data.sqlite')) === 'V035-DB')
  }
  {
    const { userData, hub } = setup('stable')
    mkdirSync(hub, { recursive: true })
    writeFileSync(join(hub, 'slayzone.sqlite'), 'LIVE-BETA-DB')
    initStorageDir(userData, true, false)
    check(
      'without the lock a live hub root is not renamed under its owner',
      read(join(hub, 'slayzone.sqlite')) === 'LIVE-BETA-DB' && !existsSync(join(hub, 'slayzone.data.sqlite'))
    )
  }

  // --- idempotent ------------------------------------------------------------------------
  {
    const { userData, hub } = setup('stable')
    writeFileSync(join(userData, 'slayzone.sqlite'), 'V035-DB')
    initStorageDir(userData, true, true)
    writeFileSync(join(hub, 'slayzone.data.sqlite'), 'NEW-WORK') // the user has since used the app
    initStorageDir(userData, true, true)
    check('a second boot never touches the live DB', read(join(hub, 'slayzone.data.sqlite')) === 'NEW-WORK')
  }
} finally {
  if (prevRoot === undefined) delete process.env.SLAYZONE_ROOT
  else process.env.SLAYZONE_ROOT = prevRoot
  if (prevChannel === undefined) delete process.env.SLAYZONE_RELEASE_CHANNEL
  else process.env.SLAYZONE_RELEASE_CHANNEL = prevChannel
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
