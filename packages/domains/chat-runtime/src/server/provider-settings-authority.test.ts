/**
 * Chat settings live only on the computer (robustness plan §9, P0 / decision 2).
 *
 * The hub's `provider_config` chat keys are starting values: they seed a chat whose
 * (task, mode) has no computer row yet, and are never applied over the computer's
 * own values afterwards. The computer never reports chat settings back. Terminal
 * keys the hub still owns (flags, the terminal session id) keep flowing hub →
 * computer, unless the computer holds an unacknowledged newer terminal session id.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { ChatBootstrap } from './local-data'
import { createComputerChatRuntime } from './computer-runtime'
import type { ChatMetadataUpdate } from './local-data'

const dirs: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function runtime(updates: ChatMetadataUpdate[] = []) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-settings-authority-'))
  dirs.push(dir)
  const r = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'settings',
    computerId: 'pc',
    onMetadata: (u) => updates.push(u)
  })
  runtimes.push(r)
  return r
}
const identity = { id: 'c1', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
function boot(
  r: ReturnType<typeof runtime>,
  revision: number,
  providerConfig: ChatBootstrap['providerConfig'],
  terminalProviderConfig?: Record<string, unknown>
) {
  r.bootstrap({
    identity,
    projectId: null,
    cwd: '/tmp',
    revision,
    providerConfig,
    ...(terminalProviderConfig ? { terminalProviderConfig } : {}),
    defaultFlags: null,
    env: {}
  })
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a new chat starts from the hub starting values', async () => {
  const r = runtime()
  boot(r, 1, { chatModel: 'seed-model', chatEffort: 'high', flags: '--x' })
  expect(await r.local.data.readProviderConfig('task', 'claude-chat')).toMatchObject({
    chatModel: 'seed-model',
    chatEffort: 'high',
    flags: '--x'
  })
})

test('later bootstraps never apply hub chat settings over the computer values', async () => {
  const r = runtime()
  boot(r, 1, { chatModel: 'seed-model' })
  await r.local.data.writeChatModel('task', 'claude-chat', 'picked-model')
  await r.local.data.writeChatFastMode('task', 'claude-chat', true)
  // A newer bootstrap (any hub-side change bumps it) still carrying the old seed.
  boot(r, 5, { chatModel: 'seed-model', chatFastMode: false, flags: '--new-flags' })
  expect(await r.local.data.readProviderConfig('task', 'claude-chat')).toMatchObject({
    chatModel: 'picked-model',
    chatFastMode: true,
    // Spawn flags stay hub-owned.
    flags: '--new-flags'
  })
})

/** Metadata kinds the hub no longer takes (v205/v206/v208): their data is the computer's. */
const RETIRED: ReadonlySet<string> = new Set(['provider-config', 'conversation', 'queue-item'])

test('chat settings and the chat session id are never reported to the hub', async () => {
  const updates: ChatMetadataUpdate[] = []
  const r = runtime(updates)
  boot(r, 1, {})
  await r.local.data.writeChatModel('task', 'claude-chat', 'm')
  await r.local.data.writeChatMode('task', 'claude-chat', 'plan')
  await r.local.data.writeChatEffort('task', 'claude-chat', 'low')
  await r.local.data.writeChatCollaboration('task', 'claude-chat', 'plan')
  await r.local.data.writeChatFastMode('task', 'claude-chat', true)
  await r.local.data.recordConversation({
    taskId: 'task',
    mode: 'claude-chat',
    conversationId: '11111111-1111-4111-8111-111111111111',
    origin: 'slay-spawned-fresh',
    legacyJsonField: 'chatConversationId'
  })
  await flush()
  expect(updates.filter((u) => RETIRED.has(u.kind))).toEqual([])
  const snapshot = r.local.metadataSnapshot('c1')
  expect(snapshot.updates.filter((u) => RETIRED.has(u.kind))).toEqual([])
})

test('the terminal session id is never reported to the hub: the computer ledger holds it', async () => {
  const updates: ChatMetadataUpdate[] = []
  const r = runtime(updates)
  boot(r, 1, {}, { flags: '' })
  await r.local.data.recordConversation({
    taskId: 'task',
    mode: 'claude-code',
    conversationId: '22222222-2222-4222-8222-222222222222',
    origin: 'slay-spawned-resume'
  })
  await flush()
  expect(updates.filter((u) => RETIRED.has(u.kind))).toEqual([])
  expect(await r.local.data.getCurrentConversationId('task', 'claude-code')).toBe(
    '22222222-2222-4222-8222-222222222222'
  )
})

test('a hub bootstrap never sets the terminal session id (only its flags)', async () => {
  const updates: ChatMetadataUpdate[] = []
  const r = runtime(updates)
  boot(r, 1, {}, { flags: '', conversationId: 'hub-1' })
  boot(r, 2, {}, { flags: '--f', conversationId: 'hub-2' })
  const config = await r.local.data.readProviderConfig('task', 'claude-code')
  expect(config.flags).toBe('--f')
  expect(config.conversationId ?? null).toBeNull()
  expect(await r.local.data.getCurrentConversationId('task', 'claude-code')).toBeNull()
})

test('the hub reads chat settings from the computer (task data)', async () => {
  const r = runtime()
  boot(r, 1, { chatModel: 'seed' })
  await r.local.data.writeChatModel('task', 'claude-chat', 'live')
  expect(r.taskData.read('task', { kind: 'providerConfig', mode: 'claude-chat' })).toMatchObject({
    chatModel: 'live'
  })
})
