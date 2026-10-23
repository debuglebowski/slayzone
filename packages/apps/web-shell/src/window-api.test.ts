/**
 * @vitest-environment jsdom
 *
 * web-shell's `window.api` implementation.
 *
 * SCOPE: three things worth a real regression test —
 *   1. `setupWindowApi()`'s per-namespace Proxy throws a NAMED error for a
 *      method outside the typed `ElectronAPI` contract (the whole reason for
 *      not reusing the fork's silent-stub pattern).
 *   2. That Proxy must NOT extend to the top-level object: `window.api?.browser`
 *      is an intentional feature-detect in shared renderer-app code
 *      (browser-mojo-link.ts, embedded-tab-host.ts) expecting `undefined`,
 *      never a thrown exception, for a namespace this shell never implements.
 *   3. `hubLogin` keeps no token (T-13): the hub's HttpOnly cookie is the session,
 *      so `getHubTokens` stays empty and nothing reaches storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupWindowApi } from './window-api'

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setupWindowApi', () => {
  it('a real ElectronAPI method works', async () => {
    const api = setupWindowApi()
    const result = await api.app.getBootConfig()
    expect(result).toEqual({ multiHub: false })
  })

  it('an unknown method on app throws a NAMED error, not undefined-is-not-a-function', () => {
    const api = setupWindowApi()
    expect(() => (api.app as unknown as { notAMethod: () => void }).notAMethod()).toThrow(
      /window\.api\.app\.notAMethod/
    )
  })

  it('an unknown method on files throws a NAMED error', () => {
    const api = setupWindowApi()
    expect(() => (api.files as unknown as { notAMethod: () => void }).notAMethod()).toThrow(
      /window\.api\.files\.notAMethod/
    )
  })

  it('window.api.browser is undefined, NOT a throw — the shared feature-detect must still work', () => {
    const api = setupWindowApi()
    // Mirrors browser-mojo-link.ts's `api?.browser ?? null` exactly.
    expect((api as unknown as { browser?: unknown }).browser).toBeUndefined()
    expect(() => (api as unknown as { browser?: unknown }).browser).not.toThrow()
  })

  it('hubLogin keeps no token: the session is the HttpOnly cookie, getHubTokens stays empty (T-13)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const api = setupWindowApi()
    const result = await api.app.hubLogin({
      hubId: 'local',
      url: '',
      email: 'a@b.com',
      password: 'pw'
    })
    expect(result).toEqual({ ok: true })
    expect(await api.app.getHubTokens()).toEqual({})
    expect(window.localStorage.length).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/web-login',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    )
  })

  it('hubLogin surfaces a server-reported error and stores nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: 'invalid email or password' })
      }))
    )
    const api = setupWindowApi()
    const result = await api.app.hubLogin({
      hubId: 'local',
      url: '',
      email: 'a@b.com',
      password: 'wrong'
    })
    expect(result).toEqual({ ok: false, error: 'invalid email or password' })
    expect(await api.app.getHubTokens()).toEqual({})
  })
})
