/**
 * Tests for scripts/ios-build.mjs — iOS builds inside the machine-wide CI lock: which part
 * of `expo run:ios` runs locked (the build) and which runs outside the lock (Metro),
 * and the utility-QoS wrapper. The lock itself is covered by ci-lock.test.mjs.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { expect, test } from 'vitest'
import { atUtilityQos, buildEnv, explicitPort, firstFreePort, planRun } from './ios-build.mjs'

test('default run: Metro on the free port first, then the build pointed at it, locked', () => {
  expect(planRun([], 8082)).toEqual({
    direct: null,
    build: ['run:ios', '--port', '8082'],
    metro: ['start', '--dev-client', '--port', '8082']
  })
})

test('build options reach the build only', () => {
  const plan = planRun(['-d', 'iPhone 16', '--configuration', 'Release'], 8081)
  expect(plan.build).toEqual([
    'run:ios',
    '-d',
    'iPhone 16',
    '--configuration',
    'Release',
    '--port',
    '8081'
  ])
  expect(plan.metro).toEqual(['start', '--dev-client', '--port', '8081'])
})

test("the caller's --port wins over the found one, for both", () => {
  for (const port of [['--port', '8090'], ['-p', '8090'], ['--port=8090']]) {
    expect(explicitPort(port)).toBe(8090)
    const plan = planRun(port, 8081)
    expect(plan.build).toEqual(['run:ios', '--port', '8090'])
    expect(plan.metro).toEqual(['start', '--dev-client', '--port', '8090'])
  }
  expect(explicitPort(['-d', 'X'])).toBeNull()
})

test('no dev server wanted (--no-bundler, generic device): build only, locked', () => {
  for (const args of [
    ['--no-bundler'],
    ['--device', 'generic'],
    ['-d', 'generic'],
    ['--device=generic']
  ]) {
    expect(planRun(args, 8081)).toEqual({ direct: null, build: ['run:ios', ...args], metro: null })
  }
})

test('no build (--binary, --unstable-rebundle, --help): expo as is, nothing locked', () => {
  for (const args of [
    ['--binary', 'x.app'],
    ['--unstable-rebundle', '-d', 'X'],
    ['--help'],
    ['-h']
  ]) {
    expect(planRun(args, 8081)).toEqual({ direct: ['run:ios', ...args], build: null, metro: null })
  }
})

test("firstFreePort: skips busy ports (another checkout's Metro on 8081)", async () => {
  const busy = new Set([8081, 8082])
  expect(await firstFreePort(8081, async (p) => !busy.has(p))).toBe(8083)
  await expect(firstFreePort(8081, async () => false)).rejects.toThrow('no free port')
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

test('the build compiles the Metro port into the app (else it loads whatever runs on 8081)', () => {
  expect(buildEnv({ PATH: '/bin', RCT_METRO_PORT: '8081' }, 8083)).toEqual({
    PATH: '/bin',
    RCT_METRO_PORT: '8083'
  })
})
