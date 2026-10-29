/**
 * Can node-pty start processes from this install?
 *
 * An install run with lifecycle scripts skipped (`pnpm install --ignore-scripts`,
 * or one cut short) re-links node-pty from the store with `spawn-helper` at mode
 * 644 and never runs the postinstall that restores its execute bit. Every pty
 * spawn then fails with `posix_spawnp failed.` — in the app as "The computer
 * couldn't start the agent.", in e2e as ~70 failing terminal specs. pnpm records
 * the skipped work in `node_modules/.modules.yaml` `pendingBuilds`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  installProblems,
  nodePtyInstallProblems,
  pendingBuildsFrom,
  spawnHelperCandidates,
  unpackedAsarPath
} from './node-pty-install'

const modulesYaml = (pendingBuilds: string[]) =>
  JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted', pendingBuilds }, null, 2)

let tmp: string | null = null
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

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
  // Joined with the HOST's separator: the darwin list is also built on Windows CI.
  const dir = '/r/node_modules/node-pty'
  expect(spawnHelperCandidates(dir, 'darwin', 'arm64')).toEqual([
    path.join(dir, 'build', 'Release', 'spawn-helper'),
    path.join(dir, 'build', 'Debug', 'spawn-helper'),
    path.join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper')
  ])
  expect(
    spawnHelperCandidates('/r/node_modules/node-pty', 'win32', 'x64'),
    'no helper on Windows'
  ).toEqual([])
})

test('a packaged app execs the helper from app.asar.unpacked, as node-pty does', () => {
  expect(unpackedAsarPath('/A.app/Resources/app.asar/node_modules/node-pty/x')).toBe(
    '/A.app/Resources/app.asar.unpacked/node_modules/node-pty/x'
  )
  expect(
    unpackedAsarPath('/A.app/Resources/app.asar.unpacked/node_modules/node-pty/x'),
    'already unpacked: unchanged'
  ).toBe('/A.app/Resources/app.asar.unpacked/node_modules/node-pty/x')
  expect(unpackedAsarPath('/r/node_modules/node-pty/x'), 'no asar: unchanged').toBe(
    '/r/node_modules/node-pty/x'
  )
})

test('a healthy install reports no problems', () => {
  expect(
    installProblems({
      repoRoot: '/r',
      pendingBuilds: [],
      helpers: [{ path: '/h/prebuilds/darwin-arm64/spawn-helper', executable: true }]
    })
  ).toEqual([])
})

test('skipped builds are reported with the command that runs them', () => {
  const problems = installProblems({
    repoRoot: '/r',
    pendingBuilds: ['.', 'posix@4.2.0'],
    helpers: []
  })
  expect(problems, 'one problem').toHaveLength(1)
  expect(problems[0]!.detail, 'names the skipped builds').toContain('., posix@4.2.0')
  expect(problems[0]!.fix, 'runs them where the manifest lives').toBe(
    "cd '/r' && pnpm rebuild --pending"
  )
})

test('non-executable spawn-helpers are ONE problem naming each path', () => {
  const problems = installProblems({
    repoRoot: null,
    pendingBuilds: null,
    helpers: [
      { path: '/h/build/Release/spawn-helper', executable: false },
      { path: '/h/build/Debug/spawn-helper', executable: true },
      { path: '/h/prebuilds/darwin-arm64/spawn-helper', executable: false }
    ]
  })
  // One per kind: Doctor keys its rows by `check`.
  expect(problems, 'one problem').toHaveLength(1)
  expect(problems[0]!.detail, 'names the failure it causes').toContain('posix_spawnp')
  expect(problems[0]!.detail).toContain('/h/build/Release/spawn-helper')
  expect(problems[0]!.detail).toContain('/h/prebuilds/darwin-arm64/spawn-helper')
  expect(problems[0]!.detail, 'the executable one is fine').not.toContain('build/Debug')
  expect(problems[0]!.fix).toBe(
    "chmod +x '/h/build/Release/spawn-helper' '/h/prebuilds/darwin-arm64/spawn-helper'"
  )
})

test('every problem kind has its own check name', () => {
  const problems = installProblems({
    repoRoot: '/r',
    pendingBuilds: ['node-pty@1.1.0'],
    helpers: [{ path: '/h/spawn-helper', executable: false }]
  })
  expect(new Set(problems.map((p) => p.check)).size).toBe(2)
})

test('an unknown pendingBuilds state alone is not a problem', () => {
  expect(installProblems({ repoRoot: null, pendingBuilds: null, helpers: [] })).toEqual([])
})

/** A hoisted node_modules holding a manifest and this platform's prebuilt helper. */
function fakeInstall(opts: { pendingBuilds: string[] | null; helperMode: number }): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-install-'))
  const nodePtyDir = path.join(tmp, 'node_modules', 'node-pty')
  const helperDir = path.join(nodePtyDir, 'prebuilds', `${process.platform}-${process.arch}`)
  fs.mkdirSync(helperDir, { recursive: true })
  if (opts.pendingBuilds) {
    fs.writeFileSync(
      path.join(tmp, 'node_modules', '.modules.yaml'),
      modulesYaml(opts.pendingBuilds)
    )
  }
  const helper = path.join(helperDir, 'spawn-helper')
  fs.writeFileSync(helper, '#!/bin/sh\n')
  fs.chmodSync(helper, opts.helperMode)
  return nodePtyDir
}

test.skipIf(process.platform === 'win32')(
  'reads a re-linked install whose scripts never ran off disk',
  () => {
    const nodePtyDir = fakeInstall({ pendingBuilds: ['.', 'node-pty@1.1.0'], helperMode: 0o644 })
    const problems = nodePtyInstallProblems(nodePtyDir)
    expect(problems.map((p) => p.fix)).toEqual([
      `cd '${tmp}' && pnpm rebuild --pending`,
      `chmod +x '${path.join(nodePtyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')}'`
    ])
  }
)

test.skipIf(process.platform === 'win32')('a healthy install off disk has no problems', () => {
  expect(nodePtyInstallProblems(fakeInstall({ pendingBuilds: [], helperMode: 0o755 }))).toEqual([])
})

test.skipIf(process.platform === 'win32')(
  'no pnpm manifest (a packaged app, an npm install) still checks the helper',
  () => {
    const nodePtyDir = fakeInstall({ pendingBuilds: null, helperMode: 0o644 })
    expect(nodePtyInstallProblems(nodePtyDir).map((p) => p.check)).toEqual([
      'spawn-helper executable'
    ])
  }
)
