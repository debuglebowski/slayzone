/**
 * Tests for scripts/ios-build.mjs — iOS builds inside the machine-wide CI lock: which part
 * of `expo run:ios` runs locked (the build) and which runs after the lock is released (Metro),
 * and the utility-QoS wrapper. The lock itself is covered by ci-lock.test.mjs.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { afterEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atUtilityQos, builtApp, planRun } from './ios-build.mjs'

const OUT = '/tmp/slz-ios-build-x'

test('default run: build locked without Metro, then the built app served unlocked', () => {
  expect(planRun([], OUT)).toEqual({
    build: ['run:ios', '--no-bundler', '--output', OUT],
    serve: ['run:ios'],
    outputDir: OUT
  })
})

test('device and configuration reach both steps', () => {
  const plan = planRun(['-d', 'iPhone 16', '--configuration', 'Release'], OUT)
  expect(plan.build).toEqual([
    'run:ios',
    '-d',
    'iPhone 16',
    '--configuration',
    'Release',
    '--no-bundler',
    '--output',
    OUT
  ])
  expect(plan.serve).toEqual(['run:ios', '-d', 'iPhone 16', '--configuration', 'Release'])
})

test('--port goes to the Metro step only (expo refuses it with --no-bundler)', () => {
  for (const port of [['--port', '8082'], ['-p', '8082'], ['--port=8082']]) {
    const plan = planRun(port, OUT)
    expect(plan.build).toEqual(['run:ios', '--no-bundler', '--output', OUT])
    expect(plan.serve).toEqual(['run:ios', ...port])
  }
})

test("the caller's --output is where the build goes, and stays out of the Metro step", () => {
  const plan = planRun(['--output', 'dist/ios'], OUT)
  expect(plan.build).toEqual(['run:ios', '--output', 'dist/ios', '--no-bundler'])
  expect(plan.serve).toEqual(['run:ios'])
  expect(plan.outputDir).toBe('dist/ios')
})

test('no dev server wanted (--no-bundler, generic device): build only, locked', () => {
  for (const args of [
    ['--no-bundler'],
    ['--device', 'generic'],
    ['-d', 'generic'],
    ['--device=generic']
  ]) {
    expect(planRun(args, OUT)).toEqual({
      build: ['run:ios', ...args],
      serve: null,
      outputDir: null
    })
  }
})

test('no build (--binary, --unstable-rebundle, --help): nothing locked', () => {
  for (const args of [
    ['--binary', 'x.app'],
    ['--unstable-rebundle', '-d', 'X'],
    ['--help'],
    ['-h']
  ]) {
    expect(planRun(args, OUT)).toEqual({
      build: null,
      serve: ['run:ios', ...args],
      outputDir: null
    })
  }
})

test('builds run at utility QoS on macOS, never background', () => {
  const has = () => true
  expect(atUtilityQos(['xcodebuild', 'archive'], { platform: 'darwin', has })).toEqual([
    '/usr/sbin/taskpolicy',
    '-c',
    'utility',
    'xcodebuild',
    'archive'
  ])
  expect(atUtilityQos(['pod', 'install'], { platform: 'linux', has })).toEqual(['pod', 'install'])
  expect(atUtilityQos(['pod', 'install'], { platform: 'darwin', has: () => false })).toEqual([
    'pod',
    'install'
  ])
})

let dir
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

test('builtApp: the newest .app in the output dir, null when none', () => {
  dir = mkdtempSync(join(tmpdir(), 'ios-build-test-'))
  expect(builtApp(dir)).toBeNull()
  mkdirSync(join(dir, 'Old.app'))
  mkdirSync(join(dir, 'SlayZone.app'))
  mkdirSync(join(dir, 'notes'))
  utimesSync(join(dir, 'Old.app'), 1, 1)
  expect(builtApp(dir)).toBe(join(dir, 'SlayZone.app'))
})
