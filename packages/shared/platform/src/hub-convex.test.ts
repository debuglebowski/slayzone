/**
 * The hub's own Convex deployment (T-99): parsing `SLAYZONE_HUB_CONVEX_ADDRESS`, the
 * desktop app's URL → address hand-over, and `assertHubConvexSignInUrl` — the one gate
 * between a client-sent `convexUrl` and the hub's outbound POST.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/hub-convex.test.ts
 */
import { convexAddressFromUrl, convexOriginOf, hubConvexOrigin } from './hub-convex'
import {
  HubSwitchedOffError,
  assertHubConvexSignInUrl,
  isHubSwitchedOffError
} from './hub-switch-refusal'
import { HUB_CONVEX_ADDRESS_ENV, HUB_PROCESS_ENV } from './hub-switches'
import { ENV_MANIFEST } from './env-manifest'
import { setSecurityLogSink } from './security-log'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}
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
check('env name', HUB_CONVEX_ADDRESS_ENV === ENV)
check('a parent spawning a hub clears it', HUB_PROCESS_ENV.includes(ENV))
check('infra: never inherited by a terminal', ENV_MANIFEST[ENV] === 'infra')

// --- hubConvexOrigin: address → origin under the scheme rule ---
check('unset → null', hubConvexOrigin(env()) === null)
check('blank → null', hubConvexOrigin(env('  ')) === null)
check(
  'cloud host → https',
  hubConvexOrigin(env('happy-animal-123.convex.cloud')) === 'https://happy-animal-123.convex.cloud'
)
check('trimmed', hubConvexOrigin(env(' x.convex.cloud ')) === 'https://x.convex.cloud')
check('loopback → http', hubConvexOrigin(env('127.0.0.1:3210')) === 'http://127.0.0.1:3210')
check('localhost → http', hubConvexOrigin(env('localhost:3210')) === 'http://localhost:3210')
check('[::1] → http', hubConvexOrigin(env('[::1]:3210')) === 'http://[::1]:3210')
check('explicit port kept', hubConvexOrigin(env('convex.corp:8443')) === 'https://convex.corp:8443')
check('a full URL is refused, not guessed', hubConvexOrigin(env('https://x.convex.cloud')) === null)
check('a path is refused', hubConvexOrigin(env('x.convex.cloud/api')) === null)
check('userinfo is refused', hubConvexOrigin(env('a@x.convex.cloud')) === null)

// --- convexOriginOf: what a client sent ---
check('client https', convexOriginOf('https://x.convex.cloud/') === 'https://x.convex.cloud')
check(
  'client path dropped',
  convexOriginOf('https://x.convex.cloud/a?b#c') === 'https://x.convex.cloud'
)
check('client non-http scheme', convexOriginOf('file:///etc/passwd') === null)
check('client garbage', convexOriginOf('not a url') === null)
check('client non-string', convexOriginOf({ href: 'https://x' }) === null)

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
  check(
    `desktop round trip: ${JSON.stringify(url)} → ${addr} → same origin the renderer sends`,
    addr !== undefined && hubConvexOrigin(env(addr)) === convexOriginOf(url)
  )
}
check('desktop: unset → none', convexAddressFromUrl(undefined) === undefined)
check('desktop: blank → none', convexAddressFromUrl('') === undefined)
check('desktop: not a URL → none', convexAddressFromUrl('x.convex.cloud') === undefined)
check(
  'desktop: plain http to a non-loopback host does not round-trip → none',
  convexAddressFromUrl('http://convex.lan:3210') === undefined
)

// --- assertHubConvexSignInUrl ---
const lines: Array<Record<string, unknown> & { detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))
const refusal = { op: 'sign_in', detail: { provider: 'github' } }
const own = env('happy-animal-123.convex.cloud')

{
  const r = assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud', refusal, own)
  check(
    'same deployment: returns the hub’s own origin',
    r === 'https://happy-animal-123.convex.cloud'
  )
  check('same deployment: no audit line', lines.length === 0)
  check(
    'same deployment, trailing slash: accepted',
    assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud/', refusal, own) ===
      'https://happy-animal-123.convex.cloud'
  )
}

for (const [label, clientUrl] of [
  ['another host', 'https://evil.example.com'],
  ['an internal address', 'http://169.254.169.254'],
  ['loopback', 'http://127.0.0.1:3100'],
  ['same host, http', 'http://happy-animal-123.convex.cloud'],
  ['same host, other port', 'https://happy-animal-123.convex.cloud:8443'],
  ['no URL', undefined],
  ['not a string', 42]
] as const) {
  const before = lines.length
  const err = caught(() => assertHubConvexSignInUrl(clientUrl, refusal, own))
  check(
    `mismatch (${label}): HUB_CONVEX_MISMATCH`,
    err instanceof HubSwitchedOffError &&
      err.code === 'HUB_CONVEX_MISMATCH' &&
      isHubSwitchedOffError(err)
  )
  check(`mismatch (${label}): names the variable`, (err as Error).message.includes(ENV))
  check(`mismatch (${label}): exactly one audit line`, lines.length === before + 1)
  const line = lines[before]
  check(
    `mismatch (${label}): integration.connect denied, op + provider + code`,
    line?.event === 'integration.connect' &&
      line.outcome === 'denied' &&
      line.detail.op === 'sign_in' &&
      line.detail.provider === 'github' &&
      line.detail.code === 'HUB_CONVEX_MISMATCH' &&
      line.detail.variable === ENV
  )
  check(
    `mismatch (${label}): the requested origin is recorded`,
    line?.detail.requestedOrigin === convexOriginOf(clientUrl),
    JSON.stringify(line?.detail)
  )
}

for (const [label, hubEnv] of [
  ['unset', env()],
  ['malformed', env('https://happy-animal-123.convex.cloud')]
] as const) {
  const before = lines.length
  const err = caught(() =>
    assertHubConvexSignInUrl('https://happy-animal-123.convex.cloud', refusal, hubEnv)
  )
  check(
    `no deployment (${label}): HUB_CONVEX_NOT_CONFIGURED`,
    err instanceof HubSwitchedOffError &&
      err.code === 'HUB_CONVEX_NOT_CONFIGURED' &&
      err.variable === ENV
  )
  check(`no deployment (${label}): exactly one audit line`, lines.length === before + 1)
  check(
    `no deployment (${label}): integration.connect denied`,
    lines[before]?.event === 'integration.connect' &&
      lines[before]?.outcome === 'denied' &&
      lines[before]?.detail.code === 'HUB_CONVEX_NOT_CONFIGURED'
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
