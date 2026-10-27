/**
 * The hub's boot rules (B1–B5, B7–B11, B13–B17): one case per refusal, plus the
 * combinations that must boot. Pure — `assertHubBootRules` takes an env object and
 * returns/throws, with no database, port or process — so every rule is checked
 * without a boot. `hub-boot.test.ts` drives the same rules through the real
 * `startServer` and the built bin.
 *
 * Rule numbers are the plan's (`Plan/slayzone-modes.html`, tab Rules):
 *   B4 every switch is 0|1 · B5 the hub never reads the old SLAYZONE_HUB_ADDRESS ·
 *   B8 public address is host[:port] · B9 desktop-app hub listens on loopback ·
 *   B13 "reachable from other machines" = non-loopback listen OR public address set ·
 *   B1 reachable ⇒ login · B3 reachable ⇒ public address · B10 reachable ⇒ no raw-SQL
 *   dev endpoint · B14 reachable ⇒ auth secret in env · B2 login ⇒ password or SSO ·
 *   B7 SSO ⇒ tenant + client id (GUIDs) + certificate + public address, no client
 *   secret, and the certificate loads · B11 login ⇒ auth database loads ·
 *   B17 reachable ⇒ the env secret matches one this hub generated earlier.
 * A leftover SLAYZONE_MODE is ignored: there is deliberately no rule for it.
 *
 * Pure Node.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { expect, test } from 'vitest'
import {
  assertAuthLoaded,
  assertHubBootRules,
  assertKeptAuthSecret,
  assertSsoCredential,
  bootRefusalRule,
  isHubReachable,
  peekHubReachability,
  type HubBootInput
} from './boot-rules.js'

/** What boot throws, as a message — or null when it boots. */
function refusal(input: Partial<HubBootInput> & { env?: NodeJS.ProcessEnv }): string | null {
  try {
    assertHubBootRules({
      env: {},
      host: '127.0.0.1',
      supervised: false,
      devSqlEnabled: false,
      ...input
    })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Assert boot refuses and the message contains every `needle`. */
function assertRefuses(
  input: Partial<HubBootInput> & { env?: NodeJS.ProcessEnv },
  ...needles: string[]
): void {
  const msg = refusal(input)
  expect(
    msg,
    `expected boot to be refused, but it booted (${JSON.stringify(input.env)})`
  ).not.toBeNull()
  for (const n of needles) expect(msg, `message should mention '${n}'`).toContain(n)
}

function assertBoots(input: Partial<HubBootInput> & { env?: NodeJS.ProcessEnv }): void {
  const msg = refusal(input)
  expect(msg, 'expected boot to succeed, but it was refused').toBeNull()
}

/** A complete, valid configuration for a hub other machines can reach. */
const REACHABLE = {
  SLAYZONE_HUB_REQUIRE_LOGIN: '1',
  SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
  SLAYZONE_HUB_AUTH_SECRET: 'a-long-random-secret'
}
const OFF_LOOPBACK = '0.0.0.0'

console.log('\nhub boot rules: defaults')
console.log('─'.repeat(40))

test('defaults boot on loopback: login off, password on, SSO off, processes + integrations on', () => {
  const settings = assertHubBootRules({
    env: {},
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  expect(settings.switches.requireLogin, 'login not required').toBe(false)
  expect(settings.switches.enablePassword, 'password on').toBe(true)
  expect(settings.switches.enableSso, 'SSO off').toBe(false)
  expect(settings.switches.enableProcesses, 'processes on').toBe(true)
  expect(settings.switches.enableIntegrations, 'integrations on').toBe(true)
  expect(settings.reachable, 'a default hub is reachable only from this machine').toBe(false)
  expect(settings.publicAddress, 'no public address').toBeUndefined()
})

test('every loopback host boots with defaults (127.0.0.1, localhost, ::1)', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assertBoots({ host })
})

test('the desktop app hub boots: supervised, loopback, login explicitly off', () => {
  assertBoots({ supervised: true, env: { SLAYZONE_HUB_REQUIRE_LOGIN: '0' } })
})

test('a leftover SLAYZONE_MODE is ignored — it can neither refuse nor relax anything', () => {
  for (const mode of ['remote', 'local', 'REMOTE', 'garbage', '']) {
    assertBoots({ env: { SLAYZONE_MODE: mode } })
  }
  // And it does not relax a rule either: remote-looking mode, still refused for B1.
  assertRefuses(
    {
      host: OFF_LOOPBACK,
      env: { SLAYZONE_MODE: 'local', SLAYZONE_HUB_PUBLIC_ADDRESS: 'h.example' }
    },
    'SLAYZONE_HUB_REQUIRE_LOGIN=1'
  )
})

console.log('\nhub boot rules: B4 — switches are 0 or 1')
console.log('─'.repeat(40))

for (const name of [
  'SLAYZONE_HUB_REQUIRE_LOGIN',
  'SLAYZONE_HUB_ENABLE_PASSWORD',
  'SLAYZONE_HUB_ENABLE_SSO',
  'SLAYZONE_HUB_ENABLE_PROCESSES',
  'SLAYZONE_HUB_ENABLE_INTEGRATIONS'
]) {
  test(`B4: ${name}=true / yes / 2 / blank refuses boot and names the variable`, () => {
    for (const bad of ['true', 'yes', '2', '', 'on']) {
      assertRefuses({ env: { [name]: bad } }, name, 'must be 0 or 1')
    }
  })
  test(`B4: ${name}=0 and =1 are accepted`, () => {
    // (Compatible with the other rules: nothing else is set, so a 0/1 here only
    // trips a rule if that rule is about this switch; use loopback + no login.)
    if (name !== 'SLAYZONE_HUB_REQUIRE_LOGIN') {
      assertBoots({ env: { [name]: '0' } })
      assertBoots({ env: { [name]: '1' } })
    } else {
      assertBoots({ env: { [name]: '0' } })
      assertBoots({ env: { [name]: '1' } }) // loopback + login, password on by default
    }
  })
}

test('B4 runs first: a bad switch is reported before the old-name rule', () => {
  assertRefuses(
    { env: { SLAYZONE_HUB_ENABLE_SSO: 'maybe', SLAYZONE_HUB_ADDRESS: '127.0.0.1:1' } },
    'SLAYZONE_HUB_ENABLE_SSO',
    'must be 0 or 1'
  )
})

console.log('\nhub boot rules: B5 — the old SLAYZONE_HUB_ADDRESS')
console.log('─'.repeat(40))

test('B5: SLAYZONE_HUB_ADDRESS on the hub refuses boot with a "renamed to …" message', () => {
  assertRefuses(
    { env: { SLAYZONE_HUB_ADDRESS: '127.0.0.1:51100' } },
    'SLAYZONE_HUB_ADDRESS was renamed to SLAYZONE_HUB_LISTEN_ADDRESS'
  )
})

test('B5: the message says what the old name means now, and the usual cause', () => {
  const msg = refusal({ env: { SLAYZONE_HUB_ADDRESS: '0.0.0.0:8080' } })
  expect(msg, 'refused').not.toBeNull()
  expect(msg, `says it is now the dial-side name: ${msg}`).toMatch(/connects to/)
  expect(msg, `names the inherited-from-a-terminal cause: ${msg}`).toMatch(/task terminal/)
})

test('B5: it refuses whatever the value is, and even alongside the new name', () => {
  assertRefuses({ env: { SLAYZONE_HUB_ADDRESS: 'x' } }, 'renamed')
  assertRefuses(
    { env: { SLAYZONE_HUB_ADDRESS: '127.0.0.1:1', SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:2' } },
    'renamed'
  )
})

test('B5: a blank SLAYZONE_HUB_ADDRESS is treated as unset', () => {
  assertBoots({ env: { SLAYZONE_HUB_ADDRESS: '   ' } })
})

test('B5: SLAYZONE_HUB_LISTEN_ADDRESS (the new name) does not trip it', () => {
  assertBoots({ env: { SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:51100' } })
})

console.log('\nhub boot rules: B8 — the public address is host[:port]')
console.log('─'.repeat(40))

test('B8: a public address with a scheme refuses boot', () => {
  assertRefuses(
    { env: { ...REACHABLE, SLAYZONE_HUB_PUBLIC_ADDRESS: 'https://hub.example.com' } },
    'SLAYZONE_HUB_PUBLIC_ADDRESS',
    'no scheme'
  )
})

test('B8: a public address with a path refuses boot', () => {
  assertRefuses(
    { env: { ...REACHABLE, SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com/slayzone' } },
    'SLAYZONE_HUB_PUBLIC_ADDRESS',
    'no path'
  )
})

test('B8: also when nothing else would be wrong (loopback host, login off)', () => {
  assertRefuses({ env: { SLAYZONE_HUB_PUBLIC_ADDRESS: 'http://localhost:8443' } }, 'no scheme')
})

test('B8: host, host:port and bracketed ipv6 are accepted', () => {
  for (const ok of ['hub.example.com', 'hub.example.com:8443', '[2001:db8::1]:8443']) {
    assertBoots({ env: { ...REACHABLE, SLAYZONE_HUB_PUBLIC_ADDRESS: ok } })
  }
})

console.log('\nhub boot rules: B15 — the trusted front ends are IPs and CIDRs (T-22)')
console.log('─'.repeat(40))

test('B15: an entry that is not an IP or CIDR refuses boot, naming it', () => {
  assertRefuses(
    { env: { ...REACHABLE, SLAYZONE_HUB_TRUSTED_PROXIES: '10.93.4.0/24, appgw.internal' } },
    'SLAYZONE_HUB_TRUSTED_PROXIES',
    "'appgw.internal'"
  )
  assertRefuses({ env: { SLAYZONE_HUB_TRUSTED_PROXIES: '10.93.4.0/33' } }, "'10.93.4.0/33'")
})

test('B15: a /0 range refuses boot — it would let any client name its own address', () => {
  for (const bad of ['0.0.0.0/0', '::/0']) {
    assertRefuses({ env: { ...REACHABLE, SLAYZONE_HUB_TRUSTED_PROXIES: bad } }, '/0')
  }
})

test('B15: unset, blank, and IPv4/IPv6 addresses and ranges boot', () => {
  for (const ok of ['', ' , ', '10.93.4.0/24', '10.93.4.0/24, 10.93.5.7, 2001:db8::/64, ::1']) {
    assertBoots({ env: { ...REACHABLE, SLAYZONE_HUB_TRUSTED_PROXIES: ok } })
  }
  assertBoots({ env: { SLAYZONE_HUB_TRUSTED_PROXIES: '127.0.0.1' } })
})

console.log('\nhub boot rules: B9 — the desktop app hub listens on loopback')
console.log('─'.repeat(40))

test('B9: SLAYZONE_SUPERVISED=1 on a non-loopback listen address refuses boot', () => {
  assertRefuses(
    { supervised: true, host: OFF_LOOPBACK },
    'SLAYZONE_SUPERVISED',
    '0.0.0.0',
    'loopback'
  )
})

test('B9: the ipv6 wildcard is not loopback either', () => {
  assertRefuses({ supervised: true, host: '::' }, 'SLAYZONE_SUPERVISED')
})

test('B9: supervised on 127.0.0.1 / localhost / ::1 is fine', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assertBoots({ supervised: true, host })
})

test('B9 does not apply to a hub that was not started by the app', () => {
  // (It still hits B1/B3 below — but not B9.)
  const msg = refusal({ supervised: false, host: OFF_LOOPBACK })
  expect(msg, `not a B9 message: ${msg}`).not.toBeNull()
  expect(msg, `not a B9 message: ${msg}`).not.toContain('SLAYZONE_SUPERVISED')
})

console.log('\nhub boot rules: B13 — reachable from other machines')
console.log('─'.repeat(40))

test('B13: reachable = non-loopback listen address OR a public address', () => {
  expect(isHubReachable('127.0.0.1', undefined), 'loopback only').toBe(false)
  expect(isHubReachable('localhost', undefined), 'localhost only').toBe(false)
  expect(isHubReachable('::1', undefined), '::1 only').toBe(false)
  expect(isHubReachable('0.0.0.0', undefined), 'wildcard listen').toBe(true)
  expect(isHubReachable('10.0.0.5', undefined), 'LAN address').toBe(true)
  expect(isHubReachable('::', undefined), 'ipv6 wildcard').toBe(true)
  expect(isHubReachable('127.0.0.1', 'hub.example.com'), 'loopback behind a proxy').toBe(true)
})

test('B13: peekHubReachability reads the same answer from env', () => {
  expect(peekHubReachability({}), 'defaults').toBe(false)
  expect(peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:8080' }), 'listen').toBe(true)
  expect(peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:8080' }), 'loop').toBe(false)
  expect(peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: '[::1]:8080' }), '[::1]').toBe(false)
  expect(peekHubReachability({ SLAYZONE_HUB_PUBLIC_ADDRESS: 'h.example' }), 'public').toBe(true)
  expect(peekHubReachability({ SLAYZONE_HUB_PUBLIC_ADDRESS: '  ' }), 'blank public').toBe(false)
  expect(
    peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: 'not an address' }),
    'a malformed listen address falls back to loopback, as getServerHost does'
  ).toBe(false)
})

test('B13: the verdict is in the settings boot returns', () => {
  const s = assertHubBootRules({
    env: REACHABLE,
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  expect(s.reachable, 'loopback + public address is reachable').toBe(true)
  expect(s.publicAddress, 'public address returned trimmed').toBe('hub.example.com')
})

console.log('\nhub boot rules: B1 — reachable ⇒ login required')
console.log('─'.repeat(40))

test('B1: a non-loopback listen address with login off refuses boot', () => {
  assertRefuses(
    { host: OFF_LOOPBACK, env: { SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com' } },
    'SLAYZONE_HUB_REQUIRE_LOGIN=1',
    'listens on 0.0.0.0'
  )
})

test('B1: a PUBLIC ADDRESS on a loopback hub (a same-box reverse proxy) needs login too', () => {
  assertRefuses(
    { host: '127.0.0.1', env: { SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com' } },
    'SLAYZONE_HUB_REQUIRE_LOGIN=1',
    'SLAYZONE_HUB_PUBLIC_ADDRESS is set'
  )
})

test('B1: an explicit REQUIRE_LOGIN=0 does not get around it', () => {
  assertRefuses(
    {
      host: OFF_LOOPBACK,
      env: { SLAYZONE_HUB_REQUIRE_LOGIN: '0', SLAYZONE_HUB_PUBLIC_ADDRESS: 'h.example' }
    },
    'SLAYZONE_HUB_REQUIRE_LOGIN=1'
  )
})

test('B1: the desktop-app hub cannot be given a public address with login off', () => {
  assertRefuses(
    {
      supervised: true,
      env: { SLAYZONE_HUB_REQUIRE_LOGIN: '0', SLAYZONE_HUB_PUBLIC_ADDRESS: 'h.example' }
    },
    'SLAYZONE_HUB_REQUIRE_LOGIN=1'
  )
})

test('B1: a loopback hub with no public address may keep login off (the default)', () => {
  assertBoots({ env: { SLAYZONE_HUB_REQUIRE_LOGIN: '0' } })
})

console.log('\nhub boot rules: B3 — reachable ⇒ public address set')
console.log('─'.repeat(40))

test('B3: a non-loopback listen address with no public address refuses boot', () => {
  assertRefuses(
    { host: OFF_LOOPBACK, env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1' } },
    'SLAYZONE_HUB_PUBLIC_ADDRESS is required',
    '0.0.0.0'
  )
})

test('B3: a blank public address counts as unset', () => {
  assertRefuses(
    {
      host: OFF_LOOPBACK,
      env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_PUBLIC_ADDRESS: '  ' }
    },
    'SLAYZONE_HUB_PUBLIC_ADDRESS is required'
  )
})

test('B3: with login on and a public address a non-loopback listen address boots', () => {
  assertBoots({ host: OFF_LOOPBACK, env: REACHABLE })
})

console.log('\nhub boot rules: B10 — reachable ⇒ no raw-SQL dev endpoint')
console.log('─'.repeat(40))

test('B10: PLAYWRIGHT=1 on a hub listening off-loopback refuses boot', () => {
  assertRefuses(
    { host: OFF_LOOPBACK, devSqlEnabled: true, env: REACHABLE },
    'PLAYWRIGHT=1',
    'raw-SQL'
  )
})

test('B10: PLAYWRIGHT=1 on a loopback hub behind a public address refuses boot (B13)', () => {
  assertRefuses({ host: '127.0.0.1', devSqlEnabled: true, env: REACHABLE }, 'PLAYWRIGHT=1')
})

test('B10: PLAYWRIGHT=1 on a loopback-only hub is allowed (e2e inherits it)', () => {
  assertBoots({ devSqlEnabled: true })
  assertBoots({ devSqlEnabled: true, env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1' } })
})

test('B10: a reachable hub without PLAYWRIGHT boots', () => {
  assertBoots({ host: OFF_LOOPBACK, devSqlEnabled: false, env: REACHABLE })
})

console.log('\nhub boot rules: B14 — reachable ⇒ auth secret in env')
console.log('─'.repeat(40))

test('B14: a reachable hub with no SLAYZONE_HUB_AUTH_SECRET refuses boot', () => {
  const { SLAYZONE_HUB_AUTH_SECRET: _drop, ...noSecret } = REACHABLE
  // The fix an operator reaches for must not be "generate a new one" on a hub that
  // already has sessions and enrolled computers: that signs everyone out.
  assertRefuses(
    { host: OFF_LOOPBACK, env: noSecret },
    'SLAYZONE_HUB_AUTH_SECRET',
    'environment',
    'computerTransportSecret',
    'hub.state.json',
    'NEW hub'
  )
})

test('B14: a blank secret counts as missing', () => {
  assertRefuses(
    { host: OFF_LOOPBACK, env: { ...REACHABLE, SLAYZONE_HUB_AUTH_SECRET: '   ' } },
    'SLAYZONE_HUB_AUTH_SECRET'
  )
})

test('B14: also for a loopback hub behind a public address', () => {
  const { SLAYZONE_HUB_AUTH_SECRET: _drop, ...noSecret } = REACHABLE
  assertRefuses({ host: '127.0.0.1', env: noSecret }, 'SLAYZONE_HUB_AUTH_SECRET')
})

test('B14: a loopback-only hub does NOT need the secret in env (it may generate one)', () => {
  assertBoots({ env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1' } })
})

test('B14: with the secret set a reachable hub boots', () => {
  assertBoots({ host: OFF_LOOPBACK, env: REACHABLE })
})

console.log('\nhub boot rules: B2 — login ⇒ password or SSO')
console.log('─'.repeat(40))

test('B2: login on with password AND SSO off refuses boot', () => {
  assertRefuses(
    {
      env: {
        SLAYZONE_HUB_REQUIRE_LOGIN: '1',
        SLAYZONE_HUB_ENABLE_PASSWORD: '0',
        SLAYZONE_HUB_ENABLE_SSO: '0'
      }
    },
    'SLAYZONE_HUB_REQUIRE_LOGIN=1',
    'SLAYZONE_HUB_ENABLE_PASSWORD=0',
    'SLAYZONE_HUB_ENABLE_SSO=0'
  )
})

test('B2: password off + SSO unset (default off) refuses too', () => {
  assertRefuses(
    { env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_PASSWORD: '0' } },
    'nobody'
  )
})

test('B2: password only boots; SSO only (fully configured) boots', () => {
  assertBoots({ env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_PASSWORD: '1' } })
  assertBoots({
    env: {
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      SLAYZONE_HUB_ENABLE_PASSWORD: '0',
      SLAYZONE_HUB_ENABLE_SSO: '1',
      SLAYZONE_HUB_AUTH_SECRET: 'a-long-random-secret',
      SLAYZONE_HUB_SSO_TENANT_ID: '11111111-2222-3333-4444-555555555555',
      SLAYZONE_HUB_SSO_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      SLAYZONE_HUB_SSO_CERT_PATH: '/run/sso/cert.pem',
      SLAYZONE_HUB_SSO_KEY_PATH: '/run/sso/key.pem',
      SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com'
    }
  })
})

test('B2 only applies when login is required: password + SSO both off with login off boots', () => {
  assertBoots({ env: { SLAYZONE_HUB_ENABLE_PASSWORD: '0', SLAYZONE_HUB_ENABLE_SSO: '0' } })
})

console.log('\nhub boot rules: B7 — SSO ⇒ tenant, client id, certificate, public address')
console.log('─'.repeat(40))

const SSO_ON = {
  SLAYZONE_HUB_REQUIRE_LOGIN: '1',
  SLAYZONE_HUB_ENABLE_SSO: '1',
  SLAYZONE_HUB_AUTH_SECRET: 'a-long-random-secret'
}
const TENANT = '11111111-2222-3333-4444-555555555555'
const SSO_FULL = {
  SLAYZONE_HUB_SSO_TENANT_ID: TENANT,
  SLAYZONE_HUB_SSO_CLIENT_ID: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
  SLAYZONE_HUB_SSO_CERT_PATH: '/run/sso/cert.pem',
  SLAYZONE_HUB_SSO_KEY_PATH: '/run/sso/key.pem',
  SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com'
}

test('B7: SSO on with nothing configured refuses boot and lists all five', () => {
  assertRefuses(
    { env: SSO_ON },
    'SLAYZONE_HUB_ENABLE_SSO=1',
    'SLAYZONE_HUB_SSO_TENANT_ID',
    'SLAYZONE_HUB_SSO_CLIENT_ID',
    'SLAYZONE_HUB_SSO_CERT_PATH',
    'SLAYZONE_HUB_SSO_KEY_PATH',
    'SLAYZONE_HUB_PUBLIC_ADDRESS'
  )
})

for (const missing of Object.keys(SSO_FULL)) {
  test(`B7: SSO on without ${missing} refuses boot, naming it`, () => {
    const env: NodeJS.ProcessEnv = { ...SSO_ON, ...SSO_FULL }
    delete env[missing]
    const msg = refusal({ env })
    expect(msg, `names ${missing}: ${msg}`).not.toBeNull()
    expect(msg, `names ${missing}: ${msg}`).toContain(missing)
    for (const other of Object.keys(SSO_FULL).filter((k) => k !== missing)) {
      expect(msg, `does not blame ${other}: ${msg}`).not.toContain(other)
    }
  })
}

test('B7: a blank value counts as missing', () => {
  assertRefuses(
    { env: { ...SSO_ON, ...SSO_FULL, SLAYZONE_HUB_SSO_KEY_PATH: '   ' } },
    'SLAYZONE_HUB_SSO_KEY_PATH'
  )
})

test('B7: tenant and client id must be GUIDs (single tenant: no domain, no `common`)', () => {
  for (const tenant of ['normain.com', 'common', 'organizations']) {
    assertRefuses(
      { env: { ...SSO_ON, ...SSO_FULL, SLAYZONE_HUB_SSO_TENANT_ID: tenant } },
      'SLAYZONE_HUB_SSO_TENANT_ID must be a GUID',
      tenant
    )
  }
  assertRefuses(
    { env: { ...SSO_ON, ...SSO_FULL, SLAYZONE_HUB_SSO_CLIENT_ID: 'slayzone-hub' } },
    'SLAYZONE_HUB_SSO_CLIENT_ID must be a GUID'
  )
})

test('B7: a client secret refuses boot (certificate only), without echoing it', () => {
  const msg = refusal({
    env: { ...SSO_ON, ...SSO_FULL, SLAYZONE_HUB_SSO_CLIENT_SECRET: 'very-secret-value' }
  })
  expect(msg, `${msg}`).not.toBeNull()
  expect(msg, `${msg}`).toContain('SLAYZONE_HUB_SSO_CLIENT_SECRET is not used')
  expect(msg, `points at the certificate: ${msg}`).toContain('SLAYZONE_HUB_SSO_CERT_PATH')
  expect(msg, `secret not echoed: ${msg}`).not.toContain('very-secret-value')
})

test('B7: SSO on with everything set boots; Entra sign-in is active, MFA required by default', () => {
  const s = assertHubBootRules({
    env: { ...SSO_ON, ...SSO_FULL },
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  expect(s.ssoActive, 'ssoActive').toBeTruthy()
  expect(s.sso.tenantId, 'tenant read').toBe(TENANT)
  expect(s.sso.certPath, 'paths').toBe('/run/sso/cert.pem')
  expect(s.sso.keyPath, 'paths').toBe('/run/sso/key.pem')
  expect(s.sso.requireMfa, 'MFA required unless switched off').toBe(true)
})

test('B7: SLAYZONE_HUB_SSO_REQUIRE_MFA=0 turns the MFA check off; anything but 0|1 is B4', () => {
  const s = assertHubBootRules({
    env: { ...SSO_ON, ...SSO_FULL, SLAYZONE_HUB_SSO_REQUIRE_MFA: '0' },
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  expect(s.sso.requireMfa, 'off').toBe(false)
  let rule: string | null = null
  try {
    assertHubBootRules({
      env: { ...SSO_ON, ...SSO_FULL, SLAYZONE_HUB_SSO_REQUIRE_MFA: 'no' },
      host: '127.0.0.1',
      supervised: false,
      devSqlEnabled: false
    })
  } catch (e) {
    rule = bootRefusalRule(e)
  }
  expect(rule, `B4, got ${rule}`).toBe('B4')
})

test('B7 only applies when login is required: SSO on, login off, nothing set → boots, SSO inert', () => {
  assertBoots({ env: { SLAYZONE_HUB_ENABLE_SSO: '1' } })
  const s = assertHubBootRules({
    env: { SLAYZONE_HUB_ENABLE_SSO: '1' },
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  expect(s.ssoActive, 'not active without login').toBeFalsy()
})

test('the defaults: Entra sign-in is not active', () => {
  const s = assertHubBootRules({
    env: {},
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  expect(s.ssoActive, 'off').toBeFalsy()
})

console.log('\nhub boot rules: B7 — the certificate loads (assertSsoCredential)')
console.log('─'.repeat(40))

const ssoBoot = (env: NodeJS.ProcessEnv) =>
  assertHubBootRules({ env, host: '127.0.0.1', supervised: false, devSqlEnabled: false })

test('SSO off: nothing is loaded', () => {
  let called = false
  const out = assertSsoCredential(ssoBoot({}), () => {
    called = true
    return 'cred'
  })
  expect(out, 'no load').toBeNull()
  expect(called, 'no load').toBeFalsy()
})

test('SSO on: the loader gets both paths; ids come back lowercased with the credential', () => {
  let seen: { certPath: string; keyPath: string } | null = null
  const out = assertSsoCredential(ssoBoot({ ...SSO_ON, ...SSO_FULL }), (paths) => {
    seen = paths
    return 'cred'
  })
  expect(seen, 'loaded').not.toBeNull()
  expect(seen, 'paths').toEqual({ certPath: '/run/sso/cert.pem', keyPath: '/run/sso/key.pem' })
  expect(out?.credential, 'credential').toBe('cred')
  expect(out?.clientId, `lowercased: ${out?.clientId}`).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  expect(out?.tenantId, 'tenant + mfa').toBe(TENANT)
  expect(out?.requireMfa, 'tenant + mfa').toBe(true)
})

test('SSO on: a credential that does not load is a B7 refusal naming the variables', () => {
  let err: unknown
  try {
    assertSsoCredential(ssoBoot({ ...SSO_ON, ...SSO_FULL }), () => {
      throw new Error('cannot read the private key at /run/sso/key.pem (ENOENT)')
    })
  } catch (e) {
    err = e
  }
  expect(bootRefusalRule(err), `B7, got ${String(err)}`).toBe('B7')
  const msg = (err as Error).message
  expect(msg, msg).toContain('SLAYZONE_HUB_SSO_CERT_PATH / SLAYZONE_HUB_SSO_KEY_PATH')
  expect(msg, msg).toContain('/run/sso/key.pem (ENOENT)')
})

console.log('\nhub boot rules: the Normain profile')
console.log('─'.repeat(40))

test('login on, password off, SSO on, processes + integrations off, public host: boots', () => {
  const s = assertHubBootRules({
    env: {
      ...REACHABLE,
      ...SSO_FULL,
      SLAYZONE_HUB_ENABLE_PASSWORD: '0',
      SLAYZONE_HUB_ENABLE_SSO: '1',
      SLAYZONE_HUB_ENABLE_PROCESSES: '0',
      SLAYZONE_HUB_ENABLE_INTEGRATIONS: '0'
    },
    host: OFF_LOOPBACK,
    supervised: false,
    devSqlEnabled: false
  })
  expect(s.switches.requireLogin, 'login').toBeTruthy()
  expect(s.switches.enablePassword, 'login').toBeFalsy()
  expect(s.switches.enableSso, 'login').toBeTruthy()
  expect(s.switches.enableProcesses, 'nothing runs on the hub').toBeFalsy()
  expect(s.switches.enableIntegrations, 'nothing runs on the hub').toBeFalsy()
  expect(s.reachable, 'reachable').toBeTruthy()
  expect(s.ssoActive, 'Entra sign-in on, MFA required').toBeTruthy()
  expect(s.sso.requireMfa, 'Entra sign-in on, MFA required').toBeTruthy()
})

console.log('\nhub boot rules: B11 — login ⇒ the auth database loads')
console.log('─'.repeat(40))

test('B11: login required and no auth instance refuses boot (fail closed)', () => {
  let msg = ''
  try {
    assertAuthLoaded(true, null)
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e)
  }
  expect(msg, msg).toContain('SLAYZONE_HUB_REQUIRE_LOGIN=1')
  expect(msg, msg).toMatch(/failed to initialize/)
})

test('B11: login required and auth loaded boots', () => {
  assertAuthLoaded(true, {})
})

test('B11 does not apply when login is off: the hub boots without auth', () => {
  assertAuthLoaded(false, null)
})

test('B11 is keyed on the switch, not on being started by the desktop app', () => {
  // The old rule was `!supervised`. A hub started by the app with login ON must be
  // held to it; a standalone hub with login OFF must not be.
  let threw = false
  try {
    assertAuthLoaded(true, null)
  } catch {
    threw = true
  }
  expect(threw, 'login on ⇒ required, regardless of who started the hub').toBe(true)
  assertAuthLoaded(false, null)
})

console.log('\nhub boot rules: the rule a refusal names, for its audit line (T-03)')
console.log('─'.repeat(40))

/** The rule `bootRefusalRule` reads off what boot throws — null when it boots. */
function refusedRule(input: Partial<HubBootInput> & { env?: NodeJS.ProcessEnv }): string | null {
  try {
    assertHubBootRules({
      env: {},
      host: '127.0.0.1',
      supervised: false,
      devSqlEnabled: false,
      ...input
    })
    return null
  } catch (e) {
    return bootRefusalRule(e)
  }
}

test('every refusal carries its rule number', () => {
  const cases: Array<[string, Partial<HubBootInput> & { env?: NodeJS.ProcessEnv }]> = [
    ['B4', { env: { SLAYZONE_HUB_ENABLE_SSO: 'yes' } }],
    ['B5', { env: { SLAYZONE_HUB_ADDRESS: '127.0.0.1:1' } }],
    ['B8', { env: { SLAYZONE_HUB_PUBLIC_ADDRESS: 'https://h.example' } }],
    ['B9', { supervised: true, host: OFF_LOOPBACK }],
    ['B1', { host: OFF_LOOPBACK, env: { SLAYZONE_HUB_PUBLIC_ADDRESS: 'h.example' } }],
    ['B3', { host: OFF_LOOPBACK, env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1' } }],
    ['B10', { env: REACHABLE, devSqlEnabled: true }],
    ['B14', { env: { ...REACHABLE, SLAYZONE_HUB_AUTH_SECRET: '' } }],
    ['B2', { env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_PASSWORD: '0' } }],
    ['B7', { env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_SSO: '1' } }],
    ['B15', { env: { SLAYZONE_HUB_TRUSTED_PROXIES: 'nope' } }]
  ]
  for (const [rule, input] of cases) {
    const got = refusedRule(input)
    expect(got, `${rule}: expected that rule, got ${got}`).toBe(rule)
  }
  let b11: string | null = null
  try {
    assertAuthLoaded(true, null)
  } catch (e) {
    b11 = bootRefusalRule(e)
  }
  expect(b11, `B11: got ${b11}`).toBe('B11')
})

test('an error that is not a boot rule has no rule', () => {
  expect(bootRefusalRule(new Error('EADDRINUSE')), 'a plain error').toBeNull()
  expect(bootRefusalRule('boom'), 'a non-error').toBeNull()
})

console.log('\nB16: session retention period (T-23)')
console.log('─'.repeat(40))

test('B16: unset, 0 and whole numbers of days boot', () => {
  for (const v of [undefined, '0', '90', '365', '0090']) {
    assertBoots({ env: v === undefined ? {} : { SLAYZONE_HUB_SESSION_RETENTION_DAYS: v } })
  }
  // Also on a reachable hub with login — the shared hub that sets it.
  assertBoots({
    host: OFF_LOOPBACK,
    env: { ...REACHABLE, SLAYZONE_HUB_SESSION_RETENTION_DAYS: '90' }
  })
})

test('B16: anything that is not a non-negative whole number refuses boot, naming the value', () => {
  for (const v of [
    '',
    ' 90',
    '90 ',
    '-1',
    '1.5',
    '90d',
    'ninety',
    '1e3',
    '0x10',
    '99999999999999999'
  ]) {
    assertRefuses(
      { env: { SLAYZONE_HUB_SESSION_RETENTION_DAYS: v } },
      'SLAYZONE_HUB_SESSION_RETENTION_DAYS',
      `'${v}'`
    )
    expect(refusedRule({ env: { SLAYZONE_HUB_SESSION_RETENTION_DAYS: v } }), `'${v}' is B16`).toBe(
      'B16'
    )
  }
})

console.log('\nB17: a secret this hub generated earlier (T-11)')

const KEPT = 'kept-secret-0123456789abcdef0123456789abcdef'
const KEPT_PATH = '/srv/hub/hub.state.json'
const kept = (over: Partial<Parameters<typeof assertKeptAuthSecret>[0]>) =>
  assertKeptAuthSecret({
    reachable: true,
    envSecret: KEPT,
    kept: KEPT,
    keptPath: KEPT_PATH,
    ...over
  })

test('B17: the same secret in env boots and reports the kept file', () => {
  expect(kept({}), 'same value → kept').toBe('kept')
})

test('B17: nothing to compare boots — no kept secret, or not reachable', () => {
  expect(kept({ kept: undefined }), 'no kept secret').toBe('none')
  expect(kept({ reachable: false, envSecret: 'other' }), 'loopback: never compared').toBe('none')
})

test('B17: a different secret refuses boot, naming the file and both ways out, never a value', () => {
  let err: unknown = null
  try {
    kept({ envSecret: 'a-different-env-secret-0123456789abcdef' })
  } catch (e) {
    err = e
  }
  expect(bootRefusalRule(err), `B17, got ${String(err)}`).toBe('B17')
  const message = err instanceof Error ? err.message : ''
  for (const needle of ['SLAYZONE_HUB_AUTH_SECRET', KEPT_PATH, 'delete the file']) {
    expect(message, `mentions ${needle}: ${message}`).toContain(needle)
  }
  expect(message, 'the kept secret is not in the message').not.toContain(KEPT)
  expect(message, 'the env secret is not in the message').not.toContain('a-different-env-secret')
})

test('B17: compares the raw value — a trailing newline is a different secret', () => {
  let rule: string | null = null
  try {
    kept({ envSecret: `${KEPT}\n` })
  } catch (e) {
    rule = bootRefusalRule(e)
  }
  expect(rule, `B17, got ${rule}`).toBe('B17')
})
