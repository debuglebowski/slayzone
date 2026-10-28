/**
 * Tests for scripts/check-workspace-cycles.mjs (`pnpm lint:workspace-cycles`): a
 * dependency edge that is part of a cycle must be in the baseline, and a baseline
 * entry that is no longer part of a cycle must be removed — the baseline only shrinks.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-workspace-cycles.mjs')

/**
 * Builds a fixture workspace (`pkgs/<name>` per package, deps given as names) and
 * runs the guard over it; returns { status, out, baseline }.
 */
function check(packages, { baseline, update = false, workspace } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ws-cycles-'))
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace ?? "packages:\n  - 'pkgs/*'\n")
    for (const [name, deps] of Object.entries(packages)) {
      mkdirSync(join(root, 'pkgs', name), { recursive: true })
      const dependencies = Object.fromEntries(deps.map((d) => [d, 'workspace:*']))
      writeFileSync(
        join(root, 'pkgs', name, 'package.json'),
        JSON.stringify({ name, dependencies })
      )
    }
    mkdirSync(join(root, 'scripts'))
    const baselineFile = join(root, 'scripts/workspace-cycles-baseline.json')
    if (baseline) writeFileSync(baselineFile, JSON.stringify(baseline))
    const r = spawnSync(
      process.execPath,
      [GUARD, '--root', root, ...(update ? ['--update'] : [])],
      {
        encoding: 'utf8'
      }
    )
    const written = existsSync(baselineFile)
      ? JSON.parse(readFileSync(baselineFile, 'utf8'))
      : undefined
    return { status: r.status, out: r.stdout + r.stderr, baseline: written }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('passes an acyclic graph with an empty baseline', () => {
  const r = check({ a: ['b'], b: ['c'], c: [] }, { baseline: [] })
  expect(r.status).toBe(0)
})

test('fails a cycle edge missing from the baseline, naming it', () => {
  const r = check({ a: ['b'], b: ['a'], c: ['a'] }, { baseline: [] })
  expect(r.status).toBe(1)
  expect(r.out).toContain('a -> b')
  expect(r.out).toContain('b -> a')
  // c only points into the cycle: not part of it.
  expect(r.out).not.toContain('c -> a')
})

test('finds every edge of a longer cycle', () => {
  const r = check({ a: ['b'], b: ['c'], c: ['a'] }, { update: true })
  expect(r.status).toBe(0)
  expect(r.baseline).toEqual(['a -> b', 'b -> c', 'c -> a'])
})

test('passes when every cycle edge is in the baseline', () => {
  const r = check({ a: ['b'], b: ['a'] }, { baseline: ['a -> b', 'b -> a'] })
  expect(r.status).toBe(0)
})

test('fails a new edge between two packages already in the same cycle', () => {
  const r = check(
    { a: ['b'], b: ['c'], c: ['a', 'b'] },
    { baseline: ['a -> b', 'b -> c', 'c -> a'] }
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain('c -> b')
})

test('fails a baseline entry that is no longer part of a cycle', () => {
  const r = check({ a: ['b'], b: [] }, { baseline: ['a -> b', 'b -> a'] })
  expect(r.status).toBe(1)
  expect(r.out).toContain('b -> a')
  expect(r.out).toContain('--update')
})

test('ignores dependencies outside the workspace', () => {
  const r = check({ a: ['react'], b: [] }, { baseline: [] })
  expect(r.status).toBe(0)
})

test('fails on a workspace pattern it cannot expand, instead of checking nothing', () => {
  const r = check({ a: [] }, { baseline: [], workspace: "packages:\n  - 'pkgs/**'\n" })
  expect(r.status).toBe(2)
})
