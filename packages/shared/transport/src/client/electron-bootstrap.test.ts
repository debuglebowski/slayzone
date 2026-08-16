/**
 * @vitest-environment jsdom
 *
 * `electronBootstrap`'s degrade-not-throw guarantee.
 *
 * SCOPE: every method here is typed as REQUIRED on `ElectronAPI`, but that
 * type is never runtime-enforced across the `window.api` boundary — a host
 * can genuinely implement less than it claims (the fork's `window-api-shim`
 * already does for several namespaces). Before this widening, every method
 * but `dataReady`/`bootMark` was a bare call: a host missing one threw an
 * uncaught `TypeError` that could abort the very first data load.
 * `Terminal.tsx`'s bare `getPastePaths()` call is the exact real case this
 * was found from — it throws on the fork today. This file does not attempt
 * a full 17-method audit; it exercises one method per RETURN SHAPE
 * `electronBootstrap` fans out to (bare array, `{ok, error}`, empty object,
 * `null`, plain boolean, void) so a shape-level regression is caught.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { electronBootstrap } from './electron-bootstrap'

afterEach(() => {
  // @ts-expect-error test-only teardown of the global the module reads
  delete window.api
})

describe('electronBootstrap degrades when window.api is missing a method', () => {
  it('getPastePaths() → [] instead of throwing (the exact Terminal.tsx regression)', () => {
    // @ts-expect-error deliberately partial host — `files` exists, the method does not
    window.api = { app: {}, files: {} }
    expect(electronBootstrap.getPastePaths()).toEqual([])
  })

  it('getDropPaths() → [] instead of throwing', () => {
    // @ts-expect-error deliberately partial host
    window.api = { app: {}, files: {} }
    expect(electronBootstrap.getDropPaths()).toEqual([])
  })

  it('hubLogin() → a real {ok:false, error} instead of throwing', async () => {
    // @ts-expect-error deliberately partial host
    window.api = { app: {}, files: {} }
    const result = await electronBootstrap.hubLogin({
      hubId: 'x',
      url: '',
      email: 'a@b.com',
      password: 'pw'
    })
    expect(result.ok).toBe(false)
  })

  it('getHubTokens() → {} instead of throwing', async () => {
    // @ts-expect-error deliberately partial host
    window.api = { app: {}, files: {} }
    expect(await electronBootstrap.getHubTokens()).toEqual({})
  })

  it('getWindowId() → null instead of throwing', async () => {
    // @ts-expect-error deliberately partial host
    window.api = { app: {}, files: {} }
    expect(await electronBootstrap.getWindowId()).toBeNull()
  })

  it('isPlaywright() → false instead of throwing', () => {
    // @ts-expect-error deliberately partial host
    window.api = { app: {}, files: {} }
    expect(electronBootstrap.isPlaywright()).toBe(false)
  })

  it('relaunch() → resolves instead of throwing', async () => {
    // @ts-expect-error deliberately partial host
    window.api = { app: {}, files: {} }
    await expect(electronBootstrap.relaunch()).resolves.toBeUndefined()
  })

  it('a FULLY implemented host is unaffected — every call reaches the real method', async () => {
    window.api = {
      app: {
        getServerUrl: async () => ({ mode: 'local', url: 'ws://real' }),
        getBootConfig: async () => ({ multiHub: true }),
        getHubRegistry: async () => ({ hubs: [], defaultHubId: 'local' }),
        getHubTokens: async () => ({ local: 'tok' }),
        setHubToken: async () => ({ ok: true }),
        hubLogin: async () => ({ ok: true }),
        getWindowId: async () => 7,
        setBootSettings: async () => ({ ok: true }),
        probeServerHealth: async () => ({ ok: true }),
        relaunch: async () => {},
        restartSidecar: async () => ({ ok: true }),
        restartLocalComputer: async () => ({ ok: true }),
        isPlaywright: true,
        dataReady: () => {},
        bootMark: () => {}
      },
      files: {
        getDropPaths: () => ['/a'],
        getPastePaths: () => ['/b']
      }
      // biome-ignore lint/suspicious/noExplicitAny: test-only full-host fixture
    } as any
    expect(await electronBootstrap.getServerUrl()).toEqual({ mode: 'local', url: 'ws://real' })
    expect(electronBootstrap.getPastePaths()).toEqual(['/b'])
    expect(electronBootstrap.isPlaywright()).toBe(true)
  })
})
