/**
 * The client-address resolver (T-22): which front ends are trusted, which
 * `X-Forwarded-For` entry names the client, and that nothing a client writes can
 * name it — IPv4, IPv6, `IP:port` (Application Gateway v2), `[v6]:port`, IPv4-mapped
 * IPv6, whitespace, several header lines and malformed entries. Plus adoption onto a
 * request (the header better-auth reads is always the hub's), the boot warning, and
 * the env registrations.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/client-address.test.ts
 */
import { describe, expect, test } from 'vitest'
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

/** A trusted set that must parse. */
function trust(raw: string): TrustedProxies {
  const parsed = parseTrustedProxies(raw)
  if (!parsed.ok) throw new Error(`should parse: ${raw} — ${parsed.message}`)
  return parsed.value
}

const GATEWAY_SUBNET = trust('10.93.4.0/24')
const GW = '10.93.4.5' // an Application Gateway instance in that subnet
const CLIENT = '203.0.113.7'

describe('client address: canonical form', () => {
  test('IPv4 is kept, IPv6 compressed and lowercased, IPv4-mapped becomes IPv4', () => {
    expect(canonicalAddress('203.0.113.7'), 'v4').toBe('203.0.113.7')
    expect(canonicalAddress('2001:DB8:0:0:0:0:0:1'), 'v6').toBe('2001:db8::1')
    expect(canonicalAddress('::1'), 'loopback v6').toBe('::1')
    expect(canonicalAddress('::ffff:10.93.4.5'), 'mapped').toBe('10.93.4.5')
    expect(canonicalAddress('::FFFF:0a5d:0405'), 'mapped, hex form').toBe('10.93.4.5')
  })

  test('anything that is not exactly one address is null', () => {
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
      expect(canonicalAddress(bad), `'${bad}'`).toBe(null)
    }
  })
})

describe('client address: the trusted list (SLAYZONE_HUB_TRUSTED_PROXIES)', () => {
  test('unset, blank and only-separators trust nobody', () => {
    for (const raw of [undefined, '', '   ', ' , ,']) {
      const parsed = parseTrustedProxies(raw)
      expect(parsed.ok && parsed.value, `'${raw}' → nobody`).toBe(NO_TRUSTED_PROXIES)
    }
    expect(NO_TRUSTED_PROXIES.has('127.0.0.1'), 'nobody is nobody').toBe(false)
  })

  test('IPs and CIDRs, IPv4 and IPv6, whitespace and empty elements ignored', () => {
    const t = trust(' 10.93.4.0/24 ,, 192.0.2.10,2001:db8:feed::/48 , ::1 ')
    expect(t.entries.join(' '), 'entries, canonical').toBe(
      '10.93.4.0/24 192.0.2.10 2001:db8:feed::/48 ::1'
    )
    expect(t.has('10.93.4.5'), 'inside the /24').toBe(true)
    expect(t.has('10.93.4.255'), 'inside the /24').toBe(true)
    expect(t.has('10.93.5.1'), 'outside the /24').toBe(false)
    expect(t.has('10.93.3.255'), 'outside the /24').toBe(false)
    expect(t.has('192.0.2.10'), 'single v4').toBe(true)
    expect(t.has('192.0.2.11'), 'single v4').toBe(false)
    expect(t.has('2001:db8:feed:1::9'), 'v6 /48').toBe(true)
    expect(t.has('2001:db8:fee0::1'), 'v6 /48').toBe(false)
    expect(t.has('::1'), 'single v6').toBe(true)
    expect(t.has('::2'), 'single v6').toBe(false)
    expect(t.has('garbage'), 'never a non-address').toBe(false)
    expect(t.has(''), 'never a non-address').toBe(false)
  })

  test('an IPv4-mapped entry is the IPv4 address or network it maps', () => {
    const t = trust('::ffff:192.0.2.10, ::ffff:10.0.0.0/104')
    expect(t.entries.join(' '), 'entries').toBe('192.0.2.10 10.0.0.0/8')
    expect(t.has('192.0.2.10'), 'matches the IPv4 forms').toBe(true)
    expect(t.has('10.200.1.1'), 'matches the IPv4 forms').toBe(true)
  })

  test('a malformed entry fails the whole list, naming the variable and every bad entry', () => {
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
      // refused, and only that entry reported
      expect(parsed, `'${bad}' refused`).toMatchObject({ ok: false, invalid: [bad] })
      expect(parsed, 'names the variable').toHaveProperty(
        'message',
        expect.stringContaining(HUB_TRUSTED_PROXIES_ENV)
      )
      expect(parsed, 'names the entry').toHaveProperty(
        'message',
        expect.stringContaining(`'${bad}'`)
      )
    }
    const two = parseTrustedProxies('x, y')
    expect(two, 'every bad entry at once').toMatchObject({ ok: false, invalid: ['x', 'y'] })
  })

  test('/0 is refused in either family: it would trust every client', () => {
    for (const bad of ['0.0.0.0/0', '::/0', '1.2.3.4/0', '::ffff:0.0.0.0/96']) {
      expect(parseTrustedProxies(bad).ok, `'${bad}' refused`).toBeFalsy()
    }
  })
})

describe('client address: the resolver', () => {
  test('trust nobody (the default): the peer, whatever X-Forwarded-For says', () => {
    expect(resolveClientAddress(GW, `${CLIENT}`, NO_TRUSTED_PROXIES), 'header ignored').toBe(GW)
    expect(resolveClientAddress('127.0.0.1', '6.6.6.6', NO_TRUSTED_PROXIES), 'desktop').toBe(
      '127.0.0.1'
    )
    expect(resolveClientAddress('::1', undefined, NO_TRUSTED_PROXIES), 'v6 loopback peer').toBe(
      '::1'
    )
  })

  test('an untrusted peer: the header is ignored even when it names a trusted hop', () => {
    expect(resolveClientAddress('198.51.100.4', `${CLIENT}`, GATEWAY_SUBNET), 'direct').toBe(
      '198.51.100.4'
    )
    expect(resolveClientAddress('198.51.100.4', `${CLIENT}, ${GW}`, GATEWAY_SUBNET), 'x').toBe(
      '198.51.100.4'
    )
  })

  test('a trusted peer: the client it forwarded, with or without the port it appends', () => {
    expect(resolveClientAddress(GW, CLIENT, GATEWAY_SUBNET), 'bare').toBe(CLIENT)
    expect(
      resolveClientAddress(GW, `${CLIENT}:51234`, GATEWAY_SUBNET),
      'IP:port (App Gateway)'
    ).toBe(CLIENT)
    expect(resolveClientAddress(GW, `${CLIENT}:0`, GATEWAY_SUBNET), 'port 0').toBe(CLIENT)
    expect(resolveClientAddress(GW, `${CLIENT}:65535`, GATEWAY_SUBNET), 'port 65535').toBe(CLIENT)
  })

  test('what the client wrote left of the appended entry is never believed', () => {
    // The client sent `X-Forwarded-For: 6.6.6.6, 10.93.4.9`; the gateway appended its peer.
    expect(
      resolveClientAddress(GW, `6.6.6.6, 10.93.4.9, ${CLIENT}:4000`, GATEWAY_SUBNET),
      'rightmost untrusted wins'
    ).toBe(CLIENT)
  })

  test('trusted hops inside the chain are skipped; all trusted → the leftmost', () => {
    const t = trust('10.93.0.0/16')
    expect(resolveClientAddress(GW, `198.51.100.1, ${CLIENT}, 10.93.2.2:80`, t), 'skip inner').toBe(
      CLIENT
    )
    expect(resolveClientAddress(GW, '10.93.3.3, 10.93.2.2', t), 'all trusted').toBe('10.93.3.3')
    expect(resolveClientAddress(GW, undefined, t), 'no header: the peer itself').toBe(GW)
    expect(resolveClientAddress(GW, '', t), 'empty header: the peer itself').toBe(GW)
  })

  test('a malformed entry stops the walk at the last hop already vouched for', () => {
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
      expect(
        resolveClientAddress(GW, `${CLIENT}, ${garbage}`, t),
        `rightmost '${garbage}' → peer`
      ).toBe(GW)
      expect(
        resolveClientAddress(GW, `6.6.6.6, ${garbage}, 10.93.2.2`, t),
        `'${garbage}' behind a trusted hop → that hop`
      ).toBe('10.93.2.2')
    }
    // Left of the first untrusted hop is never even read.
    expect(resolveClientAddress(GW, `garbage, ${CLIENT}`, t), 'left of the client').toBe(CLIENT)
  })

  test('IPv6: bare, [v6] and [v6]:port entries, peers and trusted ranges', () => {
    const t = trust('2001:db8:feed::/48')
    const peer = '2001:db8:feed::5'
    expect(resolveClientAddress(peer, '[2001:db8:cafe::7]:443', t), '[v6]:port').toBe(
      '2001:db8:cafe::7'
    )
    expect(resolveClientAddress(peer, '[2001:db8:cafe::7]', t), '[v6]').toBe('2001:db8:cafe::7')
    expect(resolveClientAddress(peer, '2001:DB8:CAFE:0:0:0:0:7', t), 'bare, canon').toBe(
      '2001:db8:cafe::7'
    )
    expect(resolveClientAddress(peer, `${CLIENT}:9`, t), 'v4 client behind a v6 front end').toBe(
      CLIENT
    )
    expect(
      resolveClientAddress(peer, '[2001:db8:cafe::7]:1, [2001:db8:feed::9]:2', t),
      'trusted v6 hop skipped'
    ).toBe('2001:db8:cafe::7')
    expect(resolveClientAddress('2001:db8:cafe::7', CLIENT, t), 'untrusted v6 peer').toBe(
      '2001:db8:cafe::7'
    )
    // An unbracketed v6 with a port cannot be told from an address: read as the address.
    expect(resolveClientAddress(peer, '2001:db8::1:4433', t), 'ambiguous v6:port').toBe(
      '2001:db8::1:4433'
    )
  })

  test('IPv4-mapped IPv6: a mapped peer matches IPv4 ranges, mapped entries read as IPv4', () => {
    expect(
      resolveClientAddress(`::ffff:${GW}`, CLIENT, GATEWAY_SUBNET),
      'mapped peer trusted'
    ).toBe(CLIENT)
    expect(
      resolveClientAddress(GW, `::ffff:${CLIENT}`, GATEWAY_SUBNET),
      'mapped entry → IPv4'
    ).toBe(CLIENT)
    expect(
      resolveClientAddress('::ffff:198.51.100.2', CLIENT, GATEWAY_SUBNET),
      'untrusted mapped peer, canonical'
    ).toBe('198.51.100.2')
  })

  test('whitespace, empty elements and several header lines are one ordered list', () => {
    expect(resolveClientAddress(GW, `   ${CLIENT}:1   ,  `, GATEWAY_SUBNET), 'padding').toBe(CLIENT)
    expect(resolveClientAddress(GW, `,,${CLIENT},,`, GATEWAY_SUBNET), 'empty elements').toBe(CLIENT)
    expect(resolveClientAddress(GW, ['6.6.6.6', `${CLIENT}:2`], GATEWAY_SUBNET), 'two lines').toBe(
      CLIENT
    )
    const t = trust('10.93.0.0/16')
    expect(resolveClientAddress(GW, [CLIENT, '10.93.2.2'], t), 'order kept across lines').toBe(
      CLIENT
    )
  })

  test('no peer → null; a peer that is not an address is returned as is, trusted for nothing', () => {
    expect(resolveClientAddress(undefined, CLIENT, GATEWAY_SUBNET), 'destroyed socket').toBe(null)
    expect(resolveClientAddress('', CLIENT, GATEWAY_SUBNET), 'empty peer').toBe(null)
    expect(resolveClientAddress('not-an-ip', CLIENT, trust('0.0.0.1/1')), 'non-ip peer').toBe(
      'not-an-ip'
    )
    expect(resolveClientAddress('fe80::1%en0', CLIENT, GATEWAY_SUBNET), 'zone id dropped').toBe(
      'fe80::1'
    )
  })
})

describe('client address: adopted onto the request', () => {
  /** A request shaped like an `IncomingMessage`, from `peer`. */
  function request(
    peer: string | undefined,
    headers: Record<string, string | string[] | undefined> = {}
  ): {
    socket: { remoteAddress?: string }
    headers: Record<string, string | string[] | undefined>
  } {
    return { socket: peer === undefined ? {} : { remoteAddress: peer }, headers }
  }

  test('adopt resolves once and clientAddress reads it back; peerAddress is the same', () => {
    const req = request(GW, { 'x-forwarded-for': `${CLIENT}:5000` })
    expect(adoptClientAddress(req, GATEWAY_SUBNET), 'returned').toBe(CLIENT)
    expect(clientAddress(req), 'read back').toBe(CLIENT)
    expect(peerAddress(req), 'the audit alias').toBe(CLIENT)
    // A later header change does not re-resolve: one resolution per request.
    req.headers['x-forwarded-for'] = '198.51.100.9'
    expect(clientAddress(req), 'stable').toBe(CLIENT)
  })

  test('the header better-auth reads is always the hub’s: overwritten, or removed', () => {
    const spoofed = request('198.51.100.4', {
      'x-forwarded-for': '6.6.6.6',
      [CLIENT_ADDRESS_HEADER]: '6.6.6.6'
    })
    adoptClientAddress(spoofed, GATEWAY_SUBNET)
    expect(spoofed.headers[CLIENT_ADDRESS_HEADER], 'direct client: its peer').toBe('198.51.100.4')
    const proxied = request(GW, {
      'x-forwarded-for': `${CLIENT}:1`,
      [CLIENT_ADDRESS_HEADER]: ['6.6.6.6', '7.7.7.7']
    })
    adoptClientAddress(proxied, GATEWAY_SUBNET)
    expect(proxied.headers[CLIENT_ADDRESS_HEADER], 'through the front end: the client').toBe(CLIENT)
    const gone = request(undefined, { [CLIENT_ADDRESS_HEADER]: '6.6.6.6' })
    expect(adoptClientAddress(gone, GATEWAY_SUBNET), 'no peer').toBe(null)
    expect(CLIENT_ADDRESS_HEADER in gone.headers, 'a supplied value never survives').toBeFalsy()
  })

  test('a request the hub never adopted: the TCP peer exactly as reported (as before)', () => {
    expect(clientAddress(request('::ffff:127.0.0.1')), 'raw peer').toBe('::ffff:127.0.0.1')
    expect(clientAddress(request(undefined)), 'no peer').toBe(null)
    expect(clientAddress(null), 'no request').toBe(null)
    expect(peerAddress({ socket: null }), 'alias, no socket').toBe(null)
  })
})

describe('client address: boot warning and registration', () => {
  test('warn only for a non-loopback public address with nobody trusted', () => {
    const warning = trustedProxiesBootWarning('hub.example.com', NO_TRUSTED_PROXIES)
    expect(warning, 'warns').not.toBeNull()
    expect(warning, `names both variables: ${warning}`).toContain('SLAYZONE_HUB_PUBLIC_ADDRESS')
    expect(warning, `names both variables: ${warning}`).toContain(HUB_TRUSTED_PROXIES_ENV)
    expect(trustedProxiesBootWarning('hub.example.com', GATEWAY_SUBNET), 'list set').toBe(null)
    expect(trustedProxiesBootWarning(undefined, NO_TRUSTED_PROXIES), 'no public address').toBe(null)
    for (const loop of ['127.0.0.1:8443', 'localhost', '[::1]:9']) {
      expect(trustedProxiesBootWarning(loop, NO_TRUSTED_PROXIES), `loopback ${loop}`).toBe(null)
    }
  })

  test('the variable is infra-scoped and cleared before a parent spawns a hub', () => {
    expect(HUB_TRUSTED_PROXIES_ENV, 'name').toBe('SLAYZONE_HUB_TRUSTED_PROXIES')
    expect(ENV_MANIFEST[HUB_TRUSTED_PROXIES_ENV], 'manifest scope').toBe('infra')
    expect(HUB_PROCESS_ENV, 'in HUB_PROCESS_ENV').toContain(HUB_TRUSTED_PROXIES_ENV)
  })
})
