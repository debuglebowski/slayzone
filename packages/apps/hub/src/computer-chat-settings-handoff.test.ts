/**
 * S4: a chat restored after the upgrade reads and starts with its saved settings.
 * The hub staged them (v205, `chat-settings`) for the chat's computer; an invoke of
 * an EXISTING owner (relay `beforeInvoke`) delivers them first — before only new
 * tabs did (resolveComputer → prepare) — and the import tells open chats to re-read.
 * A real hub database, chat services and handoff against a real computer runtime.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAsyncFaultLedger } from '@slayzone/platform/isolation'
import { isComputerUnreachable } from '@slayzone/chat-runtime/hub'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'
import { CHAT_SETTINGS_KIND, createComputerDataHandoff } from './computer-data-handoff'
import { taskSessionStore } from './test-session-store'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

test('an existing chat’s invoke delivers its staged settings first; open chats are told', async () => {
  const h = await createTestHarness()
  cleanups.push(() => h.cleanup())
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-settings-handoff-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','Project','#000');
    INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('task','p','Task',1);
    INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0);`)
  const pc = createChatRuntimeHandlers({
    stateDir: dir,
    hubScope: 'hub',
    computerId: () => 'pc',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: 'pc',
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  } as never)
  cleanups.push(() => pc.close())
  const request = async (_id: string, raw: unknown) => pc.request(JSON.parse(JSON.stringify(raw)))
  const changed: string[] = []
  // As composition wires them: the relay flushes through the handoff, whose
  // delivered settings fire the relay's settings-changed event.
  let handoff: ReturnType<typeof createComputerDataHandoff>
  const chat = createComputerChatServices({
    db: h.slayDb,
    legacyData: {
      ...createDbChatDataOps(h.slayDb, taskSessionStore),
      buildMcpEnv: async () => ({})
    },
    attachments: { read: async () => new Uint8Array() },
    request,
    // As composition: a NEW chat's computer gets the task's rows first (prepare).
    resolveComputer: async (taskId) => {
      await handoff.flushTask(taskId, 'pc')
      return 'pc'
    },
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false,
    flushTask: (taskId, computerId, kinds) => handoff.flushTask(taskId, computerId, kinds)
  })
  handoff = createComputerDataHandoff({
    db: h.slayDb,
    request: (computerId, raw) => chat.lifecycle.request(computerId, raw),
    track: (taskId, computerId) => chat.lifecycle.track(taskId, computerId),
    ledger: (computerId) => createAsyncFaultLedger(h.slayDb, { origin: 'hub', computerId }),
    isUnreachable: isComputerUnreachable,
    fallbackTarget: async () => 'pc',
    delivered: async (kind, taskId) => {
      if (kind === CHAT_SETTINGS_KIND) chat.relay.settingsChanged(taskId)
    }
  })
  chat.relay.events.on('settings-changed', (taskId) => changed.push(taskId))
  // The task's folder, staged for its computer (v210/v211): a decisive kind too.
  h.db
    .prepare(
      `INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
       VALUES('task-path','task','task',json_object('projectId','p','worktreePath',?,'baseDir',NULL,'at',0),0)`
    )
    .run(dir)
  // The chat exists on its computer (opened before the upgrade's rows were delivered).
  await chat.relay.ops.saveTabDraft('tab', { text: '', attachments: [] })
  expect(await chat.ownership.forTab('tab')).toMatchObject({ state: 'active', computerId: 'pc' })
  // The hub's saved settings, staged by v205 for the chat's computer.
  h.db
    .prepare(
      'INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,0)'
    )
    .run(
      CHAT_SETTINGS_KIND,
      'task:claude-chat',
      'task',
      JSON.stringify({ mode: 'claude-chat', settings: { chatMode: 'bypass' } })
    )
  // Reading (or starting) the existing chat delivers them first.
  expect(await chat.relay.ops.getMode('task', 'claude-chat')).toBe('bypass')
  expect(h.db.prepare('SELECT kind FROM computer_data_handoff').all()).toEqual([])
  expect(changed).toEqual(['task'])
})
