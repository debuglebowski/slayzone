/**
 * The hub's boot rules (B1–B5, B7–B11, B13, B14): one case per refusal, plus the
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
 *   B7 SSO ⇒ tenant + client id + secret · B11 login ⇒ auth database loads.
 * A leftover SLAYZONE_MODE is ignored: there is deliberately no rule for it.
 *
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/hub/src/boot-rules.test.ts
 */
import {
  assertAuthLoaded,
  assertHubBootRules,
  isHubReachable,
  peekHubReachability,
  type HubBootInput
} from './boot-rules.js'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

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
  assert(msg !== null, `expected boot to be refused, but it booted (${JSON.stringify(input.env)})`)
  for (const n of needles) assert(msg.includes(n), `message should mention '${n}', got: ${msg}`)
}

function assertBoots(input: Partial<HubBootInput> & { env?: NodeJS.ProcessEnv }): void {
  const msg = refusal(input)
  assert(msg === null, `expected boot to succeed, but it was refused: ${msg}`)
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
  assert(settings.switches.requireLogin === false, 'login not required')
  assert(settings.switches.enablePassword === true, 'password on')
  assert(settings.switches.enableSso === false, 'SSO off')
  assert(settings.switches.enableProcesses === true, 'processes on')
  assert(settings.switches.enableIntegrations === true, 'integrations on')
  assert(settings.reachable === false, 'a default hub is reachable only from this machine')
  assert(settings.publicAddress === undefined, 'no public address')
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
  assert(msg !== null, 'refused')
  assert(/connects to/.test(msg), `says it is now the dial-side name: ${msg}`)
  assert(/task terminal/.test(msg), `names the inherited-from-a-terminal cause: ${msg}`)
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
  assert(msg !== null && !msg.includes('SLAYZONE_SUPERVISED'), `not a B9 message: ${msg}`)
})

console.log('\nhub boot rules: B13 — reachable from other machines')
console.log('─'.repeat(40))

test('B13: reachable = non-loopback listen address OR a public address', () => {
  assert(isHubReachable('127.0.0.1', undefined) === false, 'loopback only')
  assert(isHubReachable('localhost', undefined) === false, 'localhost only')
  assert(isHubReachable('::1', undefined) === false, '::1 only')
  assert(isHubReachable('0.0.0.0', undefined) === true, 'wildcard listen')
  assert(isHubReachable('10.0.0.5', undefined) === true, 'LAN address')
  assert(isHubReachable('::', undefined) === true, 'ipv6 wildcard')
  assert(isHubReachable('127.0.0.1', 'hub.example.com') === true, 'loopback behind a proxy')
})

test('B13: peekHubReachability reads the same answer from env', () => {
  assert(peekHubReachability({}) === false, 'defaults')
  assert(peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:8080' }) === true, 'listen')
  assert(peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:8080' }) === false, 'loop')
  assert(peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: '[::1]:8080' }) === false, '[::1]')
  assert(peekHubReachability({ SLAYZONE_HUB_PUBLIC_ADDRESS: 'h.example' }) === true, 'public')
  assert(peekHubReachability({ SLAYZONE_HUB_PUBLIC_ADDRESS: '  ' }) === false, 'blank public')
  assert(
    peekHubReachability({ SLAYZONE_HUB_LISTEN_ADDRESS: 'not an address' }) === false,
    'a malformed listen address falls back to loopback, as getServerHost does'
  )
})

test('B13: the verdict is in the settings boot returns', () => {
  const s = assertHubBootRules({
    env: REACHABLE,
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  assert(s.reachable === true, 'loopback + public address is reachable')
  assert(s.publicAddress === 'hub.example.com', 'public address returned trimmed')
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
  assertRefuses({ host: OFF_LOOPBACK, env: noSecret }, 'SLAYZONE_HUB_AUTH_SECRET', 'environment')
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
      SLAYZONE_HUB_SSO_TENANT_ID: 't',
      SLAYZONE_HUB_SSO_CLIENT_ID: 'c',
      SLAYZONE_HUB_SSO_CLIENT_SECRET: 's'
    }
  })
})

test('B2 only applies when login is required: password + SSO both off with login off boots', () => {
  assertBoots({ env: { SLAYZONE_HUB_ENABLE_PASSWORD: '0', SLAYZONE_HUB_ENABLE_SSO: '0' } })
})

console.log('\nhub boot rules: B7 — SSO ⇒ tenant, client id and client secret')
console.log('─'.repeat(40))

const SSO_ON = { SLAYZONE_HUB_REQUIRE_LOGIN: '1', SLAYZONE_HUB_ENABLE_SSO: '1' }
const SSO_FULL = {
  SLAYZONE_HUB_SSO_TENANT_ID: 'tenant',
  SLAYZONE_HUB_SSO_CLIENT_ID: 'client',
  SLAYZONE_HUB_SSO_CLIENT_SECRET: 'secret'
}

test('B7: SSO on with nothing configured refuses boot and lists all three', () => {
  assertRefuses(
    { env: SSO_ON },
    'SLAYZONE_HUB_ENABLE_SSO=1',
    'SLAYZONE_HUB_SSO_TENANT_ID',
    'SLAYZONE_HUB_SSO_CLIENT_ID',
    'SLAYZONE_HUB_SSO_CLIENT_SECRET'
  )
})

for (const missing of Object.keys(SSO_FULL)) {
  test(`B7: SSO on without ${missing} refuses boot, naming it`, () => {
    const env: NodeJS.ProcessEnv = { ...SSO_ON, ...SSO_FULL }
    delete env[missing]
    const msg = refusal({ env })
    assert(msg !== null && msg.includes(missing), `names ${missing}: ${msg}`)
    for (const other of Object.keys(SSO_FULL).filter((k) => k !== missing)) {
      assert(!msg.includes(other), `does not blame ${other}: ${msg}`)
    }
  })
}

test('B7: a blank value counts as missing', () => {
  assertRefuses(
    { env: { ...SSO_ON, ...SSO_FULL, SLAYZONE_HUB_SSO_CLIENT_SECRET: '   ' } },
    'SLAYZONE_HUB_SSO_CLIENT_SECRET'
  )
})

test('B7: SSO on with all three set boots, and the secret is returned for later use', () => {
  const s = assertHubBootRules({
    env: { ...SSO_ON, ...SSO_FULL },
    host: '127.0.0.1',
    supervised: false,
    devSqlEnabled: false
  })
  assert(s.sso.tenantId === 'tenant' && s.sso.clientId === 'client', 'ids read')
  assert(s.sso.clientSecret === 'secret', 'secret read')
})

test('B7 only applies when login is required: SSO on, login off, nothing set → boots', () => {
  assertBoots({ env: { SLAYZONE_HUB_ENABLE_SSO: '1' } })
})

test('B7: the refusal never prints the secret value', () => {
  const msg = refusal({
    env: { ...SSO_ON, SLAYZONE_HUB_SSO_CLIENT_SECRET: 'very-secret-value' }
  })
  assert(msg !== null && !msg.includes('very-secret-value'), `secret not echoed: ${msg}`)
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
  assert(s.switches.requireLogin && !s.switches.enablePassword && s.switches.enableSso, 'login')
  assert(!s.switches.enableProcesses && !s.switches.enableIntegrations, 'nothing runs on the hub')
  assert(s.reachable, 'reachable')
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
  assert(msg.includes('SLAYZONE_HUB_REQUIRE_LOGIN=1') && /failed to initialize/.test(msg), msg)
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
  assert(threw, 'login on ⇒ required, regardless of who started the hub')
  assertAuthLoaded(false, null)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
