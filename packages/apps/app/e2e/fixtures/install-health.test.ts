/**
 * Install-health check for the e2e global setup.
 *
 * An install run with lifecycle scripts skipped (`pnpm install --ignore-scripts`,
 * or one cut short) re-links node-pty from the store with `spawn-helper` at mode
 * 644 and never runs the postinstall that restores its execute bit. Every pty
 * spawn then fails (`posix_spawnp failed.`, surfacing as `computer.pty.spawn`
 * code -32000), and a full run reports ~70 terminal specs failing — read twice on
 * 2026-10-29 as product regressions. pnpm records the skipped work in
 * `node_modules/.modules.yaml` `pendingBuilds`.
 *
 * Run with (vitest, node harness group):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/app/e2e/fixtures/install-health.test.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import {
  assertInstallHealthy,
  installProblems,
  pendingBuildsFrom,
  spawnHelperCandidates
} from './install-health.js'

const modulesYaml = (pendingBuilds: string[]) =>
  JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted', pendingBuilds }, null, 2)

// --- tests ----------------------------------------------------------------

test('reads pendingBuilds from the pnpm modules manifest', () => {
  expect(pendingBuildsFrom(modulesYaml([])), 'nothing pending').toEqual([])
  expect(
    pendingBuildsFrom(modulesYaml(['.', 'node-pty@1.1.0(patch_hash=ebce)'])),
    'root postinstall + node-pty pending'
  ).toEqual(['.', 'node-pty@1.1.0(patch_hash=ebce)'])
})

test('an unreadable manifest is unknown, not healthy and not broken', () => {
  expect(pendingBuildsFrom('not: json: at all'), 'yaml we cannot parse').toEqual(null)
  expect(pendingBuildsFrom(JSON.stringify({ layoutVersion: 5 })), 'no pendingBuilds key').toEqual(
    null
  )
})

test('spawn-helper candidates mirror node-pty load order for this platform', () => {
  expect(spawnHelperCandidates('/r/node_modules/node-pty', 'darwin', 'arm64')).toEqual([
    '/r/node_modules/node-pty/build/Release/spawn-helper',
    '/r/node_modules/node-pty/build/Debug/spawn-helper',
    '/r/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
  ])
  expect(
    spawnHelperCandidates('/r/node_modules/node-pty', 'win32', 'x64'),
    'no helper on Windows'
  ).toEqual([])
})

test('a healthy install reports no problems', () => {
  expect(
    installProblems({
      pendingBuilds: [],
      helpers: [{ path: '/h/prebuilds/darwin-arm64/spawn-helper', executable: true }]
    })
  ).toEqual([])
})

test('skipped builds are reported with the command that runs them', () => {
  const problems = installProblems({ pendingBuilds: ['.', 'posix@4.2.0'], helpers: [] })
  expect(problems, 'one problem').toHaveLength(1)
  expect(problems[0], 'names the skipped builds').toContain('., posix@4.2.0')
  expect(problems[0], 'says how to fix it').toContain('pnpm rebuild --pending')
})

test('a non-executable spawn-helper is reported by path', () => {
  const problems = installProblems({
    pendingBuilds: [],
    helpers: [
      { path: '/h/build/Release/spawn-helper', executable: true },
      { path: '/h/prebuilds/darwin-arm64/spawn-helper', executable: false }
    ]
  })
  expect(problems, 'one problem').toHaveLength(1)
  expect(problems[0], 'names the helper').toContain('/h/prebuilds/darwin-arm64/spawn-helper')
  expect(problems[0], 'names the failure it causes').toContain('posix_spawnp')
})

test('an unknown pendingBuilds state alone is not a problem', () => {
  expect(installProblems({ pendingBuilds: null, helpers: [] })).toEqual([])
})

/** A repo root whose node_modules holds a manifest and this platform's prebuilt helper. */
function fakeRepo(opts: { pendingBuilds: string[]; helperMode: number }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-health-'))
  const nodeModules = path.join(root, 'node_modules')
  const helperDir = path.join(
    nodeModules,
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`
  )
  fs.mkdirSync(helperDir, { recursive: true })
  fs.writeFileSync(path.join(nodeModules, '.modules.yaml'), modulesYaml(opts.pendingBuilds))
  const helper = path.join(helperDir, 'spawn-helper')
  fs.writeFileSync(helper, '#!/bin/sh\n')
  fs.chmodSync(helper, opts.helperMode)
  return root
}

test.skipIf(process.platform === 'win32')(
  'throws on a re-linked install whose scripts never ran',
  () => {
    const root = fakeRepo({ pendingBuilds: ['.', 'node-pty@1.1.0'], helperMode: 0o644 })
    try {
      expect(() => assertInstallHealthy(root), 'both problems named').toThrow(
        /pnpm rebuild --pending[\s\S]*spawn-helper is not executable/
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)

test.skipIf(process.platform === 'win32')('passes a healthy install', () => {
  const root = fakeRepo({ pendingBuilds: [], helperMode: 0o755 })
  try {
    expect(() => assertInstallHealthy(root)).not.toThrow()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('passes this checkout, which the suite is about to run', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
  expect(() => assertInstallHealthy(repoRoot)).not.toThrow()
})
