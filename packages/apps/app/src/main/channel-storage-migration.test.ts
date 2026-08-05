/**
 * channel-storage-migration — COPY-ONLY move of the desktop app's state from
 * the legacy FLAT, shared `~/.slayzone` into the new channel-scoped hub/runner
 * roots. The legacy dir is treated as STRICTLY READ-ONLY, same rule and same
 * reason as `storage-migration.ts`: dev/beta/stable currently share one flat
 * root, so an old, not-yet-updated build could still be live and writing to it
 * while a newer build runs this migration — deleting/moving the source out
 * from under a still-running peer is exactly the incident that already
 * happened once (see `storage-migration.ts`'s file header). This migration
 * never calls `rm`/`rename`/`unlink` on the legacy root, only copies out of it.
 *
 * Pure Node (real temp dirs, no electron/native deps) → runs under plain
 * `npx tsx`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureChannelScopedStorage } from './channel-storage-migration'

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

/** `runner.state.json` legitimately may not exist on disk when there was no
 *  legacy credential data to migrate — `credential-store.ts`'s reader already
 *  treats a missing file as an empty map, so the migration doesn't force-create
 *  one just to have something present. Mirror that same graceful read here. */
function readState(runnerRoot: string): Record<string, unknown> {
  const path = join(runnerRoot, 'runner.state.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {}
}

function setup(): { legacyRoot: string; hubRoot: string; runnerRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'slz-channel-mig-'))
  return {
    legacyRoot: join(base, 'legacy'),
    hubRoot: join(base, 'dev', 'hub'),
    runnerRoot: join(base, 'dev', 'runner')
  }
}

// --- hub slice: DB + content + backups + loose files, source untouched -------
{
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  const legacyStorage = join(legacyRoot, 'storage')
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

  ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })

  check('DB copied', readFileSync(join(hubRoot, 'slayzone.dev.sqlite'), 'utf8') === 'DEVDB')
  check(
    'wal + shm copied',
    existsSync(join(hubRoot, 'slayzone.dev.sqlite-wal')) && existsSync(join(hubRoot, 'slayzone.dev.sqlite-shm'))
  )
  check('artifacts copied (recursive)', readFileSync(join(hubRoot, 'artifacts', 't1', 'a.md'), 'utf8') === 'ART')
  check('blobs copied (recursive)', readFileSync(join(hubRoot, 'blobs', 'd8', '3c76abcd'), 'utf8') === 'BLOBCONTENT')
  check(
    'most-recent backup copied, older one left behind',
    existsSync(join(hubRoot, 'backups', 'slayzone.dev.2026-03-01T00-00-00-000Z.manual.sqlite'))
  )
  check('boot-config.json copied (missed by storage-migration.ts scope)', existsSync(join(hubRoot, 'boot-config.json')))
  check('hub-tokens.json copied (missed by storage-migration.ts scope)', existsSync(join(hubRoot, 'hub-tokens.json')))

  check('source DB PRESERVED', readFileSync(join(legacyStorage, 'slayzone.dev.sqlite'), 'utf8') === 'DEVDB')
  check('source artifacts PRESERVED', readFileSync(join(legacyStorage, 'artifacts', 't1', 'a.md'), 'utf8') === 'ART')
  check(
    'source boot-config.json / hub-tokens.json PRESERVED',
    existsSync(join(legacyStorage, 'boot-config.json')) && existsSync(join(legacyStorage, 'hub-tokens.json'))
  )
}

// --- runner slice: TRANSFORM, per-host files → one shared map ----------------
{
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  const legacyRunners = join(legacyRoot, 'runners')
  mkdirSync(legacyRunners, { recursive: true })
  writeFileSync(
    join(legacyRunners, 'hub-a.example_8443.json'),
    JSON.stringify({ runnerId: 'r-a', apiKey: 'key-a' })
  )
  writeFileSync(
    join(legacyRunners, 'hub-b.example_9000.json'),
    JSON.stringify({ runnerId: 'r-b', apiKey: 'key-b', pinnedFingerprint: 'f'.repeat(64) })
  )

  ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })

  const statePath = join(runnerRoot, 'runner.state.json')
  check('runner.state.json created (single file, not a directory of files)', existsSync(statePath))
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
  check('first hub entry merged in, keyed by hub-host derived from filename', JSON.stringify(state['hub-a.example_8443']) === JSON.stringify({ runnerId: 'r-a', apiKey: 'key-a' }))
  check(
    'second hub entry merged in alongside the first — not overwritten',
    JSON.stringify(state['hub-b.example_9000']) === JSON.stringify({ runnerId: 'r-b', apiKey: 'key-b', pinnedFingerprint: 'f'.repeat(64) })
  )
  check('exactly two entries — no stray keys', Object.keys(state).length === 2)
  check(
    'legacy per-host files PRESERVED (copy semantics, not move)',
    existsSync(join(legacyRunners, 'hub-a.example_8443.json')) && existsSync(join(legacyRunners, 'hub-b.example_9000.json'))
  )
}

// --- a malformed legacy credential file is skipped, not fatal ----------------
{
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  const legacyRunners = join(legacyRoot, 'runners')
  mkdirSync(legacyRunners, { recursive: true })
  writeFileSync(join(legacyRunners, 'good-hub.json'), JSON.stringify({ runnerId: 'r1', apiKey: 'k1' }))
  writeFileSync(join(legacyRunners, 'corrupt-hub.json'), 'not json at all')

  let threw = false
  try {
    ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })
  } catch {
    threw = true
  }
  check('does not throw on one corrupt legacy file', !threw)
  const state = JSON.parse(readFileSync(join(runnerRoot, 'runner.state.json'), 'utf8')) as Record<string, unknown>
  check('the good entry still migrated despite the corrupt sibling', 'good-hub' in state)
  check('the corrupt entry is simply absent, not a garbage value', !('corrupt-hub' in state))
}

// --- independent sentinels: hub and runner slices don't gate on each other ---
{
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
  writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'DB')
  // No legacy runners/ dir at all this time.

  ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })

  check('hub slice completed independently', existsSync(join(hubRoot, 'slayzone.dev.sqlite')))
  check('runner slice completed independently (empty state, no legacy creds)', Object.keys(readState(runnerRoot)).length === 0)
  check('hub sentinel written', existsSync(join(hubRoot, '.channel-migrated')))
  check('runner sentinel written', existsSync(join(runnerRoot, '.channel-migrated')))
}

// --- sentinel makes a re-run a genuine no-op --------------------------------
{
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
  writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'DB')
  mkdirSync(join(legacyRoot, 'runners'), { recursive: true })
  writeFileSync(join(legacyRoot, 'runners', 'hub-a.json'), JSON.stringify({ runnerId: 'r1', apiKey: 'k1' }))

  ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })

  // Simulate the legacy shared dir gaining new content after the first boot
  // (an old, not-yet-updated peer build still writing to it).
  writeFileSync(join(legacyRoot, 'runners', 'hub-b.json'), JSON.stringify({ runnerId: 'r2', apiKey: 'k2' }))
  mkdirSync(join(legacyRoot, 'storage', 'blobs', 'ff'), { recursive: true })
  writeFileSync(join(legacyRoot, 'storage', 'blobs', 'ff', 'laterblob'), 'LATER')

  ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false }) // second boot

  check('sentinel makes 2nd run a no-op — later hub blob NOT picked up', !existsSync(join(hubRoot, 'blobs', 'ff', 'laterblob')))
  const state = JSON.parse(readFileSync(join(runnerRoot, 'runner.state.json'), 'utf8')) as Record<string, unknown>
  check('sentinel makes 2nd run a no-op — later runner credential NOT picked up', !('hub-b' in state))
}

// --- never clobbers already-populated destination content --------------------
{
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  mkdirSync(hubRoot, { recursive: true })
  writeFileSync(join(hubRoot, 'slayzone.dev.sqlite'), 'EXISTING')
  writeFileSync(join(hubRoot, 'boot-config.json'), '{"already":"here"}')
  mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
  writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'INCOMING')
  writeFileSync(join(legacyRoot, 'storage', 'boot-config.json'), '{"incoming":"value"}')

  ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })

  check('existing DB not clobbered', readFileSync(join(hubRoot, 'slayzone.dev.sqlite'), 'utf8') === 'EXISTING')
  check(
    'existing boot-config.json not clobbered',
    readFileSync(join(hubRoot, 'boot-config.json'), 'utf8') === '{"already":"here"}'
  )
}

// --- no-op when there is nothing to migrate (fresh install) ------------------
{
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })
  check('fresh install: hub root created, no throw', existsSync(hubRoot))
  check('fresh install: runner root created, no throw', existsSync(runnerRoot))
  check('fresh install: no runner.state.json forced into existence with nothing to migrate', Object.keys(readState(runnerRoot)).length === 0)
}

// --- REGRESSION GUARD: a copy failure must never touch the legacy source -----
// The direct test for the safety lesson storage-migration.ts's file header
// describes: a migration that can fail partway through a copy must still
// leave the legacy source completely intact, since it may be a still-live
// peer's only copy of that data.
if (process.platform === 'win32') {
  console.log('  (skipped copy-failure regression guard — POSIX mode bits are not enforced on Windows)')
} else if (process.getuid?.() === 0) {
  console.log('  (skipped copy-failure regression guard — running as root ignores permission bits)')
} else {
  const { legacyRoot, hubRoot, runnerRoot } = setup()
  mkdirSync(join(legacyRoot, 'storage'), { recursive: true })
  writeFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'DEVDB')
  mkdirSync(hubRoot, { recursive: true })
  chmodSync(hubRoot, 0o555) // read-only: the DB copy into it must fail

  let threw = false
  try {
    ensureChannelScopedStorage({ legacyRoot, hubRoot, runnerRoot, packaged: false })
  } catch {
    threw = true
  } finally {
    chmodSync(hubRoot, 0o755) // restore so the tmpdir can be cleaned up below
  }

  check('a write failure into the destination propagates (does not fail silently)', threw)
  check(
    'legacy source DB is COMPLETELY UNTOUCHED after a failed copy',
    readFileSync(join(legacyRoot, 'storage', 'slayzone.dev.sqlite'), 'utf8') === 'DEVDB'
  )
  check('no sentinel was written for the failed slice (a retry can still happen)', !existsSync(join(hubRoot, '.channel-migrated')))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
