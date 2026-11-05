import { afterEach, expect, test, vi } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatMigration } from './migration'
import { encodeTransfer } from './transfers'
import type { ChatTransferManifest } from '../shared'
type TestRequest = { kind: string; data: string; hash: string; manifest: ChatTransferManifest }
const harnesses: TestHarness[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup()
})
// The real, fully migrated hub schema: a hand-picked slice of migrations on a
// skeleton DB broke on every later migration that touches a table it lacks.
async function fixture() {
  const h = await createTestHarness()
  harnesses.push(h)
  const ownership = createChatOwnershipStore(h.slayDb)
  const route = await ownership.register({
    id: 'c',
    taskId: 'task',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: null,
    epoch: 1
  })
  const source = {
    quiesce: vi.fn(async () => {}),
    open: vi.fn(async (r: typeof route, migrationId: string) => {
      const p = encodeTransfer({
        version: 1,
        migrationId,
        identity: { id: r.id, taskId: r.taskId, tabId: r.tabId, mode: r.mode, epoch: r.epoch },
        events: [],
        records: [],
        receipts: [],
        hash: ''
      })
      return {
        manifest: p.manifest,
        async *chunks(offset: number) {
          yield p.bytes.subarray(offset)
        }
      }
    }),
    readAttachment: vi.fn(),
    cleanup: vi.fn(async () => {})
  }
  let offset = 0,
    activationFailures = 0,
    failChunk = false
  const request = vi.fn(async (_pc: string, raw: unknown): Promise<unknown> => {
    const p = raw as TestRequest
    switch (p.kind) {
      case 'transfer.begin':
        return { id: 'transfer', offset }
      case 'transfer.chunk':
        if (failChunk) {
          failChunk = false
          throw new Error('Disconnected')
        }
        offset += Buffer.from(p.data, 'base64').length
        return { offset }
      case 'transfer.finish':
        return { id: 'c', epoch: 2, hash: (await ownership.get('c'))?.manifestHash ?? p.hash }
      case 'migration.verify':
        return { missing: [] }
      case 'migration.activate':
        if (activationFailures-- > 0) throw new Error('Disconnected')
        return { ok: true }
    }
  })
  // finish returns the destination's verified digest, independent of hub state.
  request.mockImplementation(async (_pc, raw) => {
    const p = raw as TestRequest
    if (p.kind === 'transfer.begin') {
      manifest = p.manifest
      return { id: 'transfer', offset }
    }
    if (p.kind === 'transfer.chunk') {
      if (failChunk) {
        failChunk = false
        throw new Error('Disconnected')
      }
      offset += Buffer.from(p.data, 'base64').length
      return { offset }
    }
    if (p.kind === 'transfer.finish') return { id: 'c', epoch: 2, hash: manifest.hash }
    if (p.kind === 'migration.verify') return { missing: [] }
    if (p.kind === 'migration.activate') {
      if (activationFailures-- > 0) throw new Error('Disconnected')
      return { ok: true }
    }
  })
  let manifest: ChatTransferManifest
  const migration = createChatMigration({ ownership, source, request })
  return {
    ownership,
    source,
    request,
    migration,
    failActivation: () => {
      activationFailures = 1
    },
    failChunk: () => {
      failChunk = true
    }
  }
}
test('committed migration recovers forward; cleanup waits for activation acknowledgement', async () => {
  const f = await fixture()
  f.failActivation()
  await expect(f.migration.ensure('c', 'pc')).rejects.toThrow('Disconnected')
  expect(await f.ownership.get('c')).toMatchObject({
    state: 'active',
    computerId: 'pc',
    epoch: 2,
    cleanupPending: true
  })
  expect(f.source.cleanup).not.toHaveBeenCalled()
  await f.migration.ensure('c', 'pc')
  expect(f.source.cleanup).toHaveBeenCalledTimes(1)
  expect(await f.ownership.get('c')).toMatchObject({ epoch: 2, cleanupPending: false })
  expect(f.source.open).toHaveBeenCalledTimes(1)
})
test('interrupted copying resumes same migration; concurrent callers share cutover', async () => {
  const f = await fixture()
  f.failChunk()
  await expect(f.migration.ensure('c', 'pc')).rejects.toThrow('Disconnected')
  const saved = await f.ownership.get('c')
  expect(saved).toMatchObject({ state: 'copying', epoch: 1, computerId: null })
  await Promise.all([f.migration.ensure('c', 'pc'), f.migration.ensure('c', 'pc')])
  expect(await f.ownership.get('c')).toMatchObject({
    state: 'active',
    epoch: 2,
    migrationId: saved!.migrationId
  })
  expect(f.source.cleanup).toHaveBeenCalledTimes(1)
})
test('deleted ownership never activates or cleans a concurrent migration', async () => {
  const f = await fixture()
  f.source.quiesce.mockImplementation(async () => {
    await f.ownership.deleteForTask('task')
  })
  await expect(f.migration.ensure('c', 'pc')).rejects.toThrow(/ownership|deleted/i)
  expect(f.source.cleanup).not.toHaveBeenCalled()
  expect(f.request).not.toHaveBeenCalled()
})
