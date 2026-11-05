import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  canonicalComputerPath,
  computerPathWithin,
  isWindowsComputerPath,
  normalizeComputerPath,
  volumeIsCaseInsensitive
} from './computer-path'

describe('canonicalComputerPath: one key for the owner check and the jail', () => {
  it('K1: a leading // is POSIX, the same path as /', () => {
    expect(isWindowsComputerPath('//home/a/x')).toBe(false)
    expect(canonicalComputerPath('//home/a/x', false)).toBe('/home/a/x')
    expect(computerPathWithin('//srv/hub/hub.db', '/srv/hub')).toBe(true)
  })

  it('NFC: both Unicode forms of a name are one key', () => {
    expect(canonicalComputerPath('/a/cafe\u0301', false)).toBe(
      canonicalComputerPath('/a/caf\u00e9', false)
    )
  })

  it('case folds only when the volume does (Windows always)', () => {
    expect(computerPathWithin('/A/COMPUTER.CONFIG.JSON', '/a', true)).toBe(true)
    expect(computerPathWithin('/A/x', '/a', false)).toBe(false)
    expect(computerPathWithin('C:\\Users\\A\\X', 'c:\\users\\a')).toBe(true)
  })

  it('volumeIsCaseInsensitive probes the real volume', () => {
    const probed = volumeIsCaseInsensitive(tmpdir())
    expect(typeof probed).toBe('boolean')
    if (process.platform === 'linux') expect(probed).toBe(false)
  })
})

describe('normalizeComputerPath', () => {
  it.each([
    ['/home/a/wt/feat/', '/home/a/wt/feat'],
    ['/home/a/wt/feat/../../.ssh', '/home/a/.ssh'],
    ['/home/a//wt/./feat', '/home/a/wt/feat'],
    ['/', '/'],
    // POSIX: a backslash is a name character, never a separator.
    ['/home/a/wt/feat\\x', '/home/a/wt/feat\\x'],
    ['/home/a/wt/feat\\..\\..\\x', '/home/a/wt/feat\\..\\..\\x'],
    // Windows: drive, either separator.
    ['C:/code/proj', 'C:\\code\\proj'],
    ['C:\\code\\proj\\', 'C:\\code\\proj'],
    ['C:\\code\\proj/../x', 'C:\\code\\x'],
    ['C:\\', 'C:\\'],
    // Windows: UNC — `..` never climbs out of the share.
    ['\\\\srv\\share\\a-wt\\feat\\..\\..\\x', '\\\\srv\\share\\x'],
    ['\\\\srv\\share\\..\\..\\x', '\\\\srv\\share\\x']
  ])('%s → %s', (input, out) => {
    expect(normalizeComputerPath(input)).toBe(out)
  })

  it('flavour from the path itself', () => {
    expect(isWindowsComputerPath('C:\\x')).toBe(true)
    expect(isWindowsComputerPath('\\\\srv\\share')).toBe(true)
    expect(isWindowsComputerPath('/home/a\\b')).toBe(false)
  })
})

describe('computerPathWithin', () => {
  it('a POSIX root has only `/` as its boundary (G2)', () => {
    expect(computerPathWithin('/home/a/wt/feat/x', '/home/a/wt/feat')).toBe(true)
    expect(computerPathWithin('/home/a/wt/feat\\x', '/home/a/wt/feat')).toBe(false)
    expect(computerPathWithin('/home/a/wt/feat-evil', '/home/a/wt/feat')).toBe(false)
    expect(computerPathWithin('/x', '/')).toBe(true)
  })

  it('a Windows root has `\\` (normalized) as its boundary', () => {
    const root = normalizeComputerPath('C:/code/proj')
    expect(computerPathWithin(normalizeComputerPath('C:\\code\\proj\\src'), root)).toBe(true)
    expect(computerPathWithin(normalizeComputerPath('C:\\code\\proj-x'), root)).toBe(false)
  })
})
