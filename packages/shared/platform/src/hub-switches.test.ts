/**
 * The per-hub switches (B4): `0|1` only, defaults = the desktop app's hub.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/hub-switches.test.ts
 */
import {
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

// --- SSO settings: blank = unset ---
{
  const none = resolveHubSso({})
  check('sso: nothing set → empty', !none.tenantId && !none.clientId && !none.clientSecret)
  const blank = resolveHubSso({
    SLAYZONE_HUB_SSO_TENANT_ID: '  ',
    SLAYZONE_HUB_SSO_CLIENT_ID: '',
    SLAYZONE_HUB_SSO_CLIENT_SECRET: ' '
  })
  check(
    'sso: blank values count as unset',
    !blank.tenantId && !blank.clientId && !blank.clientSecret
  )
  const full = resolveHubSso({
    SLAYZONE_HUB_SSO_TENANT_ID: 't',
    SLAYZONE_HUB_SSO_CLIENT_ID: 'c',
    SLAYZONE_HUB_SSO_CLIENT_SECRET: 's'
  })
  check(
    'sso: all three read',
    full.tenantId === 't' && full.clientId === 'c' && full.clientSecret === 's'
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
