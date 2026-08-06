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
import {
  readClientSettings,
  updateClientSettings,
  clientSettingsPath
} from './client-settings.js'

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
