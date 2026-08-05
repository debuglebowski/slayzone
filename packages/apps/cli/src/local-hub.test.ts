/**
 * local-hub — how the CLI finds the desktop app WITHOUT a database.
 *
 * These two predicates are what replaced reading `settings.server_port` out of
 * SQLite, which is what forced the CLI to derive the app's on-disk layout and
 * broke every command from a plain shell when that layout moved. They are pure
 * (env in, value out), so they are pinned here rather than through a live server:
 * `isCoLocatedHub` in particular is only reachable over the network by addressing
 * a non-loopback host, which no offline test can arrange portably.
 *
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/apps/cli/src/local-hub.test.ts
 */
import { SIDECAR_FIXED_PORT } from '@slayzone/platform/paths'
import { fixedPortForChannel, isCoLocatedHub } from './local-hub'

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

/** Run `fn` with the given SLAYZONE_* env, restoring whatever was there before. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): Promise<void> {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function main(): Promise<void> {
  console.log('\nfixedPortForChannel')

  await withEnv({ SLAYZONE_DEV: '1' }, () => {
    check(
      'dev channel resolves the dev sidecar port',
      fixedPortForChannel() === SIDECAR_FIXED_PORT.dev,
      `got ${fixedPortForChannel()}, want ${SIDECAR_FIXED_PORT.dev}`
    )
  })

  await withEnv({ SLAYZONE_DEV: undefined }, () => {
    check(
      'unset SLAYZONE_DEV resolves the packaged sidecar port',
      fixedPortForChannel() === SIDECAR_FIXED_PORT.prod,
      `got ${fixedPortForChannel()}, want ${SIDECAR_FIXED_PORT.prod}`
    )
  })

  // The two channels must never collide, or `slay` and `slay --dev` would target
  // one install and the "app is running with/without --dev" hint could never fire.
  // Widened to `number` so this stays a runtime assertion: compared as literal
  // types, TS proves the inequality at compile time and rejects the check as
  // unintentional — which would silently drop the guard if the constants ever met.
  const devPort: number = SIDECAR_FIXED_PORT.dev
  const prodPort: number = SIDECAR_FIXED_PORT.prod
  check('dev and prod fixed ports are distinct', devPort !== prodPort)

  console.log('\nisCoLocatedHub')

  // No hub configured ⇒ the target was found by probing loopback, so it is this
  // machine by construction.
  await withEnv({ SLAYZONE_HUB_ADDRESS: undefined, SLAYZONE_HUB_TOKEN: undefined }, async () => {
    // NOTE: this reads the real hub-target file if the developer running the suite
    // has one. Assert only the shape that holds either way — a boolean, no throw.
    const got = await isCoLocatedHub()
    check('no env hub configured answers without throwing', typeof got === 'boolean')
  })

  for (const addr of ['127.0.0.1:51101', 'localhost:51101', '[::1]:51101']) {
    await withEnv({ SLAYZONE_HUB_ADDRESS: addr }, async () => {
      check(`loopback hub is co-located (${addr})`, (await isCoLocatedHub()) === true)
    })
  }

  for (const addr of ['hub.example.com:8443', '10.0.0.5:51101', 'slayzone.internal']) {
    await withEnv({ SLAYZONE_HUB_ADDRESS: addr }, async () => {
      check(`off-box hub is NOT co-located (${addr})`, (await isCoLocatedHub()) === false)
    })
  }

  // A wildcard bind names every interface, not this one — treating it as
  // co-located would print a local path for an artifact that may live elsewhere.
  await withEnv({ SLAYZONE_HUB_ADDRESS: '0.0.0.0:51101' }, async () => {
    check('wildcard address is NOT co-located', (await isCoLocatedHub()) === false)
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
