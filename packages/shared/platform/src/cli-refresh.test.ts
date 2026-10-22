/**
 * refreshWindowsCliIn — keep the Windows `slay` copy current across app upgrades.
 *
 * THE HAZARD THIS PINS. On macOS/Linux `slay` is a symlink into the app bundle, so it is
 * always the running app's CLI. On Windows the installer COPIES `slay.js` next to a
 * `slay.cmd` shim and never touched it again. v0.35.0's `slay.js` opens the app's SQLite
 * file directly (`<userData>/slayzone.sqlite`); the upgraded app keeps its data in the
 * hub root under a new name and leaves that file behind, copy-only. So after an upgrade
 * every `slay` write — including the ones agents make from a terminal — landed in an
 * abandoned database the app never reads. Refreshing the copy at launch closes it: the
 * current CLI talks to the hub over REST and opens no database at all.
 *
 * Pure Node (real temp dirs). `refreshWindowsCliIn` takes the directory explicitly, so
 * these run on any host without faking `process.platform`.
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshWindowsCliIn } from './cli-refresh'

const dirs: string[] = []
const canDenyWrite = process.platform !== 'win32' && process.getuid?.() !== 0

function setup(): { srcJs: string; binDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'slz-cli-refresh-'))
  dirs.push(base)
  const bundle = join(base, 'app', 'resources', 'bin')
  const binDir = join(base, 'LocalAppData', 'SlayZone', 'bin')
  mkdirSync(bundle, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  const srcJs = join(bundle, 'slay.js')
  writeFileSync(srcJs, '// NEW CLI (REST)')
  return { srcJs, binDir }
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    // A denied-write case restores its mode, but be safe so cleanup never throws.
    try {
      chmodSync(d, 0o755)
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true })
  }
})

describe('refreshWindowsCliIn', () => {
  test('replaces a stale slay.js (the v0.35.0 copy) with the bundled one', () => {
    const { srcJs, binDir } = setup()
    writeFileSync(join(binDir, 'slay.cmd'), '@echo off\r\nnode "%~dp0slay.js" %*\r\n')
    writeFileSync(join(binDir, 'slay.js'), '// OLD CLI (opens sqlite directly)')
    const r = refreshWindowsCliIn(srcJs, binDir)
    expect(r.status).toBe('refreshed')
    expect(readFileSync(join(binDir, 'slay.js'), 'utf8')).toBe('// NEW CLI (REST)')
  })

  test('rewrites the .cmd shim too, so the two never disagree', () => {
    const { srcJs, binDir } = setup()
    writeFileSync(join(binDir, 'slay.cmd'), 'OLD SHIM')
    writeFileSync(join(binDir, 'slay.js'), '// OLD')
    refreshWindowsCliIn(srcJs, binDir)
    const shim = readFileSync(join(binDir, 'slay.cmd'), 'utf8')
    expect(shim.startsWith('@echo off')).toBe(true)
    expect(shim.includes('slay.js')).toBe(true)
  })

  test('leaves no temp file behind', () => {
    const { srcJs, binDir } = setup()
    writeFileSync(join(binDir, 'slay.cmd'), 'x')
    writeFileSync(join(binDir, 'slay.js'), '// OLD')
    refreshWindowsCliIn(srcJs, binDir)
    expect(readdirSync(binDir).sort()).toEqual(['slay.cmd', 'slay.js'])
  })

  test('does nothing when the CLI was never installed (not the user’s choice to make)', () => {
    const { srcJs, binDir } = setup()
    const r = refreshWindowsCliIn(srcJs, binDir)
    expect(r.status).toBe('noop')
    expect(existsSync(join(binDir, 'slay.js'))).toBe(false)
    expect(existsSync(join(binDir, 'slay.cmd'))).toBe(false)
  })

  test('is a no-op once the copy is current', () => {
    const { srcJs, binDir } = setup()
    writeFileSync(join(binDir, 'slay.cmd'), 'x')
    writeFileSync(join(binDir, 'slay.js'), '// OLD')
    expect(refreshWindowsCliIn(srcJs, binDir).status).toBe('refreshed')
    expect(refreshWindowsCliIn(srcJs, binDir).status).toBe('noop')
  })

  test('with no bundled slay.js (dev build) the installed copy is left alone', () => {
    const { binDir } = setup()
    writeFileSync(join(binDir, 'slay.cmd'), 'x')
    writeFileSync(join(binDir, 'slay.js'), '// OLD')
    const r = refreshWindowsCliIn(join(binDir, '..', 'missing', 'slay.js'), binDir)
    expect(r.status).toBe('noop')
    expect(readFileSync(join(binDir, 'slay.js'), 'utf8')).toBe('// OLD')
  })

  test.runIf(canDenyWrite)(
    'a write that fails is reported, never thrown, and the old copy survives',
    () => {
      const { srcJs, binDir } = setup()
      writeFileSync(join(binDir, 'slay.cmd'), 'x')
      writeFileSync(join(binDir, 'slay.js'), '// OLD')
      chmodSync(binDir, 0o555) // cannot create the temp file
      const r = refreshWindowsCliIn(srcJs, binDir)
      chmodSync(binDir, 0o755)
      expect(r.status).toBe('failed')
      expect(readFileSync(join(binDir, 'slay.js'), 'utf8')).toBe('// OLD')
      expect(readdirSync(binDir).sort()).toEqual(['slay.cmd', 'slay.js'])
    }
  )
})
