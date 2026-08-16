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
 *   3. `hubLogin` → `getHubTokens` round-trip: a successful sign-in must make
 *      the token immediately readable back, keyed by `getHubRegistry()`'s
 *      `defaultHubId` — that's the exact lookup `main.tsx`'s boot sequence
 *      performs before deciding whether to render the login screen.
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

  it("hubLogin stores the token; getHubTokens reads it back under getHubRegistry()'s defaultHubId", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, token: 'szw_test-token' })
      }))
    )
    const api = setupWindowApi()
    expect(await api.app.getHubTokens()).toEqual({})

    const result = await api.app.hubLogin({
      hubId: 'local',
      url: '',
      email: 'a@b.com',
      password: 'pw'
    })
    expect(result).toEqual({ ok: true })

    const registry = await api.app.getHubRegistry()
    const tokens = await api.app.getHubTokens()
    expect(tokens[registry.defaultHubId]).toBe('szw_test-token')
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
