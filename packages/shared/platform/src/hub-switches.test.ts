/**
 * The per-hub switches (B4): `0|1` only, defaults = the desktop app's hub.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/hub-switches.test.ts
 */
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
check('default: login not required', defaults.requireLogin === false)
check('default: password on', defaults.enablePassword === true)
check('default: SSO off', defaults.enableSso === false)
check('default: processes on', defaults.enableProcesses === true)
check('default: integrations on', defaults.enableIntegrations === true)
check(
  'defaults equal HUB_SWITCH_DEFAULTS',
  JSON.stringify(defaults) === JSON.stringify(HUB_SWITCH_DEFAULTS)
)

// --- env names ---
check('env name: REQUIRE_LOGIN', HUB_SWITCH_ENV.requireLogin === 'SLAYZONE_HUB_REQUIRE_LOGIN')
check('env name: ENABLE_PASSWORD', HUB_SWITCH_ENV.enablePassword === 'SLAYZONE_HUB_ENABLE_PASSWORD')
check('env name: ENABLE_SSO', HUB_SWITCH_ENV.enableSso === 'SLAYZONE_HUB_ENABLE_SSO')
check(
  'env name: ENABLE_PROCESSES',
  HUB_SWITCH_ENV.enableProcesses === 'SLAYZONE_HUB_ENABLE_PROCESSES'
)
check(
  'env name: ENABLE_INTEGRATIONS',
  HUB_SWITCH_ENV.enableIntegrations === 'SLAYZONE_HUB_ENABLE_INTEGRATIONS'
)

// --- 1 / 0 flip each switch ---
{
  const on = resolveHubSwitches({
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_ENABLE_PASSWORD: '0',
    SLAYZONE_HUB_ENABLE_SSO: '1',
    SLAYZONE_HUB_ENABLE_PROCESSES: '0',
    SLAYZONE_HUB_ENABLE_INTEGRATIONS: '0'
  })
  check('1 turns requireLogin on', on.requireLogin === true)
  check('0 turns enablePassword off', on.enablePassword === false)
  check('1 turns enableSso on', on.enableSso === true)
  check('0 turns enableProcesses off', on.enableProcesses === false)
  check('0 turns enableIntegrations off', on.enableIntegrations === false)
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
    check(
      `B4: ${name}='${bad}' refuses boot and names the variable`,
      msg !== null && msg.includes(name) && /must be 0 or 1/.test(msg),
      String(msg)
    )
  }
}
{
  let err: unknown
  try {
    resolveHubSwitches({ SLAYZONE_HUB_ENABLE_SSO: 'maybe' })
  } catch (e) {
    err = e
  }
  check(
    'B4: the error is a HubSwitchValueError carrying variable + value',
    err instanceof HubSwitchValueError &&
      err.variable === 'SLAYZONE_HUB_ENABLE_SSO' &&
      err.value === 'maybe'
  )
}
check('parseSwitchValue: unset → undefined', parseSwitchValue('X', undefined) === undefined)

// --- isHubLoginRequired is lenient (it runs inside an already-validated hub) ---
check('isHubLoginRequired: =1 → true', isHubLoginRequired({ SLAYZONE_HUB_REQUIRE_LOGIN: '1' }))
check('isHubLoginRequired: =0 → false', !isHubLoginRequired({ SLAYZONE_HUB_REQUIRE_LOGIN: '0' }))
check('isHubLoginRequired: unset → false', !isHubLoginRequired({}))
check(
  'isHubLoginRequired: garbage → false (does not throw)',
  !isHubLoginRequired({ SLAYZONE_HUB_REQUIRE_LOGIN: 'garbage' })
)

// --- SSO settings: blank = unset; MFA required unless exactly 0 ---
{
  const none = resolveHubSso({})
  check(
    'sso: nothing set → empty, MFA required',
    !none.tenantId && !none.clientId && !none.certPath && !none.keyPath && none.requireMfa
  )
  const blank = resolveHubSso({
    SLAYZONE_HUB_SSO_TENANT_ID: '  ',
    SLAYZONE_HUB_SSO_CLIENT_ID: '',
    SLAYZONE_HUB_SSO_CERT_PATH: ' ',
    SLAYZONE_HUB_SSO_KEY_PATH: ''
  })
  check(
    'sso: blank values count as unset',
    !blank.tenantId && !blank.clientId && !blank.certPath && !blank.keyPath
  )
  const full = resolveHubSso({
    SLAYZONE_HUB_SSO_TENANT_ID: 't',
    SLAYZONE_HUB_SSO_CLIENT_ID: 'c',
    SLAYZONE_HUB_SSO_CERT_PATH: '/c.pem',
    SLAYZONE_HUB_SSO_KEY_PATH: '/k.pem',
    SLAYZONE_HUB_SSO_REQUIRE_MFA: '0'
  })
  check(
    'sso: all read',
    full.tenantId === 't' &&
      full.clientId === 'c' &&
      full.certPath === '/c.pem' &&
      full.keyPath === '/k.pem' &&
      full.requireMfa === false
  )
  check(
    'sso: the retired client secret is not read',
    !('clientSecret' in resolveHubSso({ SLAYZONE_HUB_SSO_CLIENT_SECRET: 's' }))
  )
  let threw: unknown = null
  try {
    resolveHubSso({ SLAYZONE_HUB_SSO_REQUIRE_MFA: 'yes' })
  } catch (e) {
    threw = e
  }
  check('sso: REQUIRE_MFA other than 0|1 throws (B4)', threw instanceof HubSwitchValueError)
}

// --- HUB_PROCESS_ENV: everything a parent must clear before spawning a hub ---
{
  const list = new Set(HUB_PROCESS_ENV)
  check('process env: no duplicates', list.size === HUB_PROCESS_ENV.length)
  check(
    'process env: every switch, SSO var and address var',
    [
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
    ].every((n) => list.has(n))
  )
  check(
    'process env: the retired/dial-side address and the web-origin list',
    list.has('SLAYZONE_HUB_ADDRESS') && list.has(HUB_ALLOWED_WEB_ORIGINS_ENV)
  )
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
  check(
    'process env: every manifested SLAYZONE_HUB_* var is in the list or named as an exception',
    missing.length === 0,
    `missing: ${missing.join(', ')}`
  )
  check(
    'process env: the exceptions really are in the manifest (no stale allowance)',
    Object.keys(NOT_HUB_PROCESS_CONFIG).every((k) => k in ENV_MANIFEST)
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
