/**
 * @vitest-environment jsdom
 *
 * T-13: the web shell keeps its session in the hub's HttpOnly cookie ONLY. The storage
 * module is left with one job — deleting the token an earlier version kept in
 * `localStorage` — and a sign-in writes nothing to any storage a script can read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLegacySessionToken } from './web-session-storage'
import * as storage from './web-session-storage'
import { setupWindowApi } from './window-api'

const LEGACY_KEY = 'slayzone-web-session-token'

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('web-session-storage', () => {
  it("deletes an earlier version's localStorage token, and only that", () => {
    window.localStorage.setItem(LEGACY_KEY, 'szw_old-token')
    window.localStorage.setItem('unrelated', 'kept')
    clearLegacySessionToken()
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(window.localStorage.getItem('unrelated')).toBe('kept')
  })

  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => clearLegacySessionToken()).not.toThrow()
  })

  it('exports no way to store or read a token any more', () => {
    expect(Object.keys(storage)).toEqual(['clearLegacySessionToken'])
  })

  it('a password sign-in writes nothing to localStorage or sessionStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    )
    const api = setupWindowApi()
    const result = await api.app.hubLogin({
      hubId: 'local',
      url: '',
      email: 'a@b.com',
      password: 'pw'
    })
    expect(result).toEqual({ ok: true })
    expect(setItem).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })
})
