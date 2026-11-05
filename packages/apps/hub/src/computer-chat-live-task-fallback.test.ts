import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import {
  listTaskSessions,
  setTaskSessionPromptReader,
  taskSessionStore
} from '@slayzone/task/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'

/**
 * A task whose agent runs defers its history migration (`quiesce`), often for
 * days after an upgrade restarts its agents. Until the migration activates, the
 * hub's legacy rows stay the source: prompt history, prompt summaries and the
 * session list serve them read-only instead of failing. After activation the
 * same reads come from the computer, without duplicates.
 */
async function fixture() {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-live-fallback-'))
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
    .run('task', 'p', 'Task', dir)
  h.db
    .prepare(
      "INSERT INTO agent_prompts(id,task_id,agent_id,cli_session_id,text,created_at) VALUES('p1','task','claude-code','sess-1','old prompt',1),('p2','task','claude-code','sess-1','second prompt',2)"
    )
    .run()
  h.db
    .prepare(
      "INSERT INTO agent_sessions(id,mode,cwd,task_id,conversation_id,origin,status,created_at,bound_at) VALUES('s1','claude-code','/p','task','sess-1','slay-spawned-fresh','dead',1,1)"
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
  setTaskSessionPromptReader((_db, taskId, ids) => services.promptSummaries(taskId, ids))
  const sessions = () => listTaskSessions(h.slayDb, 'task', 'claude-code')
  const legacyRows = () => h.db.prepare("SELECT id FROM agent_prompts WHERE task_id='task'").all()
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

test('live task with unmigrated history: reads serve hub rows, then the computer after migration', async () => {
  const f = await fixture()
  try {
    f.state.live = true
    await expectHistory(f)
    // Served read-only: nothing migrated, the hub rows stay the source.
    expect(await f.states()).toEqual(['legacy'])
    expect(f.legacyRows()).toHaveLength(2)

    f.state.live = false
    await expectHistory(f)
    // The same reads now come from the computer: migration activated and
    // removed the hub rows, and nothing is listed twice.
    expect(await f.states()).toEqual(['active'])
    expect(f.legacyRows()).toHaveLength(0)
  } finally {
    await f.close()
  }
})

test('live task whose migration stopped mid-copy still reads its hub rows', async () => {
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

test('hub rows are never served once the task prompts moved to the computer', async () => {
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
    await expect(f.services.prompts('task')).rejects.toThrow('waits for this task')
    await expect(f.services.promptSummaries('task', ['sess-1'])).rejects.toThrow(
      'waits for this task'
    )
  } finally {
    await f.close()
  }
})
