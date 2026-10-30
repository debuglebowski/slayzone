/**
 * Codex chat models through the chat ops (X1): the models the Codex CLI offers
 * the account (`cli-models`, stored per project + mode) are what `getModels`
 * lists and what a stored model is checked against — never the hardcoded list,
 * whose default (`gpt-5.5`) a ChatGPT login refuses.
 */
import { afterEach, expect, test } from 'vitest'
import type Database from 'better-sqlite3'
import type { ChatModelInfo } from '@slayzone/terminal-contracts'
import { createChatOps } from './chat-handlers'
import { createDbChatDataOps } from './chat-data-ops'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import * as mgr from './chat-transport-manager'
import {
  createSlayzoneDbAdapter,
  createTestHarness
} from '../../../../../shared/test-utils/ipc-harness.js'

const MODELS: ChatModelInfo[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    supportsEffort: true,
    isDefault: true,
    defaultEffort: 'low',
    efforts: [{ id: 'low', label: 'Low' }]
  },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', supportsEffort: true, isDefault: false, efforts: [] }
]

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

async function setup(providerConfig: Record<string, unknown> = {}) {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  const db: Database.Database = (await createTestHarness()).db
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, color) VALUES ('proj-1', 'P', '#000')"
  ).run()
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, provider_config) VALUES ('task-cx', 'proj-1', 'T', ?)"
  ).run(JSON.stringify({ 'codex-chat': providerConfig }))
  const data = createDbChatDataOps(createSlayzoneDbAdapter(db), createFakeTaskSessionStore())
  const ops = createChatOps({ dataOps: data })
  return { db, data, ops }
}

test('getModels: Claude lists its fixed models; Codex lists nothing until its CLI reported', async () => {
  const { ops } = await setup()
  expect((await ops.getModels('task-cx', 'claude-chat')).map((m) => m.id)).toEqual([
    'opus',
    'sonnet',
    'haiku'
  ])
  expect(await ops.getModels('task-cx', 'codex-chat')).toEqual([])
})

test('getModels: Codex lists what its CLI last reported for the project', async () => {
  const { ops, data } = await setup()
  await data.saveCliModels('task-cx', 'codex-chat', MODELS)
  expect(await ops.getModels('task-cx', 'codex-chat')).toEqual(MODELS)
})

test('getModel (Codex): nothing stored → the account’s default from its list, never gpt-5.5', async () => {
  const { ops, data } = await setup()
  expect(await ops.getModel('task-cx', 'codex-chat')).toBe('')
  await data.saveCliModels('task-cx', 'codex-chat', MODELS)
  expect(await ops.getModel('task-cx', 'codex-chat')).toBe('gpt-6.1-sol')
})

test('getModel (Codex): a stored model the account offers stays; one it does not offer gives way', async () => {
  const offered = await setup({ chatModel: 'gpt-6-luna' })
  await offered.data.saveCliModels('task-cx', 'codex-chat', MODELS)
  expect(await offered.ops.getModel('task-cx', 'codex-chat')).toBe('gpt-6-luna')

  const stale = await setup({ chatModel: 'gpt-5.5' })
  await stale.data.saveCliModels('task-cx', 'codex-chat', MODELS)
  expect(await stale.ops.getModel('task-cx', 'codex-chat')).toBe('gpt-6.1-sol')
})

test('setModel (Codex): a model of the CLI’s list is accepted, one outside it refused', async () => {
  const { ops, data, db } = await setup()
  await data.saveCliModels('task-cx', 'codex-chat', MODELS)
  const o = { tabId: 'tab-cx', taskId: 'task-cx', mode: 'codex-chat', cwd: '/tmp' }
  await mgr.hydrateSession({ ...o, conversationId: null, providerFlags: [] })
  await expect(ops.setModel({ ...o, chatModel: 'gpt-4-nope' })).rejects.toThrow(/model/i)
  await ops.setModel({ ...o, chatModel: 'gpt-6-luna' })
  const row = db.prepare("SELECT provider_config FROM tasks WHERE id = 'task-cx'").get() as {
    provider_config: string
  }
  expect(JSON.parse(row.provider_config)['codex-chat'].chatModel).toBe('gpt-6-luna')
})

test('a cli-models event from a Codex process is stored for its project', async () => {
  const { ops } = await setup()
  await mgr.hydrateSession({
    tabId: 'tab-ev',
    taskId: 'task-cx',
    mode: 'codex-chat',
    cwd: '/tmp',
    conversationId: null,
    providerFlags: []
  })
  mgr.chatEvents.emit('event', 'tab-ev', { kind: 'cli-models', models: MODELS }, 0, 1)
  for (let i = 0; i < 50 && (await ops.getModels('task-cx', 'codex-chat')).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(await ops.getModels('task-cx', 'codex-chat')).toEqual(MODELS)
})

test('setEffort (Codex): an effort a model of the CLI’s list offers (ultra) is accepted; others refused', async () => {
  const { ops, data, db } = await setup()
  await data.saveCliModels('task-cx', 'codex-chat', [
    {
      ...MODELS[0],
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'ultra', label: 'Ultra' }
      ]
    }
  ])
  const o = { tabId: 'tab-ef', taskId: 'task-cx', mode: 'codex-chat', cwd: '/tmp' }
  await mgr.hydrateSession({ ...o, conversationId: null, providerFlags: [] })
  await expect(ops.setEffort({ ...o, chatEffort: 'banana' })).rejects.toThrow(/effort/i)
  await ops.setEffort({ ...o, chatEffort: 'ultra' })
  const row = db.prepare("SELECT provider_config FROM tasks WHERE id = 'task-cx'").get() as {
    provider_config: string
  }
  expect(JSON.parse(row.provider_config)['codex-chat'].chatEffort).toBe('ultra')
  expect(await ops.getEffort('task-cx', 'codex-chat')).toBe('ultra')
})
