import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createChatRuntimeHandlers } from './chat-runtime'
const dirs: string[] = [],
  handles: Array<ReturnType<typeof createChatRuntimeHandlers>> = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const bootstrap = {
  identity: { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
  projectId: null,
  cwd: realpathSync(tmpdir()),
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}
function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-rpc-'))
  dirs.push(stateDir)
  const notifications: unknown[] = []
  const h = createChatRuntimeHandlers({
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'test',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: {
        notify: (m, p) => {
          notifications.push({ m, p })
          return true
        }
      },
      log: () => {}
    },
    stateDir,
    hubScope: 'hub',
    computerId: () => 'computer',
    getProjectPaths: () => null
  })
  handles.push(h)
  return { h, stateDir, notifications }
}
test('computer endpoints persist drafts and reject foreign tab commands', async () => {
  const { h } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  expect(
    await h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'draft',
        args: ['tab', { text: 'local only', attachments: [] }]
      }
    })
  ).toEqual({ rev: 1 })
  await expect(
    h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'foreign',
        args: ['foreign', { text: 'wrong', attachments: [] }]
      }
    })
  ).rejects.toThrow(/ownership/i)
  expect(
    await h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'getTabState',
        args: ['tab']
      }
    })
  ).toMatchObject({ draft: { text: 'local only' } })
})
test('file listing still obeys the computer allowed-roots guard', async () => {
  const { h } = setup()
  await h.request({ kind: 'bootstrap', value: bootstrap })
  await expect(
    h.request({
      kind: 'invoke',
      value: {
        route: { id: 'store', epoch: 1 },
        target: 'ops',
        method: 'listFiles',
        args: ['/etc', '', 10]
      }
    })
  ).rejects.toThrow()
})

test('authenticated dispatch exposes chat requests and rejects a missing actor', async () => {
  const { createHubRequestHandler } = await import('../main')
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-dispatch-'))
  dirs.push(stateDir)
  const dispatch = createHubRequestHandler({
    stateDir,
    hubScope: 'hub-dispatch',
    getComputerId: () => 'computer',
    shutdown: () => {},
    dialer: { notify: () => true },
    config: {
      hubUrl: 'ws://hub/computers',
      name: 'test',
      allowedRoots: [realpathSync(tmpdir())],
      capabilities: ['proc']
    }
  })
  try {
    await expect(
      dispatch.handle('chat.request', { kind: 'bootstrap', value: bootstrap }, undefined)
    ).rejects.toThrow(/actor|older|protocol/i)
    expect(
      await dispatch.handle(
        'chat.request',
        { kind: 'bootstrap', value: bootstrap },
        { userId: null, route: 'test chat' }
      )
    ).toMatchObject({ ok: true })
  } finally {
    await dispatch.dispose()
  }
})

test('catalog operations execute on the computer and reject unlisted methods and paths', async () => {
  const { h } = setup()
  expect(await h.request({ kind: 'catalog', method: 'getAutocompleteUsage', args: [] })).toEqual({})
  await expect(
    h.request({ kind: 'catalog', method: 'listFiles', args: ['/etc', '', 10] })
  ).rejects.toThrow()
  await expect(
    h.request({
      kind: 'catalog',
      method: 'saveTabDraft',
      args: ['tab', { text: 'bad', attachments: [] }]
    })
  ).rejects.toThrow()
})

test('retention policy accepts whole days, supports disabling and refuses malformed input', async () => {
  const { h } = setup()
  expect(await h.request({ kind: 'retention.configure', days: 14 })).toEqual({ days: 14 })
  expect(await h.request({ kind: 'retention.configure', days: 0 })).toEqual({ days: 0 })
  for (const days of [-1, 1.2, '14'])
    await expect(h.request({ kind: 'retention.configure', days })).rejects.toThrow()
})
