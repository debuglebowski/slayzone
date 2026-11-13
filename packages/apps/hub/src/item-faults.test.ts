/**
 * Needs attention (decision 6): a computer's faults reach the hub, are mirrored
 * for task badges (snapshot replace, never merged), and Retry / Discard act on
 * the computer. The hub's own quarantine lists and discards locally.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { quarantineMove } from '@slayzone/platform/quarantine'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createItemFaultService } from './item-faults'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function fixture() {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'item-faults-'))
  const pc = createFixtureChatRuntime({
    stateDir: dir,
    hubScope: 'hub',
    computerId: () => 'pc',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'test',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  } as never)
  cleanups.push(async () => {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  let connected = true
  const service = createItemFaultService({
    db: h.slayDb,
    isConnected: () => connected,
    requestComputer: async (_id, value) => pc.request(JSON.parse(JSON.stringify(value)))
  })
  return { h, dir, pc, service, offline: () => (connected = false) }
}

const bootstrap = (taskId: string) => ({
  kind: 'bootstrap',
  value: {
    identity: { id: `c-${taskId}`, taskId, tabId: `tab-${taskId}`, mode: 'claude-chat', epoch: 1 },
    projectId: null,
    cwd: realpathSync(tmpdir()),
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  }
})

test("a computer's quarantined archive is listed, badges its task while offline, and Discard deletes it", async () => {
  const f = await fixture()
  await f.pc.request(bootstrap('task'))
  // Plant a quarantined item in the hub scope's chat store (as archive erasure does).
  const runtime = join(f.dir, 'computer-runtime')
  const store = join(runtime, readdirSync(runtime).find((d) => /^[a-f0-9]{64}$/.test(d))!)
  const bad = join(store, 'bad-archive')
  writeFileSync(bad, 'unreadable')
  quarantineMove(store, {
    pass: 'chat-archive',
    path: bad,
    taskId: 'task',
    reason: 'torn manifest'
  })

  const listed = await f.service.list({ computerId: 'pc', dataRoot: f.dir })
  expect(listed).toMatchObject([
    {
      computerId: 'pc',
      origin: 'computer',
      source: 'quarantine',
      pass: 'chat-archive',
      taskId: 'task',
      discardable: true
    }
  ])
  // Mirrored: the badge survives the computer going offline (read-only there).
  f.offline()
  expect(await f.service.byTask()).toEqual([{ taskId: 'task', computerId: 'pc' }])
  expect((await f.service.list({ computerId: 'pc', dataRoot: f.dir }))[0]).toMatchObject({
    retryable: false,
    discardable: false
  })
})

test('Discard on the computer deletes the item; the mirror follows', async () => {
  const f = await fixture()
  await f.pc.request(bootstrap('task'))
  const runtime = join(f.dir, 'computer-runtime')
  const store = join(runtime, readdirSync(runtime).find((d) => /^[a-f0-9]{64}$/.test(d))!)
  const bad = join(store, 'bad-archive')
  writeFileSync(bad, 'unreadable')
  quarantineMove(store, { pass: 'chat-archive', path: bad, taskId: 'task', reason: 'torn' })
  const [fault] = await f.service.list({ computerId: 'pc', dataRoot: f.dir })
  await f.service.discard(fault, f.dir)
  expect(await f.service.list({ computerId: 'pc', dataRoot: f.dir })).toEqual([])
  expect(await f.service.byTask()).toEqual([])
  expect(existsSync(join(store, 'quarantine', 'chat-archive'))).toBe(true)
  expect(readdirSync(join(store, 'quarantine', 'chat-archive'))).toEqual([])
})

test("another hub's quarantined hook journal is never shown to this hub", async () => {
  const f = await fixture()
  await f.pc.request(bootstrap('task'))
  const runtime = join(f.dir, 'computer-runtime')
  const foreign = join(runtime, `hooks-${'c'.repeat(16)}.json`)
  writeFileSync(foreign, '[')
  quarantineMove(runtime, { pass: 'hook-journal', path: foreign, reason: 'torn' })
  expect(await f.service.list({ computerId: 'pc', dataRoot: f.dir })).toEqual([])
})

test("the hub's own quarantine: listed for the hub, Retry moves it back, Discard deletes it", async () => {
  const f = await fixture()
  const backup = join(f.dir, 'backups-old.sqlite')
  writeFileSync(backup, 'x')
  quarantineMove(f.dir, { pass: 'hub-backup', path: backup, reason: 'not a database' })
  const [fault] = await f.service.list({ computerId: null, dataRoot: f.dir })
  expect(fault).toMatchObject({
    computerId: null,
    origin: 'hub',
    retryable: true,
    discardable: true
  })
  await f.service.retry(fault, f.dir)
  expect(existsSync(backup)).toBe(true)
  quarantineMove(f.dir, { pass: 'hub-backup', path: backup, reason: 'not a database' })
  const [again] = await f.service.list({ computerId: null, dataRoot: f.dir })
  await f.service.discard(again, f.dir)
  expect(await f.service.list({ computerId: null, dataRoot: f.dir })).toEqual([])
})
