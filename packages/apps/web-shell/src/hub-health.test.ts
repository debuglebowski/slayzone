/**
 * @vitest-environment jsdom
 *
 * `fetchAuthRequired` — the pre-boot probe that lets `main.tsx` decide
 * whether to show `LoginScreen` before it has any credential at all. Its one
 * hard requirement: FAIL CLOSED. A network hiccup, a non-200, a malformed
 * body, or an explicit `authRequired: true` must all resolve `true` — only
 * an explicit `authRequired: false` may skip the login screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthRequired } from './hub-health'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchAuthRequired', () => {
  it('resolves false only on an explicit authRequired:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ authRequired: false }) }))
    )
    expect(await fetchAuthRequired()).toBe(false)
  })

  it('resolves true on an explicit authRequired:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ authRequired: true }) }))
    )
    expect(await fetchAuthRequired()).toBe(true)
  })

  it('FAILS CLOSED: a non-ok response resolves true, never false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    )
    expect(await fetchAuthRequired()).toBe(true)
  })

  it('FAILS CLOSED: a rejected fetch (network error) resolves true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network error')
      })
    )
    expect(await fetchAuthRequired()).toBe(true)
  })

  it('FAILS CLOSED: a malformed body (missing authRequired key) resolves true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    )
    expect(await fetchAuthRequired()).toBe(true)
  })

  it('FAILS CLOSED: json() itself throwing resolves true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error('invalid json')
        }
      }))
    )
    expect(await fetchAuthRequired()).toBe(true)
  })
})
