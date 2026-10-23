/**
 * @vitest-environment jsdom
 *
 * `fetchHubSignIn` — the pre-boot probe that lets `main.tsx` decide whether to show
 * `LoginScreen`, and with which methods, before it has any credential at all. Its one
 * hard requirement: FAIL CLOSED. A network hiccup, a non-200, a malformed body, or an
 * explicit `authRequired: true` must all resolve `authRequired: true` — only an
 * explicit `authRequired: false` may skip the login screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHubSignIn } from './hub-health'

afterEach(() => {
  vi.unstubAllGlobals()
})

const health = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body }))
  )

const NONE = { password: false, sso: false }

describe('fetchHubSignIn', () => {
  it('authRequired is false only on an explicit authRequired:false', async () => {
    health({ authRequired: false, switches: { requireLogin: false, enablePassword: true } })
    expect((await fetchHubSignIn()).authRequired).toBe(false)
    health({ authRequired: true })
    expect((await fetchHubSignIn()).authRequired).toBe(true)
  })

  it('an Entra hub with password off: Microsoft only, no password form (T-13)', async () => {
    health({
      authRequired: true,
      switches: { requireLogin: true, enablePassword: false, enableSso: true }
    })
    expect(await fetchHubSignIn()).toEqual({
      authRequired: true,
      methods: { password: false, sso: true }
    })
  })

  it('a password hub: the password form only', async () => {
    health({
      authRequired: true,
      switches: { requireLogin: true, enablePassword: true, enableSso: false }
    })
    expect((await fetchHubSignIn()).methods).toEqual({ password: true, sso: false })
  })

  it('SSO counts only where login is required (the hub only serves it there)', async () => {
    health({
      authRequired: false,
      switches: { requireLogin: false, enablePassword: true, enableSso: true }
    })
    expect((await fetchHubSignIn()).methods.sso).toBe(false)
  })

  it('FAILS CLOSED: a non-ok response requires sign-in and offers nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    )
    expect(await fetchHubSignIn()).toEqual({ authRequired: true, methods: NONE })
  })

  it('FAILS CLOSED: a rejected fetch (network error) requires sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network error')
      })
    )
    expect(await fetchHubSignIn()).toEqual({ authRequired: true, methods: NONE })
  })

  it('FAILS CLOSED: a malformed body (missing authRequired key) requires sign-in', async () => {
    health({})
    expect((await fetchHubSignIn()).authRequired).toBe(true)
  })

  it('FAILS CLOSED: json() itself throwing requires sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error('invalid json')
        }
      }))
    )
    expect(await fetchHubSignIn()).toEqual({ authRequired: true, methods: NONE })
  })
})
