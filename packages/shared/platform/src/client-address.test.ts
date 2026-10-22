/**
 * The client-address resolver (T-22): which front ends are trusted, which
 * `X-Forwarded-For` entry names the client, and that nothing a client writes can
 * name it — IPv4, IPv6, `IP:port` (Application Gateway v2), `[v6]:port`, IPv4-mapped
 * IPv6, whitespace, several header lines and malformed entries. Plus adoption onto a
 * request (the header better-auth reads is always the hub's), the boot warning, and
 * the env registrations.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/client-address.test.ts
 */
import {
  adoptClientAddress,
  canonicalAddress,
  CLIENT_ADDRESS_HEADER,
  clientAddress,
  NO_TRUSTED_PROXIES,
  parseTrustedProxies,
  resolveClientAddress,
  trustedProxiesBootWarning,
  type TrustedProxies
} from './client-address'
import { ENV_MANIFEST } from './env-manifest'
import { HUB_PROCESS_ENV, HUB_TRUSTED_PROXIES_ENV } from './hub-switches'
import { peerAddress } from './security-log'

let passed = 0
let failed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`)
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function eq(got: unknown, want: unknown, msg: string): void {
  assert(got === want, `${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

/** A trusted set that must parse. */
function trust(raw: string): TrustedProxies {
  const parsed = parseTrustedProxies(raw)
  if (!parsed.ok) throw new Error(`should parse: ${raw} — ${parsed.message}`)
  return parsed.value
}

const GATEWAY_SUBNET = trust('10.93.4.0/24')
const GW = '10.93.4.5' // an Application Gateway instance in that subnet
const CLIENT = '203.0.113.7'

console.log('\nclient address: canonical form')

await test('IPv4 is kept, IPv6 compressed and lowercased, IPv4-mapped becomes IPv4', () => {
  eq(canonicalAddress('203.0.113.7'), '203.0.113.7', 'v4')
  eq(canonicalAddress('2001:DB8:0:0:0:0:0:1'), '2001:db8::1', 'v6')
  eq(canonicalAddress('::1'), '::1', 'loopback v6')
  eq(canonicalAddress('::ffff:10.93.4.5'), '10.93.4.5', 'mapped')
  eq(canonicalAddress('::FFFF:0a5d:0405'), '10.93.4.5', 'mapped, hex form')
})

await test('anything that is not exactly one address is null', () => {
  for (const bad of [
    '',
    'unknown',
    '01.2.3.4',
    '1.2.3',
    '256.1.1.1',
    '0x7f.0.0.1',
    ' 1.2.3.4',
    '1.2.3.4:80',
    '[::1]',
    'fe80::1%en0',
    'localhost'
  ]) {
    eq(canonicalAddress(bad), null, `'${bad}'`)
  }
})

console.log('\nclient address: the trusted list (SLAYZONE_HUB_TRUSTED_PROXIES)')

await test('unset, blank and only-separators trust nobody', () => {
  for (const raw of [undefined, '', '   ', ' , ,']) {
    const parsed = parseTrustedProxies(raw)
    assert(parsed.ok && parsed.value === NO_TRUSTED_PROXIES, `'${raw}' → nobody`)
  }
  eq(NO_TRUSTED_PROXIES.has('127.0.0.1'), false, 'nobody is nobody')
})

await test('IPs and CIDRs, IPv4 and IPv6, whitespace and empty elements ignored', () => {
  const t = trust(' 10.93.4.0/24 ,, 192.0.2.10,2001:db8:feed::/48 , ::1 ')
  eq(t.entries.join(' '), '10.93.4.0/24 192.0.2.10 2001:db8:feed::/48 ::1', 'entries, canonical')
  assert(t.has('10.93.4.5') && t.has('10.93.4.255'), 'inside the /24')
  assert(!t.has('10.93.5.1') && !t.has('10.93.3.255'), 'outside the /24')
  assert(t.has('192.0.2.10') && !t.has('192.0.2.11'), 'single v4')
  assert(t.has('2001:db8:feed:1::9') && !t.has('2001:db8:fee0::1'), 'v6 /48')
  assert(t.has('::1') && !t.has('::2'), 'single v6')
  assert(!t.has('garbage') && !t.has(''), 'never a non-address')
})

await test('an IPv4-mapped entry is the IPv4 address or network it maps', () => {
  const t = trust('::ffff:192.0.2.10, ::ffff:10.0.0.0/104')
  eq(t.entries.join(' '), '192.0.2.10 10.0.0.0/8', 'entries')
  assert(t.has('192.0.2.10') && t.has('10.200.1.1'), 'matches the IPv4 forms')
})

await test('a malformed entry fails the whole list, naming the variable and every bad entry', () => {
  for (const bad of [
    'gateway.internal',
    '10.93.4.0/33',
    '10.93.4.0/',
    '10.93.4.0/x',
    '2001:db8::/129',
    '[::1]',
    '10.93.4.5:443',
    'fe80::1%en0',
    '::ffff:0:0/95'
  ]) {
    const parsed = parseTrustedProxies(`10.93.4.0/24, ${bad}`)
    assert(!parsed.ok, `'${bad}' refused`)
    eq(parsed.invalid.join('|'), bad, `only '${bad}' reported`)
    assert(parsed.message.includes(HUB_TRUSTED_PROXIES_ENV), 'names the variable')
    assert(parsed.message.includes(`'${bad}'`), 'names the entry')
  }
  const two = parseTrustedProxies('x, y')
  assert(!two.ok && two.invalid.length === 2, 'every bad entry at once')
})

await test('/0 is refused in either family: it would trust every client', () => {
  for (const bad of ['0.0.0.0/0', '::/0', '1.2.3.4/0', '::ffff:0.0.0.0/96']) {
    assert(!parseTrustedProxies(bad).ok, `'${bad}' refused`)
  }
})

console.log('\nclient address: the resolver')

await test('trust nobody (the default): the peer, whatever X-Forwarded-For says', () => {
  eq(resolveClientAddress(GW, `${CLIENT}`, NO_TRUSTED_PROXIES), GW, 'header ignored')
  eq(resolveClientAddress('127.0.0.1', '6.6.6.6', NO_TRUSTED_PROXIES), '127.0.0.1', 'desktop')
  eq(resolveClientAddress('::1', undefined, NO_TRUSTED_PROXIES), '::1', 'v6 loopback peer')
})

await test('an untrusted peer: the header is ignored even when it names a trusted hop', () => {
  eq(resolveClientAddress('198.51.100.4', `${CLIENT}`, GATEWAY_SUBNET), '198.51.100.4', 'direct')
  eq(resolveClientAddress('198.51.100.4', `${CLIENT}, ${GW}`, GATEWAY_SUBNET), '198.51.100.4', 'x')
})

await test('a trusted peer: the client it forwarded, with or without the port it appends', () => {
  eq(resolveClientAddress(GW, CLIENT, GATEWAY_SUBNET), CLIENT, 'bare')
  eq(resolveClientAddress(GW, `${CLIENT}:51234`, GATEWAY_SUBNET), CLIENT, 'IP:port (App Gateway)')
  eq(resolveClientAddress(GW, `${CLIENT}:0`, GATEWAY_SUBNET), CLIENT, 'port 0')
  eq(resolveClientAddress(GW, `${CLIENT}:65535`, GATEWAY_SUBNET), CLIENT, 'port 65535')
})

await test('what the client wrote left of the appended entry is never believed', () => {
  // The client sent `X-Forwarded-For: 6.6.6.6, 10.93.4.9`; the gateway appended its peer.
  eq(
    resolveClientAddress(GW, `6.6.6.6, 10.93.4.9, ${CLIENT}:4000`, GATEWAY_SUBNET),
    CLIENT,
    'rightmost untrusted wins'
  )
})

await test('trusted hops inside the chain are skipped; all trusted → the leftmost', () => {
  const t = trust('10.93.0.0/16')
  eq(resolveClientAddress(GW, `198.51.100.1, ${CLIENT}, 10.93.2.2:80`, t), CLIENT, 'skip inner')
  eq(resolveClientAddress(GW, '10.93.3.3, 10.93.2.2', t), '10.93.3.3', 'all trusted')
  eq(resolveClientAddress(GW, undefined, t), GW, 'no header: the peer itself')
  eq(resolveClientAddress(GW, '', t), GW, 'empty header: the peer itself')
})

await test('a malformed entry stops the walk at the last hop already vouched for', () => {
  const t = trust('10.93.0.0/16')
  for (const garbage of [
    'garbage',
    'unknown',
    '_hidden',
    `"${CLIENT}"`,
    `${CLIENT}:`,
    `${CLIENT}:99999`,
    `${CLIENT}:80:81`,
    '01.2.3.4',
    '[2001:db8::1]:x',
    '[203.0.113.7]',
    'fe80::1%eth0',
    '2001:db8::1:52000'
  ]) {
    eq(resolveClientAddress(GW, `${CLIENT}, ${garbage}`, t), GW, `rightmost '${garbage}' → peer`)
    eq(
      resolveClientAddress(GW, `6.6.6.6, ${garbage}, 10.93.2.2`, t),
      '10.93.2.2',
      `'${garbage}' behind a trusted hop → that hop`
    )
  }
  // Left of the first untrusted hop is never even read.
  eq(resolveClientAddress(GW, `garbage, ${CLIENT}`, t), CLIENT, 'left of the client')
})

await test('IPv6: bare, [v6] and [v6]:port entries, peers and trusted ranges', () => {
  const t = trust('2001:db8:feed::/48')
  const peer = '2001:db8:feed::5'
  eq(resolveClientAddress(peer, '[2001:db8:cafe::7]:443', t), '2001:db8:cafe::7', '[v6]:port')
  eq(resolveClientAddress(peer, '[2001:db8:cafe::7]', t), '2001:db8:cafe::7', '[v6]')
  eq(resolveClientAddress(peer, '2001:DB8:CAFE:0:0:0:0:7', t), '2001:db8:cafe::7', 'bare, canon')
  eq(resolveClientAddress(peer, `${CLIENT}:9`, t), CLIENT, 'v4 client behind a v6 front end')
  eq(
    resolveClientAddress(peer, '[2001:db8:cafe::7]:1, [2001:db8:feed::9]:2', t),
    '2001:db8:cafe::7',
    'trusted v6 hop skipped'
  )
  eq(resolveClientAddress('2001:db8:cafe::7', CLIENT, t), '2001:db8:cafe::7', 'untrusted v6 peer')
  // An unbracketed v6 with a port cannot be told from an address: read as the address.
  eq(resolveClientAddress(peer, '2001:db8::1:4433', t), '2001:db8::1:4433', 'ambiguous v6:port')
})

await test('IPv4-mapped IPv6: a mapped peer matches IPv4 ranges, mapped entries read as IPv4', () => {
  eq(resolveClientAddress(`::ffff:${GW}`, CLIENT, GATEWAY_SUBNET), CLIENT, 'mapped peer trusted')
  eq(resolveClientAddress(GW, `::ffff:${CLIENT}`, GATEWAY_SUBNET), CLIENT, 'mapped entry → IPv4')
  eq(
    resolveClientAddress('::ffff:198.51.100.2', CLIENT, GATEWAY_SUBNET),
    '198.51.100.2',
    'untrusted mapped peer, canonical'
  )
})

await test('whitespace, empty elements and several header lines are one ordered list', () => {
  eq(resolveClientAddress(GW, `   ${CLIENT}:1   ,  `, GATEWAY_SUBNET), CLIENT, 'padding')
  eq(resolveClientAddress(GW, `,,${CLIENT},,`, GATEWAY_SUBNET), CLIENT, 'empty elements')
  eq(resolveClientAddress(GW, ['6.6.6.6', `${CLIENT}:2`], GATEWAY_SUBNET), CLIENT, 'two lines')
  const t = trust('10.93.0.0/16')
  eq(resolveClientAddress(GW, [CLIENT, '10.93.2.2'], t), CLIENT, 'order kept across lines')
})

await test('no peer → null; a peer that is not an address is returned as is, trusted for nothing', () => {
  eq(resolveClientAddress(undefined, CLIENT, GATEWAY_SUBNET), null, 'destroyed socket')
  eq(resolveClientAddress('', CLIENT, GATEWAY_SUBNET), null, 'empty peer')
  eq(resolveClientAddress('not-an-ip', CLIENT, trust('0.0.0.1/1')), 'not-an-ip', 'non-ip peer')
  eq(resolveClientAddress('fe80::1%en0', CLIENT, GATEWAY_SUBNET), 'fe80::1', 'zone id dropped')
})

console.log('\nclient address: adopted onto the request')

/** A request shaped like an `IncomingMessage`, from `peer`. */
function request(
  peer: string | undefined,
  headers: Record<string, string | string[] | undefined> = {}
): { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> } {
  return { socket: peer === undefined ? {} : { remoteAddress: peer }, headers }
}

await test('adopt resolves once and clientAddress reads it back; peerAddress is the same', () => {
  const req = request(GW, { 'x-forwarded-for': `${CLIENT}:5000` })
  eq(adoptClientAddress(req, GATEWAY_SUBNET), CLIENT, 'returned')
  eq(clientAddress(req), CLIENT, 'read back')
  eq(peerAddress(req), CLIENT, 'the audit alias')
  // A later header change does not re-resolve: one resolution per request.
  req.headers['x-forwarded-for'] = '198.51.100.9'
  eq(clientAddress(req), CLIENT, 'stable')
})

await test('the header better-auth reads is always the hub’s: overwritten, or removed', () => {
  const spoofed = request('198.51.100.4', {
    'x-forwarded-for': '6.6.6.6',
    [CLIENT_ADDRESS_HEADER]: '6.6.6.6'
  })
  adoptClientAddress(spoofed, GATEWAY_SUBNET)
  eq(spoofed.headers[CLIENT_ADDRESS_HEADER], '198.51.100.4', 'direct client: its peer')
  const proxied = request(GW, {
    'x-forwarded-for': `${CLIENT}:1`,
    [CLIENT_ADDRESS_HEADER]: ['6.6.6.6', '7.7.7.7']
  })
  adoptClientAddress(proxied, GATEWAY_SUBNET)
  eq(proxied.headers[CLIENT_ADDRESS_HEADER], CLIENT, 'through the front end: the client')
  const gone = request(undefined, { [CLIENT_ADDRESS_HEADER]: '6.6.6.6' })
  eq(adoptClientAddress(gone, GATEWAY_SUBNET), null, 'no peer')
  assert(!(CLIENT_ADDRESS_HEADER in gone.headers), 'a supplied value never survives')
})

await test('a request the hub never adopted: the TCP peer exactly as reported (as before)', () => {
  eq(clientAddress(request('::ffff:127.0.0.1')), '::ffff:127.0.0.1', 'raw peer')
  eq(clientAddress(request(undefined)), null, 'no peer')
  eq(clientAddress(null), null, 'no request')
  eq(peerAddress({ socket: null }), null, 'alias, no socket')
})

console.log('\nclient address: boot warning and registration')

await test('warn only for a non-loopback public address with nobody trusted', () => {
  const warning = trustedProxiesBootWarning('hub.example.com', NO_TRUSTED_PROXIES)
  assert(warning !== null, 'warns')
  assert(
    warning.includes('SLAYZONE_HUB_PUBLIC_ADDRESS') && warning.includes(HUB_TRUSTED_PROXIES_ENV),
    `names both variables: ${warning}`
  )
  eq(trustedProxiesBootWarning('hub.example.com', GATEWAY_SUBNET), null, 'list set')
  eq(trustedProxiesBootWarning(undefined, NO_TRUSTED_PROXIES), null, 'no public address')
  for (const loop of ['127.0.0.1:8443', 'localhost', '[::1]:9']) {
    eq(trustedProxiesBootWarning(loop, NO_TRUSTED_PROXIES), null, `loopback ${loop}`)
  }
})

await test('the variable is infra-scoped and cleared before a parent spawns a hub', () => {
  eq(HUB_TRUSTED_PROXIES_ENV, 'SLAYZONE_HUB_TRUSTED_PROXIES', 'name')
  eq(ENV_MANIFEST[HUB_TRUSTED_PROXIES_ENV], 'infra', 'manifest scope')
  assert(HUB_PROCESS_ENV.includes(HUB_TRUSTED_PROXIES_ENV), 'in HUB_PROCESS_ENV')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
