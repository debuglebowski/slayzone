/**
 * S5 durable acks: a request whose data the hub hands over (or records as done) is
 * answered only after the computer's store synced it to disk; reads are not.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const events: string[] = []
vi.mock('@slayzone/chat-runtime/server', async (load) => {
  const real = await load<typeof import('@slayzone/chat-runtime/server')>()
  return {
    ...real,
    createComputerChatRuntime: (o: Parameters<typeof real.createComputerChatRuntime>[0]) => {
      const r = real.createComputerChatRuntime(o)
      const flush = r.storage.flush.bind(r.storage)
      r.storage.flush = async () => {
        events.push('flush:start')
        await flush()
        events.push('flush:done')
      }
      return r
    }
  }
})

import { createFixtureChatRuntime } from '../project-scope.fixture'
import { durableAck } from './chat-runtime'

const dirs: string[] = []
const handles: Array<ReturnType<typeof createFixtureChatRuntime>> = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  events.length = 0
})
function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-ack-'))
  dirs.push(stateDir)
  const h = createFixtureChatRuntime({
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'test',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    },
    stateDir,
    hubScope: 'hub',
    computerId: () => 'computer',
    getProjectPaths: () => null
  })
  handles.push(h)
  return h
}
const bootstrap = {
  identity: { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
  projectId: null,
  cwd: realpathSync(tmpdir()),
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}

test('a handed-over write is answered after the off-thread sync; a read is not held', async () => {
  const h = setup()
  const answered = async (raw: unknown) => {
    events.length = 0
    await h.request(raw)
    events.push('answered')
    return [...events]
  }
  /** Answered right after a completed sync, and no sync still running then. */
  const afterSync = (seen: string[]) => {
    expect(seen.at(-1)).toBe('answered')
    expect(seen.at(-2)).toBe('flush:done')
    expect(seen.filter((e) => e === 'flush:start').length).toBe(
      seen.filter((e) => e === 'flush:done').length
    )
  }
  // Creation: the hub activates the chat only once the computer acknowledged it.
  afterSync(await answered({ kind: 'bootstrap', value: bootstrap }))
  // A chat command that mutates (operation id): the same.
  afterSync(
    await answered({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'op-1',
        args: ['tab', { text: 'draft', attachments: [] }]
      }
    })
  )
  // Reads: answered at once.
  expect(await answered({ kind: 'inventory' })).toEqual(['answered'])
  expect(
    await answered({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'getReplay',
        args: ['tab', -1]
      }
    })
  ).toEqual(['answered'])
})

test('the durable-ack classification', () => {
  for (const kind of [
    'attachment.put',
    'data.import',
    'migration.activate',
    'transfer.finish',
    'task.erase'
  ])
    expect(durableAck({ kind }), kind).toBe(true)
  for (const kind of [
    'inventory',
    'metadata.snapshot',
    'ackMetadata',
    'archive.read',
    'storage.status'
  ])
    expect(durableAck({ kind }), kind).toBe(false)
  expect(durableAck({ kind: 'artifact.invoke', value: { operationId: 'x' } })).toBe(true)
  expect(durableAck({ kind: 'artifact.invoke', value: { method: 'readBytes' } })).toBe(false)
})
