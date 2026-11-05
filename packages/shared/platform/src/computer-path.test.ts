import { describe, expect, it } from 'vitest'
import { computerPathWithin, isWindowsComputerPath, normalizeComputerPath } from './computer-path'

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
