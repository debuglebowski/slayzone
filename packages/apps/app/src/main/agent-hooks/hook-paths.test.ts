import { describe, expect, test } from 'vitest'
import { formatHookCommand, toPosixPath } from './hook-paths'

describe('toPosixPath', () => {
  test('converts Windows backslashes to forward slashes', () => {
    expect(toPosixPath('C:\\Users\\Jane\\.slayzone\\hooks\\notify.sh')).toBe(
      'C:/Users/Jane/.slayzone/hooks/notify.sh'
    )
  })

  test('leaves a POSIX path untouched', () => {
    expect(toPosixPath('/home/x/.slayzone/hooks/notify.sh')).toBe(
      '/home/x/.slayzone/hooks/notify.sh'
    )
  })
})

describe('formatHookCommand', () => {
  test('clean POSIX path is returned bare — no quoting, no settings.json churn', () => {
    expect(formatHookCommand('/Users/kalle/.slayzone/hooks/notify.sh')).toBe(
      '/Users/kalle/.slayzone/hooks/notify.sh'
    )
  })

  test('Windows path → forward-slashed, bare when it has no spaces (fixes issue #88)', () => {
    expect(formatHookCommand('C:\\Users\\kalle\\.slayzone\\hooks\\notify.sh')).toBe(
      'C:/Users/kalle/.slayzone/hooks/notify.sh'
    )
  })

  test('Windows path with a space → forward-slashed and single-quoted', () => {
    expect(formatHookCommand('C:\\Users\\Jane Doe\\.slayzone\\hooks\\notify.sh')).toBe(
      `'C:/Users/Jane Doe/.slayzone/hooks/notify.sh'`
    )
  })

  test('POSIX path with a space → single-quoted', () => {
    expect(formatHookCommand('/Users/Jane Doe/.slayzone/hooks/notify.sh')).toBe(
      `'/Users/Jane Doe/.slayzone/hooks/notify.sh'`
    )
  })

  test('escapes an embedded single quote', () => {
    expect(formatHookCommand("/Users/o'brien/hooks/notify.sh")).toBe(
      `'/Users/o'"'"'brien/hooks/notify.sh'`
    )
  })
})
