import { describe, expect, it } from 'vitest'
import { isInsideRoots, pickerStartDir } from './dir-picker'

describe('isInsideRoots', () => {
  it('accepts a root and what is below it, nothing that only shares a prefix', () => {
    const roots = ['/Users/me', '/Volumes/data']
    expect(isInsideRoots('/Users/me', roots, '/')).toBe(true)
    expect(isInsideRoots('/Users/me/code/app', roots, '/')).toBe(true)
    expect(isInsideRoots('/Users/meow', roots, '/')).toBe(false)
    expect(isInsideRoots('/etc', roots, '/')).toBe(false)
  })

  it("uses the target machine's separator", () => {
    expect(isInsideRoots('C:\\Users\\me\\code', ['C:\\Users\\me'], '\\')).toBe(true)
    expect(isInsideRoots('C:/Users/me/code', ['C:\\Users\\me'], '\\')).toBe(false)
  })
})

describe('pickerStartDir', () => {
  const roots = ['/Users/me', '/Volumes/data']

  it("opens at the caller's folder when the computer allows it", () => {
    expect(
      pickerStartDir({ roots, sep: '/', home: '/Users/me', defaultPath: '/Volumes/data/app' })
    ).toBe('/Volumes/data/app')
  })

  it("falls back to home, then the first root, for a folder outside the roots (another machine's)", () => {
    expect(pickerStartDir({ roots, sep: '/', home: '/Users/me', defaultPath: '/srv/app' })).toBe(
      '/Users/me'
    )
    expect(pickerStartDir({ roots, sep: '/', home: '/root', defaultPath: null })).toBe('/Users/me')
    expect(pickerStartDir({ roots: ['/Volumes/data'], sep: '/', home: null })).toBe('/Volumes/data')
  })

  it('has nowhere to open on a computer that allows no folder', () => {
    expect(
      pickerStartDir({ roots: [], sep: '/', home: '/Users/me', defaultPath: '/Users/me' })
    ).toBe(null)
  })
})
