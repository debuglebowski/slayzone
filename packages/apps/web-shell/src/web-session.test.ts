/**
 * @vitest-environment jsdom
 *
 * The shell's view of its session (T-13): it cannot read the HttpOnly cookie, so it
 * asks the hub. Both calls are same-origin POSTs (the browser then always sends
 * `Origin`, which the hub requires of a cookie request) and fail to "signed out".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSignedIn, signOut } from './web-session'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSignedIn', () => {
  it('POSTs the status route with the cookie; true only on signedIn:true', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, signedIn: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchSignedIn()).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/web-session', {
      method: 'POST',
      credentials: 'same-origin'
    })
  })

  it('false on signedIn:false, a refusal, a network error or junk', async () => {
    for (const impl of [
      async () => ({ ok: true, json: async () => ({ ok: true, signedIn: false }) }),
      async () => ({ ok: false, status: 403, json: async () => ({ ok: false }) }),
      async () => {
        throw new Error('network')
      },
      async () => ({ ok: true, json: async () => ({ signedIn: 'yes' }) })
    ]) {
      vi.stubGlobal('fetch', vi.fn(impl))
      expect(await fetchSignedIn()).toBe(false)
    }
  })
})

describe('signOut', () => {
  it('POSTs the sign-out route with the cookie; true when the hub did it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await signOut()).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/web-logout', {
      method: 'POST',
      credentials: 'same-origin'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    )
    expect(await signOut()).toBe(false)
  })
})
