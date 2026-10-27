/**
 * Tests for discovering Chrome extensions installed in the user's other browsers
 * (the browser panel's "Available extensions" import list).
 *
 * Chromium browsers keep one Extensions/ dir per PROFILE, and a profile is often not
 * `Default` (a Chrome with only "Profile 1" + "Profile 4" is common), so every profile
 * must be scanned and labelled with its display name from `Local State`.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverBrowserExtensions } from './browser-extension-discovery'

const ONEPASSWORD = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'

function addExtension(
  profileDir: string,
  id: string,
  version: string,
  manifest: Record<string, unknown>,
  messages?: Record<string, { message: string }>
): string {
  const dir = join(profileDir, 'Extensions', id, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  if (messages) {
    mkdirSync(join(dir, '_locales', 'en'), { recursive: true })
    writeFileSync(join(dir, '_locales', 'en', 'messages.json'), JSON.stringify(messages))
  }
  return dir
}

function localState(userDataDir: string, names: Record<string, string>): void {
  mkdirSync(userDataDir, { recursive: true })
  const info_cache = Object.fromEntries(Object.entries(names).map(([k, name]) => [k, { name }]))
  writeFileSync(join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache } }))
}

describe('browser-extension-discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'slz-ext-discovery-'))
  const chrome = join(root, 'Google', 'Chrome')

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('finds extensions in non-Default profiles, labelled by profile name', async () => {
    localState(chrome, { 'Profile 1': 'Kalle', 'Profile 4': 'Work' })
    const op = addExtension(join(chrome, 'Profile 1'), ONEPASSWORD, '8.11.0_0', {
      name: '1Password – Password Manager',
      version: '8.11.0',
      manifest_version: 3
    })
    addExtension(join(chrome, 'Profile 4'), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '1.0_0', {
      name: 'Work Tool',
      version: '1.0'
    })
    const found = await discoverBrowserExtensions({
      appSupportDir: root,
      loadedIds: new Set()
    })
    expect(found.map((g) => g.name)).toEqual(['Chrome (Kalle)', 'Chrome (Work)'])
    expect(found[0].extensions).toEqual([
      {
        id: ONEPASSWORD,
        name: '1Password – Password Manager',
        version: '8.11.0',
        path: op,
        alreadyImported: false,
        manifestVersion: 3
      }
    ])
  })

  test('picks the newest installed version, numerically', async () => {
    const r = join(root, 'v')
    const p = join(r, 'Google', 'Chrome', 'Default')
    addExtension(p, ONEPASSWORD, '8.9.0_0', { name: 'old', version: '8.9.0' })
    const newest = addExtension(p, ONEPASSWORD, '8.10.0_0', {
      name: 'new',
      version: '8.10.0'
    })
    const found = await discoverBrowserExtensions({
      appSupportDir: r,
      loadedIds: new Set()
    })
    expect(found[0].extensions[0].path).toEqual(newest)
  })

  test('a Default-only browser without Local State still works, plain name', async () => {
    const r = join(root, 'd')
    addExtension(join(r, 'BraveSoftware', 'Brave-Browser', 'Default'), ONEPASSWORD, '1_0', {
      name: 'x',
      version: '1'
    })
    const found = await discoverBrowserExtensions({
      appSupportDir: r,
      loadedIds: new Set()
    })
    expect(found.map((g) => g.name)).toEqual(['Brave'])
  })

  test('resolves __MSG_ names from _locales', async () => {
    const r = join(root, 'm')
    addExtension(
      join(r, 'Google', 'Chrome', 'Default'),
      ONEPASSWORD,
      '1_0',
      { name: '__MSG_appName__', version: '1' },
      { appName: { message: '1Password' } }
    )
    const found = await discoverBrowserExtensions({
      appSupportDir: r,
      loadedIds: new Set()
    })
    expect(found[0].extensions[0].name).toEqual('1Password')
  })

  test('marks extensions already loaded in the panel', async () => {
    const found = await discoverBrowserExtensions({
      appSupportDir: root,
      loadedIds: new Set([ONEPASSWORD])
    })
    expect(found[0].extensions[0].alreadyImported).toEqual(true)
  })

  test('skips Temp, dotfiles, unreadable manifests and System/Guest profiles', async () => {
    const r = join(root, 's')
    const c = join(r, 'Google', 'Chrome')
    mkdirSync(join(c, 'Default', 'Extensions', 'Temp'), { recursive: true })
    mkdirSync(join(c, 'Default', 'Extensions', '.DS_Store'), {
      recursive: true
    })
    mkdirSync(join(c, 'Default', 'Extensions', 'cccccccccccccccccccccccccccccccc', '1_0'), {
      recursive: true
    })
    addExtension(join(c, 'System Profile'), ONEPASSWORD, '1_0', {
      name: 'x',
      version: '1'
    })
    addExtension(join(c, 'Guest Profile'), ONEPASSWORD, '1_0', {
      name: 'x',
      version: '1'
    })
    expect(
      await discoverBrowserExtensions({
        appSupportDir: r,
        loadedIds: new Set()
      })
    ).toEqual([])
  })

  test('no browsers installed → empty', async () => {
    const r = join(root, 'none')
    mkdirSync(r)
    expect(
      await discoverBrowserExtensions({
        appSupportDir: r,
        loadedIds: new Set()
      })
    ).toEqual([])
  })
})
