/**
 * Stale runtime-dir selection for the e2e global setup.
 *
 * Every e2e worker and isolated launch creates `.e2e-runtime/<prefix>-<pid>-<ms>`
 * and nothing ever removed them — 649 dirs / 231 GB accumulated in six days and
 * filled the disk, which then failed ~56 specs of an unrelated full-suite run.
 *
 * A dir is stale only when the pid in its name is DEAD. `e2e-parallel.sh` runs
 * six Playwright processes concurrently, each running this global setup, so a
 * dir owned by a live worker of another group must survive. Anything not shaped
 * like `<prefix>-<pid>-<ms>` is left alone (fail closed).
 *
 * Run with (vitest, node harness group):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/app/e2e/fixtures/stale-runtime-dirs.test.ts
 */
import { expect, test } from 'vitest'
import { parseRuntimeDirOwner, selectStaleRuntimeDirs } from './stale-runtime-dirs.js'

const alive = (pids: number[]) => (pid: number) => pids.includes(pid)

// --- tests ----------------------------------------------------------------

test('parses the owning pid from worker and isolated dir names', () => {
  expect(parseRuntimeDirOwner('worker-0-50048-1793107465256'), 'worker dir').toEqual(50048)
  expect(
    parseRuntimeDirOwner('isolated-multi-hub-live-add-46853-1792590772648'),
    'isolated dir with dashes in its name'
  ).toEqual(46853)
})

test('returns null for names not shaped like <prefix>-<pid>-<ms>', () => {
  expect(parseRuntimeDirOwner('default-test-project'), 'no numeric suffix').toEqual(null)
  expect(parseRuntimeDirOwner('worker-0-50048'), 'missing timestamp').toEqual(null)
  expect(parseRuntimeDirOwner('50048-1793107465256'), 'missing prefix').toEqual(null)
  expect(parseRuntimeDirOwner('worker-0-0-1793107465256'), 'pid 0').toEqual(null)
})

test('selects dirs whose owning process is dead', () => {
  const names = ['worker-0-111-1793107465256', 'worker-1-222-1793107465300']
  expect(selectStaleRuntimeDirs(names, alive([222])), 'dead only').toEqual([
    'worker-0-111-1793107465256'
  ])
})

test('keeps dirs owned by a live process — a concurrent group', () => {
  const names = ['worker-3-333-1793107465256', 'isolated-computer-loopback-333-1793107469999']
  expect(selectStaleRuntimeDirs(names, alive([333])), 'live owner kept').toEqual([])
})

test('never selects a dir it cannot attribute', () => {
  expect(
    selectStaleRuntimeDirs(['default-test-project', 'notes', 'worker-x-y-z'], alive([])),
    'unparseable names kept'
  ).toEqual([])
})
