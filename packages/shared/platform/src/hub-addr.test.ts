/**
 * hubUrlFromAddr — compose a full hub URL from an authority-only
 * `SLAYZONE_HUB_ADDRESS` (`host[:port]`, no scheme, no path) + the scheme derived
 * from SLAYZONE_MODE. This is what makes the old ws-vs-http `SLAYZONE_HUB_URL`
 * collision unrepresentable: the env channel never carries a scheme, so a runner
 * (ws) and the CLI (http) reading the SAME var can never disagree.
 *
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/hub-addr.test.ts
 */
import { hubUrlFromAddr, isBareAuthority, parseHubAddress } from './hub-addr'

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

/** Compare a parse result against an expected {host, port} (port may be undefined). */
function deepEq(
  actual: { host: string; port: number | undefined } | null,
  expected: { host: string; port: number | undefined }
): boolean {
  return actual !== null && actual.host === expected.host && actual.port === expected.port
}

const prev = process.env.SLAYZONE_MODE
try {
  // --- local mode → plaintext schemes ---
  delete process.env.SLAYZONE_MODE
  check(
    'local: ws family → ws:// + path',
    hubUrlFromAddr('127.0.0.1:8788', 'ws', '/runners') === 'ws://127.0.0.1:8788/runners'
  )
  check(
    'local: http family → http:// (no path)',
    hubUrlFromAddr('127.0.0.1:51100', 'http') === 'http://127.0.0.1:51100'
  )
  check('local: default (unset MODE) is plaintext', hubUrlFromAddr('h:1', 'http') === 'http://h:1')

  process.env.SLAYZONE_MODE = 'garbage'
  check('unknown MODE falls back to local/plaintext', hubUrlFromAddr('h:1', 'ws') === 'ws://h:1')

  // --- remote mode → secure schemes ---
  process.env.SLAYZONE_MODE = 'remote'
  check(
    'remote: ws family → wss:// + path',
    hubUrlFromAddr('hub.example.com', 'ws', '/runners') === 'wss://hub.example.com/runners'
  )
  check(
    'remote: http family → https://',
    hubUrlFromAddr('hub.example.com', 'http') === 'https://hub.example.com'
  )
  process.env.SLAYZONE_MODE = 'REMOTE'
  check('remote is case-insensitive', hubUrlFromAddr('h', 'http') === 'https://h')

  // --- authority preserved verbatim (host + optional port) ---
  process.env.SLAYZONE_MODE = 'remote'
  check(
    'host-only authority (implicit 443)',
    hubUrlFromAddr('hub.example.com', 'ws', '/runners') === 'wss://hub.example.com/runners'
  )
  check('empty path default appends nothing', hubUrlFromAddr('h:2', 'http') === 'https://h:2')
} finally {
  if (prev === undefined) delete process.env.SLAYZONE_MODE
  else process.env.SLAYZONE_MODE = prev
}

// --- isBareAuthority: the env-channel guard (no scheme, no path) ---
check('authority: host:port', isBareAuthority('127.0.0.1:51100'))
check('authority: host only', isBareAuthority('hub.example.com'))
check('authority: bracketed ipv6 + port', isBareAuthority('[::1]:8080'))
check('authority: wildcard bind host', isBareAuthority('0.0.0.0:0'))
check('reject: carries a scheme', !isBareAuthority('http://hub.example.com'))
check('reject: carries a path', !isBareAuthority('hub.example.com/slayzone'))
check('reject: trailing slash', !isBareAuthority('hub.example.com/'))
check('reject: userinfo', !isBareAuthority('user@hub.example.com'))
check('reject: whitespace', !isBareAuthority('hub.example.com :80'))
check('reject: empty', !isBareAuthority(''))
check('reject: double scheme', !isBareAuthority('http://http://x'))

// --- parseHubAddress: the BIND side (host + optional port) ---
// PORT GRAMMAR: a bare host means "port unspecified" → the bind side lets the OS
// assign (port === undefined, callers default to 0); an explicit `:0` says the
// same thing outright. The dial side never parses — it hands the authority to
// hubUrlFromAddr verbatim so the scheme's default port stays implicit.
check('parse: host:port', deepEq(parseHubAddress('127.0.0.1:51100'), { host: '127.0.0.1', port: 51100 }))
check('parse: host only → port undefined', deepEq(parseHubAddress('127.0.0.1'), { host: '127.0.0.1', port: undefined }))
check('parse: explicit :0 → OS-assigned', deepEq(parseHubAddress('127.0.0.1:0'), { host: '127.0.0.1', port: 0 }))
check('parse: wildcard host', deepEq(parseHubAddress('0.0.0.0:8080'), { host: '0.0.0.0', port: 8080 }))
// IPv6 must come back UNBRACKETED — node's `server.listen(host)` wants the bare
// literal, while the URL authority form requires the brackets.
check('parse: bracketed ipv6 → unbracketed host', deepEq(parseHubAddress('[::1]:8080'), { host: '::1', port: 8080 }))
check('parse: bracketed ipv6, no port', deepEq(parseHubAddress('[::]'), { host: '::', port: undefined }))
check('parse: hostname', deepEq(parseHubAddress('hub.example.com:8443'), { host: 'hub.example.com', port: 8443 }))
check('parse: trims surrounding whitespace', deepEq(parseHubAddress('  127.0.0.1:9  '), { host: '127.0.0.1', port: 9 }))
// Malformed → null so a caller falls back to its default rather than binding
// something the operator did not ask for.
check('parse: reject scheme', parseHubAddress('http://127.0.0.1:1') === null)
check('parse: reject path', parseHubAddress('127.0.0.1:1/trpc') === null)
check('parse: reject out-of-range port', parseHubAddress('127.0.0.1:70000') === null)
check('parse: reject non-numeric port', parseHubAddress('127.0.0.1:abc') === null)
check('parse: reject empty', parseHubAddress('') === null)
check('parse: reject undefined', parseHubAddress(undefined) === null)

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
