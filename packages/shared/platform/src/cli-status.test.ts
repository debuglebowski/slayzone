import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkCliInstalled, parseCliVersion } from './cli-install'

// Real exec against fake `slay` scripts on a controlled PATH. The app's own install
// target is injected into a temp dir we own: on darwin the real default is
// /usr/local/bin/slay, which a developer box may really have installed.
const posixOnly = process.platform === 'win32' ? test.skip : test

let tmp: string
let savedHome: string | undefined
/** Injected install target — never the real getCliBinTarget(). */
let target: string

function fakeSlay(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'slay')
  fs.writeFileSync(p, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 })
  return p
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-cli-status-'))
  savedHome = process.env.HOME
  process.env.HOME = path.join(tmp, 'home')
  target = path.join(tmp, 'managed', 'bin', 'slay')
})

afterEach(() => {
  process.env.HOME = savedHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onPath =
  (...dirs: string[]) =>
  async () =>
    [...dirs, '/usr/bin', '/bin'].join(':')

describe('parseCliVersion', () => {
  test('bare and prefixed', () => {
    expect(parseCliVersion('0.37.2\n')).toBe('0.37.2')
    expect(parseCliVersion('slay v1.2.3-beta.1')).toBe('1.2.3-beta.1')
    expect(parseCliVersion('garbage')).toBeNull()
  })
})

describe('checkCliInstalled', () => {
  posixOnly('missing everywhere → not installed', async () => {
    const r = await checkCliInstalled({
      expectedVersion: '1.0.0',
      cliTarget: target,
      resolvePath: onPath(tmp)
    })
    expect(r.installed).toBe(false)
  })

  posixOnly('slay on PATH outside the install target counts as installed', async () => {
    const npmBin = path.join(tmp, 'npm', 'bin')
    const p = fakeSlay(npmBin, '1.0.0')
    const r = await checkCliInstalled({
      expectedVersion: '1.0.0',
      cliTarget: target,
      resolvePath: onPath(npmBin)
    })
    expect(r).toMatchObject({ installed: true, path: p, version: '1.0.0', outdated: false })
    expect(r.appManaged).toBe(false)
  })

  posixOnly('stale copy on PATH → outdated', async () => {
    const npmBin = path.join(tmp, 'npm', 'bin')
    fakeSlay(npmBin, '0.9.0')
    const r = await checkCliInstalled({
      expectedVersion: '1.0.0',
      cliTarget: target,
      resolvePath: onPath(npmBin)
    })
    expect(r).toMatchObject({ installed: true, version: '0.9.0', outdated: true })
  })

  posixOnly('no expected version → never outdated', async () => {
    const npmBin = path.join(tmp, 'npm', 'bin')
    fakeSlay(npmBin, '0.9.0')
    const r = await checkCliInstalled({
      expectedVersion: null,
      cliTarget: target,
      resolvePath: onPath(npmBin)
    })
    expect(r.outdated).toBe(false)
  })

  posixOnly('unreadable version → installed, not outdated', async () => {
    const npmBin = path.join(tmp, 'npm', 'bin')
    fs.mkdirSync(npmBin, { recursive: true })
    fs.writeFileSync(path.join(npmBin, 'slay'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const r = await checkCliInstalled({
      expectedVersion: '1.0.0',
      cliTarget: target,
      resolvePath: onPath(npmBin)
    })
    expect(r).toMatchObject({ installed: true, version: null, outdated: false })
  })

  posixOnly('install target not on PATH → installed, appManaged, pathNotInPATH', async () => {
    fakeSlay(path.dirname(target), '1.0.0')
    const r = await checkCliInstalled({
      expectedVersion: '1.0.0',
      cliTarget: target,
      resolvePath: onPath(tmp)
    })
    expect(r).toMatchObject({
      installed: true,
      path: target,
      appManaged: true,
      pathNotInPATH: true,
      outdated: false
    })
  })

  posixOnly('PATH hit wins over the install target', async () => {
    fakeSlay(path.dirname(target), '1.0.0')
    const npmBin = path.join(tmp, 'npm', 'bin')
    const stale = fakeSlay(npmBin, '0.9.0')
    const r = await checkCliInstalled({
      expectedVersion: '1.0.0',
      cliTarget: target,
      resolvePath: onPath(npmBin)
    })
    expect(r).toMatchObject({ path: stale, outdated: true, appManaged: false })
  })
})
