import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'

test('first chat read migrates legacy history then all writes stay on its computer', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-services-'))
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
  })
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
      .run('task', 'p', 'Task', dir)
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,rev,updated_at) VALUES('tab','legacy-private',3,123)"
      )
      .run()
    let live = false
    const requests: unknown[] = []
    const services = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request: (_pc, request) => {
        requests.push(request)
        return pc.request(JSON.parse(JSON.stringify(request)))
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      retentionDays: 2,
      hasLiveTask: async () => live
    })
    expect(await services.relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'legacy-private', rev: 3 }
    })
    expect(requests).toContainEqual({ kind: 'retention.configure', days: 2 })
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_tab_state').get()).toEqual({ n: 0 })
    await services.relay.ops.saveTabDraft('tab', { text: 'new-private', attachments: [] })
    expect(await services.relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'new-private', rev: 4 }
    })
    expect(await services.relay.ops.getInfo('tab', undefined)).toBeNull()
    const owner = await services.ownership.forTab('tab')
    expect(owner).toMatchObject({
      computerId: 'pc',
      state: 'active',
      epoch: 2,
      cleanupPending: false
    })
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('second','task','claude-chat',1)"
      )
      .run()
    live = true
    await Promise.all([
      services.relay.ops.getTabState('second'),
      services.relay.ops.getTabState('second')
    ])
    expect(await services.ownership.forTab('second')).toMatchObject({
      state: 'active',
      epoch: 1,
      computerId: 'pc'
    })
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('third','task','claude-chat',2)"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES('third','idle migration private',1)"
      )
      .run()
    await services.migrateIdleComputer('pc')
    expect(await services.ownership.forTab('third')).toBeNull()
    live = false
    await services.migrateIdleComputer('pc')
    expect(await services.ownership.forTab('third')).toMatchObject({
      state: 'active',
      computerId: 'pc',
      cleanupPending: false
    })
    expect(h.db.prepare("SELECT 1 FROM chat_tab_state WHERE tab_id='third'").get()).toBeUndefined()
    expect(JSON.stringify(h.db.prepare('SELECT * FROM chat_ownership').all())).not.toContain(
      'private'
    )
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('durable ownership gates reject legacy writes and retention deletes during copying', async () => {
  const h = await createTestHarness()
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES('tab','original',1)"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO chat_ownership(id,task_id,tab_id,mode,epoch,state) VALUES('c','task','tab','claude-chat',1,'copying')"
      )
      .run()
    h.db.prepare("INSERT INTO chat_tab_bindings(tab_id,conversation_id) VALUES('tab','c')").run()
    expect(() =>
      h.db.prepare("UPDATE chat_tab_state SET draft_text='lost' WHERE tab_id='tab'").run()
    ).toThrow(/owned|migrat/i)
    expect(() => h.db.prepare("DELETE FROM chat_tab_state WHERE tab_id='tab'").run()).toThrow(
      /migrat/i
    )
    expect(() =>
      h.db
        .prepare(
          "INSERT INTO agent_prompts(id,task_id,agent_id,text,created_at) VALUES('prompt','task','claude-chat','late prompt',1)"
        )
        .run()
    ).toThrow(/owned|migrat/i)
    h.db.prepare("UPDATE chat_ownership SET state='active' WHERE id='c'").run()
    expect(() => h.db.prepare("DELETE FROM chat_tab_state WHERE tab_id='tab'").run()).not.toThrow()
  } finally {
    h.cleanup()
  }
})

test('existing task artifacts are sealed onto the computer before saving a draft', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-sealed-'))
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
  })
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
      .run('task', 'p', 'Task', dir)
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const { createArtifactStore } = await import('@slayzone/task-artifacts/server')
    const file = await createArtifactStore(dir).uploadArtifactBlob(h.slayDb, {
      taskId: 'task',
      title: 'context.txt',
      bytes: Buffer.from('private context')
    })
    const bytes = Buffer.from('private context')
    const services = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => bytes },
      request: (_pc, request) => pc.request(request),
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
    await services.relay.ops.saveTabDraft('tab', {
      text: '',
      attachments: [
        {
          artifactId: file!.id,
          name: 'context.txt',
          kind: 'text',
          mediaType: 'text/plain',
          size: bytes.length
        }
      ]
    })
    const draft = await services.relay.ops.getTabState('tab')
    expect(draft?.draft.attachments[0].contentHash).toMatch(/^[a-f0-9]{64}$/)
    const owner = await services.ownership.forTab('tab')
    expect(
      await pc.request({
        kind: 'attachment.read',
        route: { id: owner!.id, epoch: owner!.epoch },
        ref: draft!.draft.attachments[0]
      })
    ).toEqual({ data: bytes.toString('base64') })
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_tab_state').get()).toEqual({ n: 0 })
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Trash state and final deletion remain durable after task rows disappear', async () => {
  const h = await createTestHarness()
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
    h.db
      .prepare(
        "INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state) VALUES('c','task','tab','claude-chat','pc',1,'active')"
      )
      .run()
    h.db.prepare("UPDATE tasks SET deleted_at=datetime('now') WHERE id='task'").run()
    expect(
      h.db.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='task'").get()
    ).toEqual({ state: 'paused' })
    expect(h.db.prepare("SELECT state FROM chat_ownership WHERE id='c'").get()).toEqual({
      state: 'active'
    })
    h.db.prepare("UPDATE tasks SET deleted_at=NULL WHERE id='task'").run()
    expect(
      h.db.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='task'").get()
    ).toEqual({ state: 'active' })
    h.db.prepare("DELETE FROM tasks WHERE id='task'").run()
    expect(
      h.db.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='task'").get()
    ).toEqual({ state: 'deleted' })
    expect(h.db.prepare("SELECT state,epoch FROM chat_ownership WHERE id='c'").get()).toEqual({
      state: 'deleted',
      epoch: 2
    })
    expect(h.db.prepare('SELECT computer_id,epoch FROM chat_deletion_targets').all()).toEqual([
      { computer_id: 'pc', epoch: 2 }
    ])
  } finally {
    h.cleanup()
  }
})
