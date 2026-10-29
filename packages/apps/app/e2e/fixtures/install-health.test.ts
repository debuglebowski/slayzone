/**
 * Install-health gate for the e2e global setup. What counts as a broken install is
 * tested in `@slayzone/platform` (node-pty-install.test.ts); this pins the gate:
 * it throws with every problem's fix, and passes the checkout about to run.
 *
 * Run with (vitest, node harness group):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/app/e2e/fixtures/install-health.test.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { assertInstallHealthy } from './install-health.js'

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
  fs.writeFileSync(
    path.join(nodeModules, '.modules.yaml'),
    JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted', pendingBuilds: opts.pendingBuilds })
  )
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
      expect(() => assertInstallHealthy(root), 'both problems named, each with its fix').toThrow(
        /Fix: cd .* && pnpm rebuild --pending[\s\S]*spawn-helper is not executable.*Fix: chmod \+x/
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
