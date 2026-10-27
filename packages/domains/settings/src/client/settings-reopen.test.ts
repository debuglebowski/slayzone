// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { clearSettingsReopen, peekSettingsReopen, requestSettingsReopen } from './settings-reopen'

describe('settings reopen after reload', () => {
  beforeEach(() => sessionStorage.clear())

  it('returns the requested tab on every read until it is cleared', () => {
    requestSettingsReopen('connections')
    expect(peekSettingsReopen()).toBe('connections')
    expect(peekSettingsReopen()).toBe('connections')
    clearSettingsReopen()
    expect(peekSettingsReopen()).toBeNull()
  })

  it('returns null when nothing was requested', () => {
    expect(peekSettingsReopen()).toBeNull()
  })
})
