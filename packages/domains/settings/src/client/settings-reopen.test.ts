// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { consumeSettingsReopen, requestSettingsReopen } from './settings-reopen'

describe('settings reopen after reload', () => {
  beforeEach(() => sessionStorage.clear())

  it('returns the requested tab exactly once', () => {
    requestSettingsReopen('connections')
    expect(consumeSettingsReopen()).toBe('connections')
    expect(consumeSettingsReopen()).toBeNull()
  })

  it('returns null when nothing was requested', () => {
    expect(consumeSettingsReopen()).toBeNull()
  })
})
