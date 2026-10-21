/**
 * The client-local settings store.
 *
 * These assert the failure modes that would silently lose a user's settings, which
 * is the only interesting part of a JSON file:
 *   - a corrupt file must NOT read as defaults (that flips a light-mode user to
 *     dark and looks like a preference change, not a fault);
 *   - a write must preserve fields this binary does not know about, so a downgrade
 *     after an upgrade does not delete the newer build's keys;
 *   - concurrent read-modify-write must not lose an update — `writeJsonAtomic` is
 *     atomic per write, but the read-modify-write around it is not, and several
 *     subsystems write here.
 *
 * Run with: npx tsx --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/platform/src/client-settings.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, expect } from '../../test-utils/ipc-harness.js'
import { readClientSettings, updateClientSettings, clientSettingsPath } from './client-settings.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-client-settings-'))
const file = clientSettingsPath(dir)

test('missing file reads as all-defaults, no throw', () => {
  expect(Object.keys(readClientSettings(dir)).length).toBe(0)
})

test('round-trips a patch and creates the file 0600 in a 0700 dir', async () => {
  await updateClientSettings({ theme: 'light' }, dir)
  expect(readClientSettings(dir).theme).toBe('light')
  expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
  expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe('700')
})

test('merges without clobbering unrelated groups', async () => {
  await updateClientSettings({ labs: { testsPanel: true } }, dir)
  const got = readClientSettings(dir)
  expect(got.theme).toBe('light')
  expect(got.labs?.testsPanel).toBe(true)
})

test('preserves fields this binary does not know about (downgrade safety)', async () => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.somethingFromAFutureVersion = { keep: 'me' }
  fs.writeFileSync(file, JSON.stringify(raw))
  await updateClientSettings({ theme: 'dark' }, dir)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(after.somethingFromAFutureVersion.keep).toBe('me')
  expect(after.theme).toBe('dark')
})

test('a malformed group reads as unset without discarding the rest', async () => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.floatingAgentPanel = { expandedSize: { width: 'wide', height: null } }
  fs.writeFileSync(file, JSON.stringify(raw))
  const got = readClientSettings(dir)
  expect(got.floatingAgentPanel?.expandedSize).toBe(undefined)
  expect(got.theme).toBe('dark')
})

test('corrupt JSON is renamed aside, not silently treated as defaults', () => {
  fs.writeFileSync(file, '{ this is not json')
  const got = readClientSettings(dir)
  expect(Object.keys(got).length).toBe(0)
  const salvaged = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))
  expect(salvaged.length).toBe(1)
  expect(fs.readFileSync(path.join(dir, salvaged[0]), 'utf8')).toBe('{ this is not json')
  expect(fs.existsSync(file)).toBe(false)
})

test('concurrent updates serialize — no lost write', async () => {
  await Promise.all([
    updateClientSettings({ theme: 'system' }, dir),
    updateClientSettings({ labs: { loopMode: true } }, dir),
    updateClientSettings({ cli: { migrationDialogShown: true } }, dir)
  ])
  const got = readClientSettings(dir)
  expect(got.theme).toBe('system')
  expect(got.labs?.loopMode).toBe(true)
  expect(got.cli?.migrationDialogShown).toBe(true)
})

// --- rename: client-settings.json → client.config.json -----------------------------
// beta.14–18 wrote `client-settings.json`. The rename must carry those users' theme,
// shortcuts and labs across — and because the DB→file migration is sentinel-gated,
// nothing else would ever restore them if the new name simply started empty.
function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slay-client-config-'))
}

test('file is named client.config.json (the <role>.config.json convention)', () => {
  expect(path.basename(clientSettingsPath(dir))).toBe('client.config.json')
})

test('beta client-settings.json is adopted on read; the old file is left byte-identical', () => {
  const d = freshDir()
  const legacy = path.join(d, 'client-settings.json')
  const bytes = JSON.stringify({ theme: 'light', labs: { loopMode: true }, fromFuture: { keep: 1 } })
  fs.writeFileSync(legacy, bytes)
  const got = readClientSettings(d)
  expect(got.theme).toBe('light')
  expect(got.labs?.loopMode).toBe(true)
  expect(fs.existsSync(clientSettingsPath(d))).toBe(true)
  expect(JSON.parse(fs.readFileSync(clientSettingsPath(d), 'utf8')).fromFuture.keep).toBe(1)
  expect(fs.readFileSync(legacy, 'utf8')).toBe(bytes)
  expect((fs.statSync(clientSettingsPath(d)).mode & 0o777).toString(8)).toBe('600')
})

test('an update on a legacy-only dir merges over the beta values and leaves the old file alone', async () => {
  const d = freshDir()
  const legacy = path.join(d, 'client-settings.json')
  const bytes = JSON.stringify({ theme: 'dark', labs: { testsPanel: true } })
  fs.writeFileSync(legacy, bytes)
  await updateClientSettings({ cli: { migrationDialogShown: true } }, d)
  const got = readClientSettings(d)
  expect(got.theme).toBe('dark')
  expect(got.labs?.testsPanel).toBe(true)
  expect(got.cli?.migrationDialogShown).toBe(true)
  expect(fs.readFileSync(legacy, 'utf8')).toBe(bytes)
})

test('when both files exist the new one wins and the old is ignored', () => {
  const d = freshDir()
  fs.writeFileSync(path.join(d, 'client-settings.json'), JSON.stringify({ theme: 'light' }))
  fs.writeFileSync(clientSettingsPath(d), JSON.stringify({ theme: 'dark' }))
  expect(readClientSettings(d).theme).toBe('dark')
})

test('an unparseable beta file is not adopted, renamed or deleted', () => {
  const d = freshDir()
  const legacy = path.join(d, 'client-settings.json')
  fs.writeFileSync(legacy, '{ nope')
  expect(Object.keys(readClientSettings(d)).length).toBe(0)
  expect(fs.existsSync(clientSettingsPath(d))).toBe(false)
  expect(fs.readFileSync(legacy, 'utf8')).toBe('{ nope')
  expect(fs.readdirSync(d).filter((f) => f.includes('.corrupt-')).length).toBe(0)
})

test('nothing on disk: a read creates nothing', () => {
  const d = freshDir()
  readClientSettings(d)
  expect(fs.readdirSync(d).length).toBe(0)
})
