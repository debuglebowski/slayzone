/**
 * hubUrlFromAddr — compose a full hub URL from an authority-only address
 * (`host[:port]`, no scheme, no path), with the scheme derived from the HOST
 * (rule A1): loopback (127.0.0.1, localhost, ::1) → http/ws, any other host →
 * https/wss. This is what makes the old ws-vs-http `SLAYZONE_HUB_URL` collision
 * unrepresentable: the env channel never carries a scheme, so a computer (ws) and
 * the CLI (http) reading the SAME var can never disagree. There is no mode flag.
 *
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/hub-addr.test.ts
 */
import {
  assertLoopbackBind,
  hubUrlFromAddr,
  isBareAuthority,
  isLoopbackAuthority,
  isLoopbackComputerUrl,
  parseHubAddress
} from './hub-addr'

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

// --- A1: loopback host → plaintext schemes ---
check(
  'loopback ip: ws family → ws:// + path',
  hubUrlFromAddr('127.0.0.1:8788', 'ws', '/computers') === 'ws://127.0.0.1:8788/computers'
)
check(
  'loopback ip: http family → http:// (no path)',
  hubUrlFromAddr('127.0.0.1:51100', 'http') === 'http://127.0.0.1:51100'
)
check(
  'loopback name: localhost → http',
  hubUrlFromAddr('localhost:8443', 'http') === 'http://localhost:8443'
)
check('loopback name: localhost → ws', hubUrlFromAddr('localhost', 'ws') === 'ws://localhost')
check('loopback ipv6: [::1] → http', hubUrlFromAddr('[::1]:8080', 'http') === 'http://[::1]:8080')
check(
  'loopback ipv6: [::1] → ws',
  hubUrlFromAddr('[::1]', 'ws', '/computers') === 'ws://[::1]/computers'
)
check(
  'loopback is case-insensitive (LOCALHOST)',
  hubUrlFromAddr('LOCALHOST:1', 'http') === 'http://LOCALHOST:1'
)

// --- A1: any other host → secure schemes ---
check(
  'other host: ws family → wss:// + path',
  hubUrlFromAddr('hub.example.com', 'ws', '/computers') === 'wss://hub.example.com/computers'
)
check(
  'other host: http family → https://',
  hubUrlFromAddr('hub.example.com', 'http') === 'https://hub.example.com'
)
check(
  'other host with port keeps the port',
  hubUrlFromAddr('hub.example.com:8443', 'http') === 'https://hub.example.com:8443'
)
check(
  'LAN ip is NOT loopback → https',
  hubUrlFromAddr('10.0.0.5:51100', 'http') === 'https://10.0.0.5:51100'
)
check(
  'wildcard 0.0.0.0 is NOT loopback → https',
  hubUrlFromAddr('0.0.0.0:1', 'http') === 'https://0.0.0.0:1'
)
check(
  'other 127.x is NOT in the set → https',
  hubUrlFromAddr('127.0.0.2:1', 'http') === 'https://127.0.0.2:1'
)
check(
  'bracketed non-loopback ipv6 → https',
  hubUrlFromAddr('[2001:db8::1]:8443', 'http') === 'https://[2001:db8::1]:8443'
)
check(
  'a host that merely starts with localhost is not loopback',
  hubUrlFromAddr('localhost.example.com', 'http') === 'https://localhost.example.com'
)
check(
  'empty path default appends nothing',
  hubUrlFromAddr('h.example:2', 'http') === 'https://h.example:2'
)
// Fails closed: an unparseable authority gets the SECURE scheme, never plaintext.
check(
  'unparseable authority → secure scheme',
  hubUrlFromAddr('not a host', 'http').startsWith('https://')
)
// SLAYZONE_MODE is not consulted any more: a leftover value must change nothing.
{
  const prev = process.env.SLAYZONE_MODE
  process.env.SLAYZONE_MODE = 'remote'
  check(
    'a leftover SLAYZONE_MODE=remote does not secure a loopback address',
    hubUrlFromAddr('127.0.0.1:1', 'http') === 'http://127.0.0.1:1'
  )
  process.env.SLAYZONE_MODE = 'local'
  check(
    'a leftover SLAYZONE_MODE=local does not weaken a public address',
    hubUrlFromAddr('hub.example.com', 'http') === 'https://hub.example.com'
  )
  if (prev === undefined) delete process.env.SLAYZONE_MODE
  else process.env.SLAYZONE_MODE = prev
}

// --- isLoopbackAuthority ---
check('isLoopbackAuthority: 127.0.0.1:1', isLoopbackAuthority('127.0.0.1:1'))
check('isLoopbackAuthority: localhost', isLoopbackAuthority('localhost'))
check('isLoopbackAuthority: [::1]:9', isLoopbackAuthority('[::1]:9'))
check('isLoopbackAuthority: public name', !isLoopbackAuthority('hub.example.com:443'))
check('isLoopbackAuthority: garbage → false', !isLoopbackAuthority('not a host'))

// --- B9: assertLoopbackBind ---
{
  let threw = ''
  try {
    assertLoopbackBind('0.0.0.0')
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check(
    'assertLoopbackBind refuses 0.0.0.0',
    /SLAYZONE_SUPERVISED/.test(threw) && /0\.0\.0\.0/.test(threw),
    threw
  )
  let threwWildcard6 = false
  try {
    assertLoopbackBind('::')
  } catch {
    threwWildcard6 = true
  }
  check('assertLoopbackBind refuses the ipv6 wildcard ::', threwWildcard6)
  let ok = true
  for (const h of ['127.0.0.1', 'localhost', '::1']) {
    try {
      assertLoopbackBind(h)
    } catch {
      ok = false
    }
  }
  check('assertLoopbackBind accepts 127.0.0.1 / localhost / ::1', ok)
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
check(
  'parse: host:port',
  deepEq(parseHubAddress('127.0.0.1:51100'), { host: '127.0.0.1', port: 51100 })
)
check(
  'parse: host only → port undefined',
  deepEq(parseHubAddress('127.0.0.1'), { host: '127.0.0.1', port: undefined })
)
check(
  'parse: explicit :0 → OS-assigned',
  deepEq(parseHubAddress('127.0.0.1:0'), { host: '127.0.0.1', port: 0 })
)
check(
  'parse: wildcard host',
  deepEq(parseHubAddress('0.0.0.0:8080'), { host: '0.0.0.0', port: 8080 })
)
// IPv6 must come back UNBRACKETED — node's `server.listen(host)` wants the bare
// literal, while the URL authority form requires the brackets.
check(
  'parse: bracketed ipv6 → unbracketed host',
  deepEq(parseHubAddress('[::1]:8080'), { host: '::1', port: 8080 })
)
check(
  'parse: bracketed ipv6, no port',
  deepEq(parseHubAddress('[::]'), { host: '::', port: undefined })
)
check(
  'parse: hostname',
  deepEq(parseHubAddress('hub.example.com:8443'), { host: 'hub.example.com', port: 8443 })
)
check(
  'parse: trims surrounding whitespace',
  deepEq(parseHubAddress('  127.0.0.1:9  '), { host: '127.0.0.1', port: 9 })
)
// Malformed → null so a caller falls back to its default rather than binding
// something the operator did not ask for.
check('parse: reject scheme', parseHubAddress('http://127.0.0.1:1') === null)
check('parse: reject path', parseHubAddress('127.0.0.1:1/trpc') === null)
check('parse: reject out-of-range port', parseHubAddress('127.0.0.1:70000') === null)
check('parse: reject non-numeric port', parseHubAddress('127.0.0.1:abc') === null)
check('parse: reject empty', parseHubAddress('') === null)
check('parse: reject undefined', parseHubAddress(undefined) === null)

// --- isLoopbackComputerUrl: is a minted join token usable OFF the hub's box? ---
// A hub with no public address derives `ws://<loopback>:<port>/computers` for the URL
// it embeds in join tokens. That is correct for a co-located computer and useless
// for any other machine — the computer would dial its OWN loopback. This predicate
// is what lets the UI and the CLI say so instead of handing over a dead token.
check('loopback: 127.0.0.1', isLoopbackComputerUrl('ws://127.0.0.1:51100/computers'))
check('loopback: other 127.x', isLoopbackComputerUrl('ws://127.0.0.53:8080/computers'))
check('loopback: localhost', isLoopbackComputerUrl('ws://localhost:51100/computers'))
check('loopback: bracketed ipv6 ::1', isLoopbackComputerUrl('ws://[::1]:51100/computers'))
check('loopback: wss loopback still loopback', isLoopbackComputerUrl('wss://127.0.0.1/computers'))
// Off-box targets — the whole point of `--public-address`.
check('off-box: public dns name', !isLoopbackComputerUrl('wss://hub.example.com:8443/computers'))
check('off-box: private LAN ip', !isLoopbackComputerUrl('ws://10.0.0.5:51100/computers'))
check('off-box: public ip', !isLoopbackComputerUrl('wss://203.0.113.9/computers'))
// A wildcard BIND is not a dialable loopback target: a token carrying it is
// broken for everyone, so calling it "loopback" would misdirect the operator.
check(
  'off-box: wildcard 0.0.0.0 is not loopback',
  !isLoopbackComputerUrl('ws://0.0.0.0:51100/computers')
)
// Unparseable → false: never claim a URL is loopback when we cannot tell.
check('unparseable: garbage → false', !isLoopbackComputerUrl('not a url'))
check('unparseable: empty → false', !isLoopbackComputerUrl(''))

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
