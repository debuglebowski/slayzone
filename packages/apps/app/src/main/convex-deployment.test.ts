/**
 * The desktop app's one Convex deployment (renderer + its hub): the build's
 * `VITE_CONVEX_URL`, unless an e2e run names another. See convex-deployment.ts.
 */
import { describe, expect, it } from 'vitest'
import { E2E_CONVEX_ADDRESS_ENV, resolveAppConvexUrl } from './convex-deployment'

const BUILD = 'https://happy-otter-123.convex.cloud'

describe('resolveAppConvexUrl', () => {
  it("is the build's URL, verbatim but trimmed, outside e2e", () => {
    expect(resolveAppConvexUrl(` ${BUILD}/ `, {}, false)).toBe(`${BUILD}/`)
    expect(resolveAppConvexUrl('', {}, false)).toBe('')
  })

  it('ignores the e2e override outside Playwright', () => {
    expect(resolveAppConvexUrl(BUILD, { [E2E_CONVEX_ADDRESS_ENV]: 'example.invalid' }, false)).toBe(
      BUILD
    )
  })

  it("is the build's URL under Playwright when no override is set", () => {
    expect(resolveAppConvexUrl(BUILD, {}, true)).toBe(BUILD)
    expect(resolveAppConvexUrl('', {}, true)).toBe('')
  })

  it('under Playwright, an override address replaces the build value (scheme by host)', () => {
    const env = (addr: string) => ({ [E2E_CONVEX_ADDRESS_ENV]: addr })
    // A build without Convex (a worktree with no .env) still gets one.
    expect(resolveAppConvexUrl('', env('example.invalid'), true)).toBe('https://example.invalid')
    expect(resolveAppConvexUrl(BUILD, env(' example.invalid:8443 '), true)).toBe(
      'https://example.invalid:8443'
    )
    // Loopback → http: a local `npx convex dev` backend or a spec's fake.
    expect(resolveAppConvexUrl(BUILD, env('127.0.0.1:3210'), true)).toBe('http://127.0.0.1:3210')
  })

  it('under Playwright, an empty override turns Convex off', () => {
    expect(resolveAppConvexUrl(BUILD, { [E2E_CONVEX_ADDRESS_ENV]: ' ' }, true)).toBe('')
  })

  it('throws on an override that is not a bare host[:port] — never silently the build value', () => {
    for (const bad of ['https://example.invalid', 'example.invalid/path', 'user@host'])
      expect(() => resolveAppConvexUrl(BUILD, { [E2E_CONVEX_ADDRESS_ENV]: bad }, true)).toThrow(
        E2E_CONVEX_ADDRESS_ENV
      )
  })
})
