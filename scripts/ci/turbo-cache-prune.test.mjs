/**
 * Tests for scripts/ci/turbo-cache-prune.mjs (CI's Turborepo cache, before it is saved):
 * only the current run's entries stay, so the saved cache does not grow with every save.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { test, expect } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneTurboCache, taskHashes } from './turbo-cache-prune.mjs'

const entry = (hash) => [`${hash}.tar.zst`, `${hash}-meta.json`, `${hash}-manifest.json`]

test('keeps every file of a current entry, removes every file of an older one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbo-cache-prune-'))
  try {
    for (const f of [...entry('aaaa000011112222'), ...entry('bbbb000011112222')])
      writeFileSync(join(dir, f), '')
    const removed = pruneTurboCache(dir, new Set(['aaaa000011112222']))
    expect(removed).toBe(3)
    expect(readdirSync(dir).sort()).toEqual(entry('aaaa000011112222').sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('leaves files it does not recognise as cache entries alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbo-cache-prune-'))
  try {
    writeFileSync(join(dir, 'README'), '')
    writeFileSync(join(dir, 'cccc000011112222.tar.zst'), '')
    expect(pruneTurboCache(dir, new Set())).toBe(1)
    expect(readdirSync(dir)).toEqual(['README'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing cache directory is nothing to prune', () => {
  expect(pruneTurboCache(join(tmpdir(), 'turbo-cache-prune-missing-dir'), new Set())).toBe(0)
})

test('reads the task hashes of a `turbo run --dry=json` report', () => {
  const report = JSON.stringify({
    tasks: [
      { taskId: 'a#transit', hash: '1111222233334444' },
      { taskId: 'a#typecheck', hash: '5555666677778888' }
    ]
  })
  expect(taskHashes(report)).toEqual(new Set(['1111222233334444', '5555666677778888']))
  expect(() => taskHashes(JSON.stringify({ tasks: [] }))).toThrow(/no tasks/)
})
