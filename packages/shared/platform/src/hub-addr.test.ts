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
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/hub-addr.test.ts
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertLoopbackBind,
  hubAddrFromUrl,
  hubUrlFromAddr,
  isBareAuthority,
  isLoopbackAuthority,
  isLoopbackComputerUrl,
  parseHubAddress
} from './hub-addr'

// --- A1: loopback host → plaintext schemes ---
test('loopback ip: ws family → ws:// + path', () => {
  expect(hubUrlFromAddr('127.0.0.1:8788', 'ws', '/computers')).toBe('ws://127.0.0.1:8788/computers')
})

test('loopback ip: http family → http:// (no path)', () => {
  expect(hubUrlFromAddr('127.0.0.1:51100', 'http')).toBe('http://127.0.0.1:51100')
})

test('loopback name: localhost → http', () => {
  expect(hubUrlFromAddr('localhost:8443', 'http')).toBe('http://localhost:8443')
})

test('loopback name: localhost → ws', () => {
  expect(hubUrlFromAddr('localhost', 'ws')).toBe('ws://localhost')
})

test('loopback ipv6: [::1] → http', () => {
  expect(hubUrlFromAddr('[::1]:8080', 'http')).toBe('http://[::1]:8080')
})

test('loopback ipv6: [::1] → ws', () => {
  expect(hubUrlFromAddr('[::1]', 'ws', '/computers')).toBe('ws://[::1]/computers')
})

test('loopback is case-insensitive (LOCALHOST)', () => {
  expect(hubUrlFromAddr('LOCALHOST:1', 'http')).toBe('http://LOCALHOST:1')
})

// --- A1: any other host → secure schemes ---
test('other host: ws family → wss:// + path', () => {
  expect(hubUrlFromAddr('hub.example.com', 'ws', '/computers')).toBe(
    'wss://hub.example.com/computers'
  )
})

test('other host: http family → https://', () => {
  expect(hubUrlFromAddr('hub.example.com', 'http')).toBe('https://hub.example.com')
})

test('other host with port keeps the port', () => {
  expect(hubUrlFromAddr('hub.example.com:8443', 'http')).toBe('https://hub.example.com:8443')
})

test('LAN ip is NOT loopback → https', () => {
  expect(hubUrlFromAddr('10.0.0.5:51100', 'http')).toBe('https://10.0.0.5:51100')
})

test('wildcard 0.0.0.0 is NOT loopback → https', () => {
  expect(hubUrlFromAddr('0.0.0.0:1', 'http')).toBe('https://0.0.0.0:1')
})

test('other 127.x is NOT in the set → https', () => {
  expect(hubUrlFromAddr('127.0.0.2:1', 'http')).toBe('https://127.0.0.2:1')
})

test('bracketed non-loopback ipv6 → https', () => {
  expect(hubUrlFromAddr('[2001:db8::1]:8443', 'http')).toBe('https://[2001:db8::1]:8443')
})

test('a host that merely starts with localhost is not loopback', () => {
  expect(hubUrlFromAddr('localhost.example.com', 'http')).toBe('https://localhost.example.com')
})

test('empty path default appends nothing', () => {
  expect(hubUrlFromAddr('h.example:2', 'http')).toBe('https://h.example:2')
})
// Fails closed: an unparseable authority gets the SECURE scheme, never plaintext.
test('unparseable authority → secure scheme', () => {
  expect(hubUrlFromAddr('not a host', 'http').startsWith('https://')).toBe(true)
})
// SLAYZONE_MODE is not consulted any more: a leftover value must change nothing.
describe('a leftover SLAYZONE_MODE', () => {
  const prev = process.env.SLAYZONE_MODE
  afterEach(() => {
    if (prev === undefined) delete process.env.SLAYZONE_MODE
    else process.env.SLAYZONE_MODE = prev
  })

  test('a leftover SLAYZONE_MODE=remote does not secure a loopback address', () => {
    process.env.SLAYZONE_MODE = 'remote'
    expect(hubUrlFromAddr('127.0.0.1:1', 'http')).toBe('http://127.0.0.1:1')
  })

  test('a leftover SLAYZONE_MODE=local does not weaken a public address', () => {
    process.env.SLAYZONE_MODE = 'local'
    expect(hubUrlFromAddr('hub.example.com', 'http')).toBe('https://hub.example.com')
  })
})

// --- isLoopbackAuthority ---
test('isLoopbackAuthority: 127.0.0.1:1', () => {
  expect(isLoopbackAuthority('127.0.0.1:1')).toBe(true)
})

test('isLoopbackAuthority: localhost', () => {
  expect(isLoopbackAuthority('localhost')).toBe(true)
})

test('isLoopbackAuthority: [::1]:9', () => {
  expect(isLoopbackAuthority('[::1]:9')).toBe(true)
})

test('isLoopbackAuthority: public name', () => {
  expect(isLoopbackAuthority('hub.example.com:443')).toBeFalsy()
})

test('isLoopbackAuthority: garbage → false', () => {
  expect(isLoopbackAuthority('not a host')).toBeFalsy()
})

// --- B9: assertLoopbackBind ---
{
  let threw = ''
  try {
    assertLoopbackBind('0.0.0.0')
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  test('assertLoopbackBind refuses 0.0.0.0', () => {
    expect(threw, threw).toMatch(/SLAYZONE_SUPERVISED/)
    expect(threw, threw).toMatch(/0\.0\.0\.0/)
  })
  let threwWildcard6 = false
  try {
    assertLoopbackBind('::')
  } catch {
    threwWildcard6 = true
  }
  test('assertLoopbackBind refuses the ipv6 wildcard ::', () => {
    expect(threwWildcard6).toBe(true)
  })
  let ok = true
  for (const h of ['127.0.0.1', 'localhost', '::1']) {
    try {
      assertLoopbackBind(h)
    } catch {
      ok = false
    }
  }
  test('assertLoopbackBind accepts 127.0.0.1 / localhost / ::1', () => {
    expect(ok).toBe(true)
  })
}

// --- isBareAuthority: the env-channel guard (no scheme, no path) ---
test('authority: host:port', () => {
  expect(isBareAuthority('127.0.0.1:51100')).toBe(true)
})

test('authority: host only', () => {
  expect(isBareAuthority('hub.example.com')).toBe(true)
})

test('authority: bracketed ipv6 + port', () => {
  expect(isBareAuthority('[::1]:8080')).toBe(true)
})

test('authority: wildcard bind host', () => {
  expect(isBareAuthority('0.0.0.0:0')).toBe(true)
})

test('reject: carries a scheme', () => {
  expect(isBareAuthority('http://hub.example.com')).toBeFalsy()
})

test('reject: carries a path', () => {
  expect(isBareAuthority('hub.example.com/slayzone')).toBeFalsy()
})

test('reject: trailing slash', () => {
  expect(isBareAuthority('hub.example.com/')).toBeFalsy()
})

test('reject: userinfo', () => {
  expect(isBareAuthority('user@hub.example.com')).toBeFalsy()
})

test('reject: whitespace', () => {
  expect(isBareAuthority('hub.example.com :80')).toBeFalsy()
})

test('reject: empty', () => {
  expect(isBareAuthority('')).toBeFalsy()
})

test('reject: double scheme', () => {
  expect(isBareAuthority('http://http://x')).toBeFalsy()
})

// --- parseHubAddress: the BIND side (host + optional port) ---
// PORT GRAMMAR: a bare host means "port unspecified" → the bind side lets the OS
// assign (port === undefined, callers default to 0); an explicit `:0` says the
// same thing outright. The dial side never parses — it hands the authority to
// hubUrlFromAddr verbatim so the scheme's default port stays implicit.
test('parse: host:port', () => {
  expect(parseHubAddress('127.0.0.1:51100')).toMatchObject({ host: '127.0.0.1', port: 51100 })
})

test('parse: host only → port undefined', () => {
  expect(parseHubAddress('127.0.0.1')).toMatchObject({ host: '127.0.0.1', port: undefined })
})

test('parse: explicit :0 → OS-assigned', () => {
  expect(parseHubAddress('127.0.0.1:0')).toMatchObject({ host: '127.0.0.1', port: 0 })
})

test('parse: wildcard host', () => {
  expect(parseHubAddress('0.0.0.0:8080')).toMatchObject({ host: '0.0.0.0', port: 8080 })
})
// IPv6 must come back UNBRACKETED — node's `server.listen(host)` wants the bare
// literal, while the URL authority form requires the brackets.
test('parse: bracketed ipv6 → unbracketed host', () => {
  expect(parseHubAddress('[::1]:8080')).toMatchObject({ host: '::1', port: 8080 })
})

test('parse: bracketed ipv6, no port', () => {
  expect(parseHubAddress('[::]')).toMatchObject({ host: '::', port: undefined })
})

test('parse: hostname', () => {
  expect(parseHubAddress('hub.example.com:8443')).toMatchObject({
    host: 'hub.example.com',
    port: 8443
  })
})

test('parse: trims surrounding whitespace', () => {
  expect(parseHubAddress('  127.0.0.1:9  ')).toMatchObject({ host: '127.0.0.1', port: 9 })
})
// Malformed → null so a caller falls back to its default rather than binding
// something the operator did not ask for.
test('parse: reject scheme', () => {
  expect(parseHubAddress('http://127.0.0.1:1')).toBeNull()
})

test('parse: reject path', () => {
  expect(parseHubAddress('127.0.0.1:1/trpc')).toBeNull()
})

test('parse: reject out-of-range port', () => {
  expect(parseHubAddress('127.0.0.1:70000')).toBeNull()
})

test('parse: reject non-numeric port', () => {
  expect(parseHubAddress('127.0.0.1:abc')).toBeNull()
})

test('parse: reject empty', () => {
  expect(parseHubAddress('')).toBeNull()
})

test('parse: reject undefined', () => {
  expect(parseHubAddress(undefined)).toBeNull()
})

// --- isLoopbackComputerUrl: is a minted join token usable OFF the hub's box? ---
// A hub with no public address derives `ws://<loopback>:<port>/computers` for the URL
// it embeds in join tokens. That is correct for a co-located computer and useless
// for any other machine — the computer would dial its OWN loopback. This predicate
// is what lets the UI and the CLI say so instead of handing over a dead token.
test('loopback: 127.0.0.1', () => {
  expect(isLoopbackComputerUrl('ws://127.0.0.1:51100/computers')).toBe(true)
})

test('loopback: other 127.x', () => {
  expect(isLoopbackComputerUrl('ws://127.0.0.53:8080/computers')).toBe(true)
})

test('loopback: localhost', () => {
  expect(isLoopbackComputerUrl('ws://localhost:51100/computers')).toBe(true)
})

test('loopback: bracketed ipv6 ::1', () => {
  expect(isLoopbackComputerUrl('ws://[::1]:51100/computers')).toBe(true)
})

test('loopback: wss loopback still loopback', () => {
  expect(isLoopbackComputerUrl('wss://127.0.0.1/computers')).toBe(true)
})
// Off-box targets — the whole point of `--public-address`.
test('off-box: public dns name', () => {
  expect(isLoopbackComputerUrl('wss://hub.example.com:8443/computers')).toBeFalsy()
})

test('off-box: private LAN ip', () => {
  expect(isLoopbackComputerUrl('ws://10.0.0.5:51100/computers')).toBeFalsy()
})

test('off-box: public ip', () => {
  expect(isLoopbackComputerUrl('wss://203.0.113.9/computers')).toBeFalsy()
})
// A wildcard BIND is not a dialable loopback target: a token carrying it is
// broken for everyone, so calling it "loopback" would misdirect the operator.
test('off-box: wildcard 0.0.0.0 is not loopback', () => {
  expect(isLoopbackComputerUrl('ws://0.0.0.0:51100/computers')).toBeFalsy()
})
// Unparseable → false: never claim a URL is loopback when we cannot tell.
test('unparseable: garbage → false', () => {
  expect(isLoopbackComputerUrl('not a url')).toBeFalsy()
})

test('unparseable: empty → false', () => {
  expect(isLoopbackComputerUrl('')).toBeFalsy()
})

// --- hubAddrFromUrl: the inverse of hubUrlFromAddr ---
// A computer hands each pty the authority of the hub it dials, so `slay` there talks
// to the hub that spawned it. Re-composed by the CLI (A1), it must name the same
// endpoint the computer dials — or nothing at all.
describe('hubAddrFromUrl', () => {
  test.each([
    ['ws://127.0.0.1:51101/computers', '127.0.0.1:51101'],
    ['ws://localhost:8443/computers', 'localhost:8443'],
    ['ws://[::1]:8080/computers', '[::1]:8080'],
    ['wss://slay.example.com/computers', 'slay.example.com'],
    ['wss://hub.example.com:8443/computers', 'hub.example.com:8443'],
    // The scheme's default port is implicit in the authority, as A1 composes it.
    ['wss://hub.example.com:443/computers', 'hub.example.com'],
    ['https://hub.example.com', 'hub.example.com'],
    ['http://127.0.0.1:51101', '127.0.0.1:51101']
  ])('%s → %s', (url, addr) => {
    expect(hubAddrFromUrl(url)).toBe(addr)
  })

  test.each([
    ['ws://127.0.0.1:51101/computers', 'ws'],
    ['wss://hub.example.com:8443/computers', 'ws'],
    ['https://hub.example.com', 'http']
  ] as const)('round-trips through hubUrlFromAddr (%s)', (url, kind) => {
    const addr = hubAddrFromUrl(url)!
    expect(new URL(hubUrlFromAddr(addr, kind)).origin).toBe(new URL(url).origin)
  })

  // A scheme A1 would not derive from this host: the authority, re-composed, would
  // name a different endpoint (https:// where the computer dials ws://). No answer
  // beats a wrong one.
  test.each([
    'ws://hub.lan:8080/computers',
    'wss://127.0.0.1:8443/computers',
    'http://hub.example.com'
  ])('%s → null (scheme disagrees with A1)', (url) => {
    expect(hubAddrFromUrl(url)).toBeNull()
  })

  test.each(['not a url', '', 'ftp://hub.example.com', 'wss://user:pw@hub.example.com/'])(
    '%s → null',
    (url) => {
      expect(hubAddrFromUrl(url)).toBeNull()
    }
  )
})
