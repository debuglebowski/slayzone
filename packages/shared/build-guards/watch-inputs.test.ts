/**
 * Tests for the sidecar dev watcher (watch-inputs.mjs): it must fire for an edit
 * to ANY bundled input — including workspace code outside the package's own
 * src/ (the hub watcher used to watch hub/src only, so edits to inlined
 * packages/domains/x/src/server code left a stale bin.cjs) — and ignore files the
 * bundle doesn't contain.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/build-guards/watch-inputs.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { watchBundleInputs } from './watch-inputs.mjs'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Collect onChange calls for `ms` after running `act`. */
async function changesDuring(w: { fired: string[] }, act: () => void, ms = 600): Promise<string[]> {
  w.fired.length = 0
  act()
  await sleep(ms)
  return [...w.fired]
}

// realpath: macOS tmpdir is a /var → /private/var symlink; fs.watch reports real dirs.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'watch-inputs-')))
const pkgSrc = join(root, 'apps/hub/src')
const domainSrc = join(root, 'domains/x/src/server')
const nm = join(root, 'node_modules/dep')
for (const d of [pkgSrc, domainSrc, nm]) mkdirSync(d, { recursive: true })
const bin = join(pkgSrc, 'bin.ts')
const inlined = join(domainSrc, 'handler.ts')
const notBundled = join(domainSrc, 'handler.test.ts')
const dep = join(nm, 'index.js')
for (const f of [bin, inlined, notBundled, dep]) writeFileSync(f, '// v1\n')

const cwd = join(root, 'apps/hub')
const metafile = {
  inputs: Object.fromEntries([bin, inlined, dep].map((f) => [relative(cwd, f), {}]))
}
const state = { fired: [] as string[] }
const watcher = watchBundleInputs({
  onChange: (f) => state.fired.push(f),
  fallbackDir: pkgSrc,
  debounceMs: 20
})

afterAll(() => {
  watcher.close()
  rmSync(root, { recursive: true, force: true })
})

describe('watchBundleInputs', () => {
  test('before any build: fallback watches the package src', async () => {
    watcher.update(null)
    await sleep(100)
    const fired = await changesDuring(state, () => writeFileSync(bin, '// v2\n'))
    expect(fired.length, 'expected a change in src/ to fire').toBeGreaterThan(0)
  })

  describe('after a successful build', () => {
    beforeAll(async () => {
      watcher.update(metafile, cwd)
      await sleep(100)
    })

    test('fires for an inlined workspace file outside the package src', async () => {
      const fired = await changesDuring(state, () => writeFileSync(inlined, '// v2\n'))
      expect(fired).toContain(inlined)
    })

    test('fires for the package entry', async () => {
      const fired = await changesDuring(state, () => writeFileSync(bin, '// v3\n'))
      expect(fired).toContain(bin)
    })

    test('ignores a file next to an input that is not in the bundle', async () => {
      const fired = await changesDuring(state, () => writeFileSync(notBundled, '// v2\n'))
      expect(fired).toEqual([])
    })

    test('does not watch node_modules inputs', async () => {
      const fired = await changesDuring(state, () => writeFileSync(dep, '// v2\n'))
      expect(fired).toEqual([])
    })

    test('a failed rebuild (update(null)) keeps the last good inputs', async () => {
      watcher.update(null)
      const fired = await changesDuring(state, () => writeFileSync(inlined, '// v3\n'))
      expect(fired).toContain(inlined)
    })

    test('re-targets when the input list shrinks', async () => {
      watcher.update({ inputs: { [relative(cwd, bin)]: {} } }, cwd)
      const fired = await changesDuring(state, () => writeFileSync(inlined, '// v4\n'))
      expect(fired).toEqual([])
    })
  })
})
