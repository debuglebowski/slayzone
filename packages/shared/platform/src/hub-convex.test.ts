/**
 * The hub's own Convex deployment (T-99): parsing `SLAYZONE_HUB_CONVEX_ADDRESS`, the
 * desktop app's URL → address hand-over, and `assertHubConvexSignInUrl` — the one gate
 * between a client-sent `convexUrl` and the hub's outbound POST.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/hub-convex.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { convexAddressFromUrl, convexOriginOf, hubConvexOrigin } from './hub-convex'
import {
  HubSwitchedOffError,
  assertHubConvexSignInUrl,
  isHubSwitchedOffError
} from './hub-switch-refusal'
import { HUB_CONVEX_ADDRESS_ENV, HUB_PROCESS_ENV } from './hub-switches'
import { ENV_MANIFEST } from './env-manifest'
import { setSecurityLogSink } from './security-log'

function caught(fn: () => unknown): unknown {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

const ENV = 'SLAYZONE_HUB_CONVEX_ADDRESS'
const env = (addr?: string): NodeJS.ProcessEnv => (addr === undefined ? {} : { [ENV]: addr })

// --- the variable ---
test('env name', () => {
  expect(HUB_CONVEX_ADDRESS_ENV).toBe(ENV)
})

test('a parent spawning a hub clears it', () => {
  expect(HUB_PROCESS_ENV).toContain(ENV)
})

test('infra: never inherited by a terminal', () => {
  expect(ENV_MANIFEST[ENV]).toBe('infra')
})

// --- hubConvexOrigin: address → origin under the scheme rule ---
test('unset → null', () => {
  expect(hubConvexOrigin(env())).toBeNull()
})

test('blank → null', () => {
  expect(hubConvexOrigin(env('  '))).toBeNull()
})

test('cloud host → https', () => {
  expect(hubConvexOrigin(env('happy-animal-123.convex.cloud'))).toBe(
    'https://happy-animal-123.convex.cloud'
  )
})

test('trimmed', () => {
  expect(hubConvexOrigin(env(' x.convex.cloud '))).toBe('https://x.convex.cloud')
})

test('loopback → http', () => {
  expect(hubConvexOrigin(env('127.0.0.1:3210'))).toBe('http://127.0.0.1:3210')
})

test('localhost → http', () => {
  expect(hubConvexOrigin(env('localhost:3210'))).toBe('http://localhost:3210')
})

test('[::1] → http', () => {
  expect(hubConvexOrigin(env('[::1]:3210'))).toBe('http://[::1]:3210')
})

test('explicit port kept', () => {
  expect(hubConvexOrigin(env('convex.corp:8443'))).toBe('https://convex.corp:8443')
})

test('a full URL is refused, not guessed', () => {
  expect(hubConvexOrigin(env('https://x.convex.cloud'))).toBeNull()
})

test('a path is refused', () => {
  expect(hubConvexOrigin(env('x.convex.cloud/api'))).toBeNull()
})

test('userinfo is refused', () => {
  expect(hubConvexOrigin(env('a@x.convex.cloud'))).toBeNull()
})

// --- convexOriginOf: what a client sent ---
test('client https', () => {
  expect(convexOriginOf('https://x.convex.cloud/')).toBe('https://x.convex.cloud')
})

test('client path dropped', () => {
  expect(convexOriginOf('https://x.convex.cloud/a?b#c')).toBe('https://x.convex.cloud')
})

test('client non-http scheme', () => {
  expect(convexOriginOf('file:///etc/passwd')).toBeNull()
})

test('client garbage', () => {
  expect(convexOriginOf('not a url')).toBeNull()
})

test('client non-string', () => {
  expect(convexOriginOf({ href: 'https://x' })).toBeNull()
})

// --- convexAddressFromUrl: the desktop app's VITE_CONVEX_URL → the hub's address ---
for (const url of [
  'https://happy-animal-123.convex.cloud',
  'https://happy-animal-123.convex.cloud/',
  ' https://happy-animal-123.convex.cloud ',
  'http://127.0.0.1:3210',
  'http://localhost:3210/',
  'https://example.invalid'
]) {
  const addr = convexAddressFromUrl(url)
  test(`desktop round trip: ${JSON.stringify(url)} → ${addr} → same origin the renderer sends`, () => {
    expect(addr).not.toBeUndefined()
    expect(hubConvexOrigin(env(addr))).toBe(convexOriginOf(url))
  })
}
test('desktop: unset → none', () => {
  expect(convexAddressFromUrl(undefined)).toBeUndefined()
})

test('desktop: blank → none', () => {
  expect(convexAddressFromUrl('')).toBeUndefined()
})

test('desktop: not a URL → none', () => {
  expect(convexAddressFromUrl('x.convex.cloud')).toBeUndefined()
})

test('desktop: plain http to a non-loopback host does not round-trip → none', () => {
  expect(convexAddressFromUrl('http://convex.lan:3210')).toBeUndefined()
})

// --- assertHubConvexSignInUrl ---
// Each scenario makes its call in a beforeAll and records what it saw, so the audit-line
// counts are read at the moment the old inline checks read them, not after later calls.
describe('assertHubConvexSignInUrl', () => {
  const lines: Array<Record<string, unknown> & { detail: Record<string, unknown> }> = []
  beforeAll(() => setSecurityLogSink((line) => lines.push(JSON.parse(line))))
  afterAll(() => setSecurityLogSink())
  const refusal = { op: 'sign_in', detail: { provider: 'github' } }
  const own = env('happy-animal-123.convex.cloud')

  describe('same deployment', () => {
    let r: string | undefined
    let linesAfter = -1
    beforeAll(() => {
      r = assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud', refusal, own)
      linesAfter = lines.length
    })

    test('same deployment: returns the hub’s own origin', () => {
      expect(r).toBe('https://happy-animal-123.convex.cloud')
    })

    test('same deployment: no audit line', () => {
      expect(linesAfter).toBe(0)
    })

    test('same deployment, trailing slash: accepted', () => {
      expect(assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud/', refusal, own)).toBe(
        'https://happy-animal-123.convex.cloud'
      )
    })
  })

  for (const [label, clientUrl] of [
    ['another host', 'https://evil.example.com'],
    ['an internal address', 'http://169.254.169.254'],
    ['loopback', 'http://127.0.0.1:3100'],
    ['same host, http', 'http://happy-animal-123.convex.cloud'],
    ['same host, other port', 'https://happy-animal-123.convex.cloud:8443'],
    ['no URL', undefined],
    ['not a string', 42]
  ] as const) {
    describe(`mismatch (${label})`, () => {
      let before = -1
      let after = -1
      let err: unknown
      let line: (typeof lines)[number] | undefined
      beforeAll(() => {
        before = lines.length
        err = caught(() => assertHubConvexSignInUrl(clientUrl, refusal, own))
        after = lines.length
        line = lines[before]
      })

      test(`mismatch (${label}): HUB_CONVEX_MISMATCH`, () => {
        expect(err).toBeInstanceOf(HubSwitchedOffError)
        expect(err).toMatchObject({ code: 'HUB_CONVEX_MISMATCH' })
        expect(isHubSwitchedOffError(err)).toBe(true)
      })

      test(`mismatch (${label}): names the variable`, () => {
        expect((err as Error).message).toContain(ENV)
      })

      test(`mismatch (${label}): exactly one audit line`, () => {
        expect(after).toBe(before + 1)
      })

      test(`mismatch (${label}): integration.connect denied, op + provider + code`, () => {
        expect(line).toMatchObject({
          event: 'integration.connect',
          outcome: 'denied',
          detail: {
            op: 'sign_in',
            provider: 'github',
            code: 'HUB_CONVEX_MISMATCH',
            variable: ENV
          }
        })
      })

      test(`mismatch (${label}): the requested origin is recorded`, () => {
        expect(line?.detail.requestedOrigin, JSON.stringify(line?.detail)).toBe(
          convexOriginOf(clientUrl)
        )
      })
    })
  }

  for (const [label, hubEnv] of [
    ['unset', env()],
    ['malformed', env('https://happy-animal-123.convex.cloud')]
  ] as const) {
    describe(`no deployment (${label})`, () => {
      let before = -1
      let after = -1
      let err: unknown
      beforeAll(() => {
        before = lines.length
        err = caught(() =>
          assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud', refusal, hubEnv)
        )
        after = lines.length
      })

      test(`no deployment (${label}): HUB_CONVEX_NOT_CONFIGURED`, () => {
        expect(err).toBeInstanceOf(HubSwitchedOffError)
        expect(err).toMatchObject({ code: 'HUB_CONVEX_NOT_CONFIGURED', variable: ENV })
      })

      test(`no deployment (${label}): exactly one audit line`, () => {
        expect(after).toBe(before + 1)
      })

      test(`no deployment (${label}): integration.connect denied`, () => {
        expect(lines[before]).toMatchObject({
          event: 'integration.connect',
          outcome: 'denied',
          detail: { code: 'HUB_CONVEX_NOT_CONFIGURED' }
        })
      })
    })
  }

  // SLAYZONE_HUB_ENABLE_TELEMETRY=0 wins over a Convex address left set: the hub's one
  // Convex call (the sign-in start) never happens, even for its own deployment.
  describe('telemetry off', () => {
    let before = -1
    let after = -1
    let err: unknown
    beforeAll(() => {
      before = lines.length
      err = caught(() =>
        assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud', refusal, {
          ...own,
          SLAYZONE_HUB_ENABLE_TELEMETRY: '0'
        })
      )
      after = lines.length
    })

    test('telemetry off: HUB_TELEMETRY_DISABLED, naming the switch', () => {
      expect(err).toBeInstanceOf(HubSwitchedOffError)
      expect(err).toMatchObject({
        code: 'HUB_TELEMETRY_DISABLED',
        variable: 'SLAYZONE_HUB_ENABLE_TELEMETRY'
      })
      expect((err as Error).message).toContain('SLAYZONE_HUB_ENABLE_TELEMETRY=0')
    })

    test('telemetry off: exactly one audit line', () => {
      expect(after).toBe(before + 1)
      expect(lines[before]).toMatchObject({
        event: 'integration.connect',
        outcome: 'denied',
        detail: { code: 'HUB_TELEMETRY_DISABLED' }
      })
    })

    test('telemetry on (explicit 1): the own deployment still signs in', () => {
      expect(
        assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud', refusal, {
          ...own,
          SLAYZONE_HUB_ENABLE_TELEMETRY: '1'
        })
      ).toBe('https://happy-animal-123.convex.cloud')
    })
  })
})
