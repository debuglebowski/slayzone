import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import {
  listTaskSessions,
  setTaskSessionLedger,
  setTaskSessionPromptReader
} from '@slayzone/task/server'
import { createComputerSessionLedger } from '@slayzone/chat-runtime/hub'
import { taskSessionStore } from './test-session-store'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'

/**
 * A task whose agent runs defers its history migration (`quiesce`), often for
 * days after an upgrade restarts its agents. Its prompt history never waits on
 * it: prompts live only on the computer (robustness plan §9; v207 handed the hub's
 * rows there), so prompt history, prompt summaries and the session list read the
 * computer before, during and after the migration, without duplicates.
 */
async function fixture() {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-live-fallback-'))
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
    .run('task', 'p', 'Task')
  // Task-wide legacy chat content: the task's history migration has work to defer.
  h.db
    .prepare(
      "INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES('task','m1','[]'),('task','m2','[]')"
    )
    .run()
  const pc = createChatRuntimeHandlers({
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
  const state = { live: false, failVerify: false }
  const services = createComputerChatServices({
    db: h.slayDb,
    legacyData: {
      ...createDbChatDataOps(h.slayDb, taskSessionStore),
      buildMcpEnv: async () => ({})
    },
    attachments: { read: async () => new Uint8Array() },
    request: async (_id: string, raw: unknown) => {
      if (state.failVerify && (raw as { kind?: string }).kind === 'migration.verify')
        throw new Error('verify interrupted')
      return pc.request(JSON.parse(JSON.stringify(raw)))
    },
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => state.live
  } as never)
  // The task's session (its ledger is on the computer, robustness plan §9).
  const ledger = createComputerSessionLedger({
    db: h.slayDb,
    request: (_id, raw) => pc.request(JSON.parse(JSON.stringify(raw))),
    target: async () => 'pc',
    usable: () => true,
    flushTask: async () => undefined,
    track: async () => undefined
  })
  setTaskSessionLedger(ledger)
  await ledger.store.recordConversation('pc', {
    taskId: 'task',
    mode: 'claude-code',
    conversationId: 'sess-1',
    origin: 'slay-spawned-fresh',
    createdAt: 1
  })
  setTaskSessionPromptReader((_db, taskId, ids) => services.promptSummaries(taskId, ids))
  // The task's prompts, captured on its computer.
  for (const [text, at] of [
    ['old prompt', 1],
    ['second prompt', 2]
  ] as const)
    await pc.request({
      kind: 'data.import',
      value: {
        kind: 'agent-prompt',
        items: [
          {
            key: `p${at}`,
            taskId: 'task',
            value: {
              id: `p${at}`,
              agentId: 'claude-code',
              cliSessionId: 'sess-1',
              text,
              createdAt: at
            }
          }
        ]
      }
    })
  const sessions = () => listTaskSessions(h.slayDb, 'task', 'claude-code')
  const legacyRows = () =>
    h.db.prepare("SELECT message_id FROM chat_attachment_messages WHERE task_id='task'").all()
  const states = async () => (await services.ownership.forTask('task')).map((o) => o.state)
  return {
    h,
    state,
    services,
    sessions,
    legacyRows,
    states,
    close: async () => {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

afterEach(() => setTaskSessionPromptReader(null))

const expectedPrompts = [
  { id: 'p1', agent_id: 'claude-code', cli_session_id: 'sess-1', text: 'old prompt' },
  { id: 'p2', agent_id: 'claude-code', cli_session_id: 'sess-1', text: 'second prompt' }
]

async function expectHistory(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.services.prompts('task', 'claude-code')).toMatchObject(expectedPrompts)
  expect(await f.services.prompts('task')).toMatchObject(expectedPrompts)
  expect(await f.services.promptSummaries('task', ['sess-1'])).toMatchObject([
    { conversationId: 'sess-1', count: 2, firstPrompt: 'old prompt' }
  ])
  expect(await f.sessions()).toMatchObject([
    { conversationId: 'sess-1', messageCount: 2, firstPrompt: 'old prompt' }
  ])
}

test('live task with unmigrated history: prompts read from the computer before and after migration', async () => {
  const f = await fixture()
  try {
    f.state.live = true
    await expectHistory(f)
    // The migration waits; the legacy content stays on the hub.
    expect(await f.states()).toEqual(['legacy'])
    expect(f.legacyRows()).toHaveLength(2)

    f.state.live = false
    await expectHistory(f)
    // Migration activated and removed the hub rows; nothing is listed twice.
    expect(await f.states()).toEqual(['active'])
    expect(f.legacyRows()).toHaveLength(0)
  } finally {
    await f.close()
  }
})

test('live task whose migration stopped mid-copy still reads its prompts', async () => {
  const f = await fixture()
  try {
    f.state.failVerify = true
    await expect(f.services.prompts('task')).rejects.toThrow('verify interrupted')
    expect(await f.states()).toEqual(['copying'])

    f.state.failVerify = false
    f.state.live = true
    await expectHistory(f)
    expect(await f.states()).toEqual(['copying'])
    expect(f.legacyRows()).toHaveLength(2)

    f.state.live = false
    await expectHistory(f)
    expect(await f.states()).toEqual(['active'])
    expect(f.legacyRows()).toHaveLength(0)
  } finally {
    await f.close()
  }
})

test('a later deferred conversation never blocks the prompts on the computer', async () => {
  const f = await fixture()
  try {
    await expectHistory(f)
    expect(f.legacyRows()).toHaveLength(0)
    // A later, still-unmigrated conversation of the same task defers again.
    await f.services.ownership.register({
      id: 'late',
      taskId: 'task',
      tabId: 'late-tab',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    f.state.live = true
    await expectHistory(f)
  } finally {
    await f.close()
  }
})
