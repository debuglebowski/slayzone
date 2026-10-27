/**
 * The per-hub switches (B4): `0|1` only, defaults = the desktop app's hub.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/hub-switches.test.ts
 */
import { expect, test } from 'vitest'
import { ENV_MANIFEST } from './env-manifest'
import {
  HUB_ALLOWED_WEB_ORIGINS_ENV,
  HUB_PROCESS_ENV,
  HUB_SWITCH_DEFAULTS,
  HUB_SWITCH_ENV,
  HubSwitchValueError,
  isHubLoginRequired,
  parseSwitchValue,
  resolveHubSso,
  resolveHubSwitches
} from './hub-switches'

function throwsWith(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

// --- defaults = the desktop app's hub ---
const defaults = resolveHubSwitches({})
test('default: login not required', () => {
  expect(defaults.requireLogin).toBe(false)
})

test('default: password on', () => {
  expect(defaults.enablePassword).toBe(true)
})

test('default: SSO off', () => {
  expect(defaults.enableSso).toBe(false)
})

test('default: processes on', () => {
  expect(defaults.enableProcesses).toBe(true)
})

test('default: integrations on', () => {
  expect(defaults.enableIntegrations).toBe(true)
})

test('defaults equal HUB_SWITCH_DEFAULTS', () => {
  expect(JSON.stringify(defaults)).toBe(JSON.stringify(HUB_SWITCH_DEFAULTS))
})

// --- env names ---
test('env name: REQUIRE_LOGIN', () => {
  expect(HUB_SWITCH_ENV.requireLogin).toBe('SLAYZONE_HUB_REQUIRE_LOGIN')
})

test('env name: ENABLE_PASSWORD', () => {
  expect(HUB_SWITCH_ENV.enablePassword).toBe('SLAYZONE_HUB_ENABLE_PASSWORD')
})

test('env name: ENABLE_SSO', () => {
  expect(HUB_SWITCH_ENV.enableSso).toBe('SLAYZONE_HUB_ENABLE_SSO')
})

test('env name: ENABLE_PROCESSES', () => {
  expect(HUB_SWITCH_ENV.enableProcesses).toBe('SLAYZONE_HUB_ENABLE_PROCESSES')
})

test('env name: ENABLE_INTEGRATIONS', () => {
  expect(HUB_SWITCH_ENV.enableIntegrations).toBe('SLAYZONE_HUB_ENABLE_INTEGRATIONS')
})

// --- 1 / 0 flip each switch ---
{
  const on = resolveHubSwitches({
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_ENABLE_PASSWORD: '0',
    SLAYZONE_HUB_ENABLE_SSO: '1',
    SLAYZONE_HUB_ENABLE_PROCESSES: '0',
    SLAYZONE_HUB_ENABLE_INTEGRATIONS: '0'
  })

  test('1 turns requireLogin on', () => {
    expect(on.requireLogin).toBe(true)
  })

  test('0 turns enablePassword off', () => {
    expect(on.enablePassword).toBe(false)
  })

  test('1 turns enableSso on', () => {
    expect(on.enableSso).toBe(true)
  })

  test('0 turns enableProcesses off', () => {
    expect(on.enableProcesses).toBe(false)
  })

  test('0 turns enableIntegrations off', () => {
    expect(on.enableIntegrations).toBe(false)
  })
}

// --- B4: anything but exactly 0 / 1 refuses, naming the variable ---
for (const key of Object.keys(HUB_SWITCH_ENV) as Array<keyof typeof HUB_SWITCH_ENV>) {
  const name = HUB_SWITCH_ENV[key]
  for (const bad of [
    'true',
    'false',
    'yes',
    'no',
    'on',
    'off',
    '2',
    '-1',
    '01',
    ' 1',
    '1 ',
    'TRUE',
    ''
  ]) {
    const msg = throwsWith(() => resolveHubSwitches({ [name]: bad }))
    test(`B4: ${name}='${bad}' refuses boot and names the variable`, () => {
      expect(msg, String(msg)).not.toBeNull()
      expect(msg, String(msg)).toContain(name)
      expect(msg, String(msg)).toMatch(/must be 0 or 1/)
    })
  }
}
{
  let err: unknown
  try {
    resolveHubSwitches({ SLAYZONE_HUB_ENABLE_SSO: 'maybe' })
  } catch (e) {
    err = e
  }
  test('B4: the error is a HubSwitchValueError carrying variable + value', () => {
    expect(err).toBeInstanceOf(HubSwitchValueError)
    expect(err).toMatchObject({ variable: 'SLAYZONE_HUB_ENABLE_SSO', value: 'maybe' })
  })
}
test('parseSwitchValue: unset → undefined', () => {
  expect(parseSwitchValue('X', undefined)).toBeUndefined()
})

// --- isHubLoginRequired is lenient (it runs inside an already-validated hub) ---
test('isHubLoginRequired: =1 → true', () => {
  expect(isHubLoginRequired({ SLAYZONE_HUB_REQUIRE_LOGIN: '1' })).toBe(true)
})

test('isHubLoginRequired: =0 → false', () => {
  expect(isHubLoginRequired({ SLAYZONE_HUB_REQUIRE_LOGIN: '0' })).toBeFalsy()
})

test('isHubLoginRequired: unset → false', () => {
  expect(isHubLoginRequired({})).toBeFalsy()
})

test('isHubLoginRequired: garbage → false (does not throw)', () => {
  expect(isHubLoginRequired({ SLAYZONE_HUB_REQUIRE_LOGIN: 'garbage' })).toBeFalsy()
})

// --- SSO settings: blank = unset; MFA required unless exactly 0 ---
{
  const none = resolveHubSso({})
  test('sso: nothing set → empty, MFA required', () => {
    expect(none.tenantId).toBeFalsy()
    expect(none.clientId).toBeFalsy()
    expect(none.certPath).toBeFalsy()
    expect(none.keyPath).toBeFalsy()
    expect(none.requireMfa).toBeTruthy()
  })
  const blank = resolveHubSso({
    SLAYZONE_HUB_SSO_TENANT_ID: '  ',
    SLAYZONE_HUB_SSO_CLIENT_ID: '',
    SLAYZONE_HUB_SSO_CERT_PATH: ' ',
    SLAYZONE_HUB_SSO_KEY_PATH: ''
  })

  test('sso: blank values count as unset', () => {
    expect(blank.tenantId).toBeFalsy()
    expect(blank.clientId).toBeFalsy()
    expect(blank.certPath).toBeFalsy()
    expect(blank.keyPath).toBeFalsy()
  })
  const full = resolveHubSso({
    SLAYZONE_HUB_SSO_TENANT_ID: 't',
    SLAYZONE_HUB_SSO_CLIENT_ID: 'c',
    SLAYZONE_HUB_SSO_CERT_PATH: '/c.pem',
    SLAYZONE_HUB_SSO_KEY_PATH: '/k.pem',
    SLAYZONE_HUB_SSO_REQUIRE_MFA: '0'
  })

  test('sso: all read', () => {
    expect(full.tenantId).toBe('t')
    expect(full.clientId).toBe('c')
    expect(full.certPath).toBe('/c.pem')
    expect(full.keyPath).toBe('/k.pem')
    expect(full.requireMfa).toBe(false)
  })

  test('sso: the retired client secret is not read', () => {
    expect('clientSecret' in resolveHubSso({ SLAYZONE_HUB_SSO_CLIENT_SECRET: 's' })).toBeFalsy()
  })
  let threw: unknown = null
  try {
    resolveHubSso({ SLAYZONE_HUB_SSO_REQUIRE_MFA: 'yes' })
  } catch (e) {
    threw = e
  }
  test('sso: REQUIRE_MFA other than 0|1 throws (B4)', () => {
    expect(threw).toBeInstanceOf(HubSwitchValueError)
  })
}

// --- HUB_PROCESS_ENV: everything a parent must clear before spawning a hub ---
{
  const list = new Set(HUB_PROCESS_ENV)
  test('process env: no duplicates', () => {
    expect(list.size).toBe(HUB_PROCESS_ENV.length)
  })

  test('process env: every switch, SSO var and address var', () => {
    expect([
      ...Object.values(HUB_SWITCH_ENV),
      'SLAYZONE_HUB_SSO_TENANT_ID',
      'SLAYZONE_HUB_SSO_CLIENT_ID',
      'SLAYZONE_HUB_SSO_CERT_PATH',
      'SLAYZONE_HUB_SSO_KEY_PATH',
      'SLAYZONE_HUB_SSO_REQUIRE_MFA',
      // Retired, but a parent still clears it.
      'SLAYZONE_HUB_SSO_CLIENT_SECRET',
      'SLAYZONE_HUB_LISTEN_ADDRESS',
      'SLAYZONE_HUB_PUBLIC_ADDRESS',
      'SLAYZONE_HUB_AUTH_SECRET'
    ].every((n) => list.has(n))).toBe(true)
  })

  test('process env: the retired/dial-side address and the web-origin list', () => {
    expect(list.has('SLAYZONE_HUB_ADDRESS')).toBe(true)
    expect(list.has(HUB_ALLOWED_WEB_ORIGINS_ENV)).toBe(true)
  })
  // Drift guard: a hub-side SLAYZONE_HUB_* var added to the manifest but not to the
  // list would slip past every parent that strips with it. The few that are NOT hub
  // process config are named here, with the reason.
  const NOT_HUB_PROCESS_CONFIG: Record<string, string> = {
    SLAYZONE_HUB_TOKEN: 'a bearer a client PRESENTS to a hub, not config of the hub',
    SLAYZONE_HUB_JOIN_TOKEN: 'a computer redeems it; the hub only mints it',
    SLAYZONE_HUB_NAME: 'identifies the hub to operators; set per service unit'
  }
  const missing = Object.keys(ENV_MANIFEST).filter(
    (k) => k.startsWith('SLAYZONE_HUB_') && !list.has(k) && !(k in NOT_HUB_PROCESS_CONFIG)
  )
  test('process env: every manifested SLAYZONE_HUB_* var is in the list or named as an exception', () => {
    expect(missing).toEqual([])
  })

  test('process env: the exceptions really are in the manifest (no stale allowance)', () => {
    expect(Object.keys(NOT_HUB_PROCESS_CONFIG).every((k) => k in ENV_MANIFEST)).toBe(true)
  })
}

