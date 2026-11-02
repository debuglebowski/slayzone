import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

const dirs: string[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function runtime(stateDir = mkdtempSync(join(tmpdir(), 'slz-computer-chat-')), hubScope = 'hub-a') {
  if (!dirs.includes(stateDir)) dirs.push(stateDir)
  const r = createComputerChatRuntime({ stateDir, hubScope, computerId: 'computer-a' })
  runtimes.push(r)
  return { r, stateDir }
}
const bootstrap = {
  identity: { id: 'storage-a', taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', epoch: 1 },
  projectId: 'project-a',
  cwd: '/tmp',
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}
const createOpts = { taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', cwd: '/tmp' }

test('drafts persist on computer and restore without a hub database', async () => {
  const { r, stateDir } = runtime()
  r.bootstrap(bootstrap)
  await r.ops.hydrate(createOpts)
  expect(await r.ops.saveTabDraft('tab-a', { text: 'private draft', attachments: [] })).toEqual({
    rev: 1
  })
  await r.close()
  const next = runtime(stateDir).r
  next.bootstrap(bootstrap)
  expect((await next.ops.getTabState('tab-a'))?.draft.text).toBe('private draft')
})

test('two hubs can use the same task and tab ids without sharing chat content', async () => {
  const a = runtime(),
    b = runtime(a.stateDir, 'hub-b')
  a.r.bootstrap(bootstrap)
  b.r.bootstrap(bootstrap)
  await a.r.ops.saveTabDraft('tab-a', { text: 'hub-a-only', attachments: [] })
  expect((await b.r.ops.getTabState('tab-a'))?.draft.text ?? '').toBe('')
})
