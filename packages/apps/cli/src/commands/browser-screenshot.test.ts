/**
 * `slay browser screenshot` on the CLI side: it turns the hub's reply into image bytes
 * and writes them on THIS machine — failing loudly against a hub too old to send
 * bytes, and keeping its default directory private to this user on shared /tmp.
 */
import { afterAll, describe, expect, test } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { screenshotBytes, writeScreenshot } from './browser-screenshot'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const base = mkdtempSync(join(tmpdir(), 'slay-shot-test-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('screenshotBytes', () => {
  test('decodes the bytes a current hub sends', () => {
    expect(Buffer.from(screenshotBytes({ ok: true, pngBase64: PNG.toString('base64') }))).toEqual(
      PNG
    )
  })

  test('a hub too old to send bytes (it sends a path on its own disk) fails clearly', () => {
    expect(() => screenshotBytes({ ok: true, path: '/var/hub/tmp/x.png' })).toThrow(
      /hub is too old for this slay CLI/
    )
    expect(() => screenshotBytes({ ok: true })).toThrow(/hub is too old/)
  })
})

describe('writeScreenshot', () => {
  const posix = process.platform !== 'win32'

  test('writes to --output when given', () => {
    const out = join(base, 'chosen.png')
    expect(writeScreenshot(PNG, out, base)).toBe(out)
    expect(readFileSync(out)).toEqual(PNG)
  })

  test('default: a per-user 0700 directory, a 0600 file', () => {
    const out = writeScreenshot(PNG, undefined, base)
    expect(readFileSync(out)).toEqual(PNG)
    expect(out.startsWith(base)).toBe(true)
    if (posix) {
      const dir = join(out, '..')
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, '..')).mode & 0o777).toBe(0o700)
      expect(statSync(out).mode & 0o777).toBe(0o600)
      expect(out).toContain(`slayzone-${process.getuid?.()}`)
    }
  })

  test.runIf(process.platform !== 'win32')(
    'tightens a pre-existing directory this user owns',
    () => {
      const other = mkdtempSync(join(tmpdir(), 'slay-shot-loose-'))
      const userDir = join(other, `slayzone-${process.getuid?.()}`)
      mkdirSync(join(userDir, 'browser-screenshots'), { recursive: true, mode: 0o755 })
      chmodSync(userDir, 0o755)
      const out = writeScreenshot(PNG, undefined, other)
      expect(lstatSync(userDir).mode & 0o777).toBe(0o700)
      expect(readFileSync(out)).toEqual(PNG)
      rmSync(other, { recursive: true, force: true })
    }
  )
})
