/**
 * dirs — getSupervisedRoot channel-to-bucket folding + SLAYZONE_ROOT
 * composition. Pure Node (no native deps) → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/dirs.test.ts
 */
import { join } from 'node:path'
import { getSlayzoneHomeDir, getSupervisedRoot } from './dirs'

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
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

/** Run `fn` with SLAYZONE_ROOT + SLAYZONE_RELEASE_CHANNEL scrubbed/restored. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['SLAYZONE_ROOT', 'SLAYZONE_RELEASE_CHANNEL'] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

console.log('\ndirs: getSupervisedRoot — channel-to-bucket folding')
console.log('─'.repeat(40))

test("channel='dev' → the dev bucket", () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
    assertEq(getSupervisedRoot('hub', 'dev'), join('/tmp/root', 'dev', 'hub'), 'dev hub')
    assertEq(getSupervisedRoot('runner', 'dev'), join('/tmp/root', 'dev', 'runner'), 'dev runner')
  })
})

test("channel='beta' folds onto the stable bucket — no separate beta bucket", () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
    assertEq(getSupervisedRoot('hub', 'beta'), join('/tmp/root', 'stable', 'hub'), 'beta → stable')
  })
})

test("channel='stable' → the stable bucket", () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
    assertEq(getSupervisedRoot('hub', 'stable'), join('/tmp/root', 'stable', 'hub'), 'stable hub')
    assertEq(getSupervisedRoot('runner', 'stable'), join('/tmp/root', 'stable', 'runner'), 'stable runner')
  })
})

test("channel='unknown' (release channel never set) folds onto stable — no empty/default bucket", () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
    assertEq(getSupervisedRoot('hub', 'unknown'), join('/tmp/root', 'stable', 'hub'), 'unknown → stable')
  })
})

test('any other unrecognized channel value also folds onto stable (fail safe, not fail open to a new bucket)', () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
    assertEq(getSupervisedRoot('hub', 'nightly'), join('/tmp/root', 'stable', 'hub'), 'typo channel → stable')
  })
})

console.log('\ndirs: getSupervisedRoot — default channel param reads getSlayzoneReleaseChannel()')
console.log('─'.repeat(40))

test('no channel arg ⇒ reads SLAYZONE_RELEASE_CHANNEL from env', () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/root', SLAYZONE_RELEASE_CHANNEL: 'dev' }, () => {
    assertEq(getSupervisedRoot('hub'), join('/tmp/root', 'dev', 'hub'), 'env dev bucket picked up')
  })
  withEnv({ SLAYZONE_ROOT: '/tmp/root', SLAYZONE_RELEASE_CHANNEL: 'stable' }, () => {
    assertEq(getSupervisedRoot('hub'), join('/tmp/root', 'stable', 'hub'), 'env stable bucket picked up')
  })
})

test('SLAYZONE_RELEASE_CHANNEL unset ⇒ getSlayzoneReleaseChannel() defaults to unknown ⇒ stable bucket', () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
    assertEq(getSupervisedRoot('runner'), join('/tmp/root', 'stable', 'runner'), 'unset → stable')
  })
})

console.log('\ndirs: getSupervisedRoot — composes under SLAYZONE_ROOT override')
console.log('─'.repeat(40))

test('resolves under an overridden SLAYZONE_ROOT (E2E/test sandboxing)', () => {
  withEnv({ SLAYZONE_ROOT: '/tmp/sandbox-root' }, () => {
    assertEq(getSlayzoneHomeDir(), '/tmp/sandbox-root', 'home dir under override')
    assertEq(getSupervisedRoot('hub', 'dev'), join('/tmp/sandbox-root', 'dev', 'hub'), 'supervised root under override')
  })
})

test('resolves under the real $HOME/.slayzone when SLAYZONE_ROOT is unset', () => {
  withEnv({}, () => {
    const expected = join(getSlayzoneHomeDir(), 'dev', 'hub')
    assertEq(getSupervisedRoot('hub', 'dev'), expected, 'falls through to home-derived root')
  })
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
