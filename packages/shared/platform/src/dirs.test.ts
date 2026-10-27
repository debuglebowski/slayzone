/**
 * dirs — getSupervisedRoot channel-to-bucket folding + SLAYZONE_ROOT
 * composition. Pure Node (no native deps) → runs under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/dirs.test.ts
 */
import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { getSlayzoneHomeDir, getSupervisedRoot } from './dirs'

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

describe('dirs: getSupervisedRoot — channel-to-bucket folding', () => {
  test("channel='dev' → the dev bucket", () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
      expect(getSupervisedRoot('hub', 'dev'), 'dev hub').toBe(join('/tmp/root', 'dev', 'hub'))
      expect(getSupervisedRoot('computer', 'dev'), 'dev computer').toBe(
        join('/tmp/root', 'dev', 'computer')
      )
    })
  })

  test("channel='beta' folds onto the stable bucket — no separate beta bucket", () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
      expect(getSupervisedRoot('hub', 'beta'), 'beta → stable').toBe(
        join('/tmp/root', 'stable', 'hub')
      )
    })
  })

  test("channel='stable' → the stable bucket", () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
      expect(getSupervisedRoot('hub', 'stable'), 'stable hub').toBe(
        join('/tmp/root', 'stable', 'hub')
      )
      expect(getSupervisedRoot('computer', 'stable'), 'stable computer').toBe(
        join('/tmp/root', 'stable', 'computer')
      )
    })
  })

  test("channel='unknown' (release channel never set) folds onto stable — no empty/default bucket", () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
      expect(getSupervisedRoot('hub', 'unknown'), 'unknown → stable').toBe(
        join('/tmp/root', 'stable', 'hub')
      )
    })
  })

  test('any other unrecognized channel value also folds onto stable (fail safe, not fail open to a new bucket)', () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
      expect(getSupervisedRoot('hub', 'nightly'), 'typo channel → stable').toBe(
        join('/tmp/root', 'stable', 'hub')
      )
    })
  })
})

describe('dirs: getSupervisedRoot — default channel param reads getSlayzoneReleaseChannel()', () => {
  test('no channel arg ⇒ reads SLAYZONE_RELEASE_CHANNEL from env', () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/root', SLAYZONE_RELEASE_CHANNEL: 'dev' }, () => {
      expect(getSupervisedRoot('hub'), 'env dev bucket picked up').toBe(
        join('/tmp/root', 'dev', 'hub')
      )
    })
    withEnv({ SLAYZONE_ROOT: '/tmp/root', SLAYZONE_RELEASE_CHANNEL: 'stable' }, () => {
      expect(getSupervisedRoot('hub'), 'env stable bucket picked up').toBe(
        join('/tmp/root', 'stable', 'hub')
      )
    })
  })

  test('SLAYZONE_RELEASE_CHANNEL unset ⇒ getSlayzoneReleaseChannel() defaults to unknown ⇒ stable bucket', () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/root' }, () => {
      expect(getSupervisedRoot('computer'), 'unset → stable').toBe(
        join('/tmp/root', 'stable', 'computer')
      )
    })
  })
})

describe('dirs: getSupervisedRoot — composes under SLAYZONE_ROOT override', () => {
  test('resolves under an overridden SLAYZONE_ROOT (E2E/test sandboxing)', () => {
    withEnv({ SLAYZONE_ROOT: '/tmp/sandbox-root' }, () => {
      expect(getSlayzoneHomeDir(), 'home dir under override').toBe('/tmp/sandbox-root')
      expect(getSupervisedRoot('hub', 'dev'), 'supervised root under override').toBe(
        join('/tmp/sandbox-root', 'dev', 'hub')
      )
    })
  })

  test('resolves under the real $HOME/.slayzone when SLAYZONE_ROOT is unset', () => {
    withEnv({}, () => {
      const expected = join(getSlayzoneHomeDir(), 'dev', 'hub')
      expect(getSupervisedRoot('hub', 'dev'), 'falls through to home-derived root').toBe(expected)
    })
  })
})
