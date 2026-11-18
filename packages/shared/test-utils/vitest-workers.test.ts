/**
 * One vitest run keeps at most half the cores busy unless told otherwise (vitest-workers.ts),
 * and that holds for a run started anywhere: vitest reads a config only from the directory
 * it starts in, so every directory with vitest tests has a config that applies the cap.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { localMaxWorkers } from './vitest-workers'

const rootDir = resolve(import.meta.dirname, '../../..')

describe('localMaxWorkers', () => {
  test('locally: half the cores, at least 2, never above a lower configured count', () => {
    expect(localMaxWorkers(undefined, {}, 10)).toBe(5)
    expect(localMaxWorkers(undefined, {}, 3)).toBe(2)
    expect(localMaxWorkers(20, {}, 10)).toBe(5)
    expect(localMaxWorkers(2, {}, 10)).toBe(2)
  })

  test('SLZ_UNIT_WORKERS=all and CI keep the configured count (vitest default when unset)', () => {
    expect(localMaxWorkers(20, { SLZ_UNIT_WORKERS: 'all' }, 10)).toBe(20)
    expect(localMaxWorkers(undefined, { SLZ_UNIT_WORKERS: 'all' }, 10)).toBeUndefined()
    expect(localMaxWorkers(20, { CI: 'true' }, 10)).toBe(20)
    expect(localMaxWorkers(undefined, { CI: 'false' }, 10)).toBe(5)
  })

  test('SLZ_UNIT_WORKERS=<n> sets the count, anything else fails loudly', () => {
    expect(localMaxWorkers(undefined, { SLZ_UNIT_WORKERS: '7' }, 10)).toBe(7)
    expect(localMaxWorkers(2, { SLZ_UNIT_WORKERS: '7', CI: 'true' }, 10)).toBe(7)
    expect(() => localMaxWorkers(undefined, { SLZ_UNIT_WORKERS: 'many' }, 10)).toThrow(
      /SLZ_UNIT_WORKERS/
    )
  })
})

describe('every vitest run is capped, wherever it starts', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '' && !f.includes('/node_modules/'))
    // A tracked file deleted in the working tree (not committed yet) has no source.
    .filter((f) => existsSync(join(rootDir, f)))

  test('every directory holding test files has a vitest.config.ts (jest packages aside)', () => {
    const dirs = new Set(
      tracked
        .filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))
        .map((f) => (f.startsWith('packages/') ? f.split('/').slice(0, 3).join('/') : '.'))
    )
    const missing = [...dirs].filter(
      (dir) =>
        !existsSync(join(rootDir, dir, 'jest.config.js')) &&
        !existsSync(join(rootDir, dir, 'vitest.config.ts'))
    )
    expect(missing).toEqual([])
  })

  test.each(tracked.filter((f) => /(^|\/)vitest(\.[\w-]+)?\.config\.ts$/.test(f)))(
    '%s applies localMaxWorkers',
    (file) => {
      expect(readFileSync(join(rootDir, file), 'utf8')).toMatch(/\bmaxWorkers: localMaxWorkers\(/)
    }
  )
})
