import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { deleteTab } from '@slayzone/task-terminals/server'
import {
  createChatMigration,
  createChatOwnershipStore,
  createLegacyChatSource
} from '@slayzone/chat-runtime/server'
import type { ChatRecord } from '@slayzone/chat-runtime/shared'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

/** The task-wide attachment messages the computer's chat store holds (by message id). */
function copiedTaskContent(dir: string): Array<{ id: string }> {
  const store = new Database(
    join(
      dir,
      'computer-runtime',
      createHash('sha256').update(JSON.stringify('review')).digest('hex'),
      'chat.sqlite'
    ),
    { readonly: true }
  )
  try {
    return store
      .prepare(
        "SELECT substr(id,20) AS id FROM records WHERE kind='settings' AND id GLOB 'attachment-message:*'"
      )
      .all() as Array<{ id: string }>
  } finally {
    store.close()
  }
}

test('review: closing the original content leader cannot erase task content excluded from a sibling transfer', async () => {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-migration-leader-review-'))
  const pc = createFixtureChatRuntime({
    taskFolder: () => dir,
    stateDir: dir,
    hubScope: 'review',
    computerId: () => 'pc',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://review/computers',
        name: 'review',
        allowedRoots: [dir],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  })
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db
      .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('task','p','Task',1)")
      .run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at) VALUES('a','task','claude-chat',0,'2026-01-01')"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at) VALUES('b','task','codex-chat',1,'2026-01-02')"
      )
      .run()
    // Task-wide legacy content (prompts left this census in v207: handed off directly).
    h.db
      .prepare(
        "INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES('task','retained-message','[]')"
      )
      .run()
    const ownership = createChatOwnershipStore(h.slayDb)
    for (const [tabId, mode] of [
      ['a', 'claude-chat'],
      ['b', 'codex-chat']
    ] as const)
      await ownership.register({
        id: `store-${tabId}`,
        taskId: 'task',
        tabId,
        mode,
        epoch: 1,
        computerId: null
      })
    let closedLeader = false
    const request = async (_computerId: string, raw: unknown) => {
      const req = JSON.parse(JSON.stringify(raw)) as { kind: string }
      const result = await pc.request(req)
      if (req.kind === 'migration.activate' && !closedLeader) {
        closedLeader = true
        // Real SQLite tab-deletion trigger fences a's owner. The task remains.
        expect(await deleteTab(h.slayDb, 'a')).toBe(true)
      }
      return result
    }
    const source = createLegacyChatSource({
      db: h.slayDb,
      quiesce: async () => {},
      bootstrap: async (owner) => ({
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: owner.epoch + 1
        },
        projectId: 'p',
        cwd: dir,
        revision: 0,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      freezeMetadata: (owner, migrationId, candidate) =>
        request('pc', {
          kind: 'migration.checkpoint',
          identity: {
            id: owner.id,
            taskId: owner.taskId,
            tabId: owner.tabId,
            mode: owner.mode,
            epoch: owner.epoch
          },
          migrationId,
          ...(candidate ? { candidate } : {})
        }) as Promise<ChatRecord[] | null>,
      readAttachment: async () => {
        throw new Error('No attachments')
      }
    })
    await createChatMigration({ ownership, source, request }).ensure('store-b', 'pc')
    expect(closedLeader).toBe(true)
    expect(await ownership.get('store-a')).toMatchObject({ state: 'deleted' })
    const remaining = h.db
      .prepare("SELECT message_id AS id FROM chat_attachment_messages WHERE task_id='task'")
      .all() as { id: string }[]
    expect([...copiedTaskContent(dir), ...remaining].map((row) => row.id)).toContain(
      'retained-message'
    )
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('review: normal hub migration and tab close preserve task-wide content', async () => {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-migration-services-review-'))
  const pc = createFixtureChatRuntime({
    taskFolder: () => dir,
    stateDir: dir,
    hubScope: 'review',
    computerId: () => 'pc',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://review/computers',
        name: 'review',
        allowedRoots: [dir],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  })
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db
      .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('task','p','Task',1)")
      .run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at,is_main) VALUES('main','task','terminal',0,'2025-01-01',1)"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at) VALUES('a','task','claude-chat',1,'2026-01-01')"
      )
      .run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at) VALUES('b','task','codex-chat',2,'2026-01-02')"
      )
      .run()
    // Task-wide legacy content (prompts left this census in v207: handed off directly).
    h.db
      .prepare(
        "INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES('task','retained-message','[]')"
      )
      .run()
    let closedLeader = false
    const services = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: {
        read: async () => {
          throw new Error('No attachments')
        }
      },
      request: async (_computerId, raw) => {
        const req = JSON.parse(JSON.stringify(raw)) as { kind: string }
        const result = await pc.request(req)
        if (req.kind === 'migration.activate' && !closedLeader) {
          closedLeader = true
          expect(await deleteTab(h.slayDb, 'a')).toBe(true)
        }
        return result
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    })
    // IDs are UUIDs in production, so either ordering is possible.
    await services.ownership.register({
      id: 'z-store-a',
      taskId: 'task',
      tabId: 'a',
      mode: 'claude-chat',
      epoch: 1,
      computerId: null
    })
    await services.ownership.register({
      id: 'a-store-b',
      taskId: 'task',
      tabId: 'b',
      mode: 'codex-chat',
      epoch: 1,
      computerId: null
    })
    // Tab a closing mid-migration fails a's migration alone: b opens at once.
    await expect(services.relay.ensureTab('b')).resolves.toMatchObject({ state: 'active' })
    const remaining = h.db
      .prepare("SELECT message_id AS id FROM chat_attachment_messages WHERE task_id='task'")
      .all() as { id: string }[]
    expect([...copiedTaskContent(dir), ...remaining].map((row) => row.id)).toContain(
      'retained-message'
    )
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Since v206 (robustness plan §9) a legacy chat's session history reaches its
// computer through the handoff, not through the chat migration; since v208 the hub
// keeps no provider bindings at all — which chat holds a session is its computer's
// answer (`chatSessionOwner`).
test('review: legacy providers with different recorded computers reconnect without cross-claiming sessions', async () => {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-migration-providers-review-'))
  const computers = new Map(
    ['pc1', 'pc2'].map((computerId) => [
      computerId,
      createFixtureChatRuntime({
        taskFolder: () => dir,
        stateDir: join(dir, computerId),
        hubScope: 'review',
        computerId: () => computerId,
        getProjectPaths: () => null,
        ctx: {
          config: {
            hubUrl: 'ws://review/computers',
            name: 'review',
            allowedRoots: [dir],
            capabilities: ['proc']
          },
          dialer: { notify: () => true },
          log: () => {}
        }
      })
    ])
  )
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db
      .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('task','p','Task',1)")
      .run()
    for (const [tab, mode, computerId, session] of [
      ['a', 'claude-chat', 'pc1', 'claude-session'],
      ['b', 'codex-chat', 'pc2', 'codex-session']
    ]) {
      h.db
        .prepare('INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,?,?,0)')
        .run(tab, 'task', mode)
      h.db
        .prepare(
          "INSERT INTO chat_workspace_changes(id,tab_id,message_id,computer_id,root_path,status,created_at) VALUES(?,?,?,?,?,'captured',1)"
        )
        .run(`capture-${tab}`, tab, 'message', computerId, dir)
      // What migration v196 backfilled from that legacy row (the read authority).
      h.db
        .prepare('INSERT INTO chat_legacy_tab_computers(tab_id,computer_id) VALUES(?,?)')
        .run(tab, computerId)
      // Its session ledger reaches its computer by the handoff (robustness plan §9).
      void session
    }
    const services = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: {
        read: async () => {
          throw new Error('No attachments')
        }
      },
      request: (computerId, raw) =>
        computers.get(computerId)!.request(JSON.parse(JSON.stringify(raw))),
      resolveComputer: async () => 'pc2',
      defaultComputer: async () => 'pc2',
      hasLiveTask: async () => false
    })
    await services.relay.ensureTab('a')
    expect(await services.ownership.forTab('a')).toMatchObject({
      computerId: 'pc1',
      state: 'active'
    })
    expect(await services.ownership.forTab('b')).toMatchObject({
      computerId: 'pc2',
      state: 'active'
    })
    await services.recoverComputer('pc1', true)
    await expect(services.recoverComputer('pc2', true)).resolves.toBeUndefined()
    // No chat claims the other computer's session.
    expect(
      await computers.get('pc1')!.request({
        kind: 'ledger',
        value: { op: 'chatSessionOwner', args: { sessionId: 'codex-session', mode: 'codex' } }
      })
    ).toBeNull()
  } finally {
    for (const computer of computers.values()) await computer.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each([
  ['archived_at', 'before-request'],
  ['archived_at', 'lost-ack'],
  ['deleted_at', 'before-request'],
  ['deleted_at', 'lost-ack']
] as const)(
  'review: reserved first bootstrap survives %s then restore after %s',
  async (column, fault) => {
    const h = await createTestHarness()
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-bootstrap-paused-review-'))
    const openComputer = () =>
      createFixtureChatRuntime({
        taskFolder: () => dir,
        stateDir: dir,
        hubScope: 'review',
        computerId: () => 'pc',
        getProjectPaths: () => null,
        ctx: {
          config: {
            hubUrl: 'ws://review/computers',
            name: 'review',
            allowedRoots: [dir],
            capabilities: ['proc']
          },
          dialer: { notify: () => true },
          log: () => {}
        }
      })
    let pc = openComputer()
    try {
      h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
      for (const [taskId, tabId] of [
        ['task', 'tab'],
        ['healthy', 'healthy-tab']
      ]) {
        h.db
          .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
          .run(taskId, 'p', taskId)
        h.db
          .prepare(
            "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,?,'claude-chat',0)"
          )
          .run(tabId, taskId)
      }
      let failBootstrap = true
      const services = () =>
        createComputerChatServices({
          db: h.slayDb,
          legacyData: {
            ...createDbChatDataOps(h.slayDb, taskSessionStore),
            buildMcpEnv: async () => ({})
          },
          attachments: {
            read: async () => {
              throw new Error('No attachments')
            }
          },
          request: async (_computerId, raw) => {
            const req = JSON.parse(JSON.stringify(raw)) as { kind: string }
            if (req.kind === 'bootstrap' && failBootstrap && fault === 'before-request') {
              failBootstrap = false
              throw new Error('Bootstrap interruption before-request')
            }
            const result = await pc.request(req)
            if (req.kind === 'bootstrap' && failBootstrap && fault === 'lost-ack') {
              failBootstrap = false
              throw new Error('Bootstrap interruption lost-ack')
            }
            return result
          },
          resolveComputer: async () => 'pc',
          defaultComputer: async () => 'pc',
          hasLiveTask: async () => false
        })
      const before = services()
      await expect(before.relay.ensureTab('tab')).rejects.toThrow(`Bootstrap interruption ${fault}`)
      const reservation = (await before.ownership.forTab('tab'))!
      expect(reservation).toMatchObject({
        state: 'legacy',
        computerId: null,
        epoch: 1,
        destinationComputerId: 'pc'
      })
      expect(await before.ownership.bootstrapReservation(reservation.id)).toEqual({
        computerId: 'pc',
        epoch: 1
      })
      const route = { id: reservation.id, epoch: reservation.epoch }
      if (fault === 'lost-ack') {
        await pc.request({
          kind: 'invoke',
          value: {
            route,
            target: 'ops',
            method: 'saveTabDraft',
            args: ['tab', { text: 'durable before archive', attachments: [] }],
            operationId: 'pre-archive-draft'
          }
        })
      } else {
        expect(await pc.request({ kind: 'inspect', id: reservation.id })).toBeNull()
      }
      h.db.prepare(`UPDATE tasks SET ${column}=datetime('now') WHERE id='task'`).run()
      await pc.close()
      pc = openComputer()
      const paused = services()
      await expect(paused.recoverComputer('pc')).resolves.toBeUndefined()
      expect(await paused.ownership.forTab('tab')).toMatchObject({
        id: reservation.id,
        state: 'active',
        computerId: 'pc',
        epoch: 1
      })
      expect(await paused.ownership.bootstrapReservation(reservation.id)).toBeUndefined()
      expect(await paused.ownership.unavailable(reservation.id)).toBeUndefined()
      expect(() => pc.assertTaskActive('task')).toThrow(/paused/i)
      const saved = await paused.relay.ops.getTabState('tab')
      if (fault === 'lost-ack')
        expect(saved).toMatchObject({ draft: { text: 'durable before archive' } })
      else expect(saved).toBeNull()
      await expect(
        paused.relay.ops.saveTabDraft('tab', { text: 'blocked', attachments: [] })
      ).rejects.toThrow(/paused/i)
      await expect(
        paused.relay.ops.saveTabDraft('healthy-tab', {
          text: 'healthy task still works',
          attachments: []
        })
      ).resolves.toBeDefined()
      expect(h.db.prepare("SELECT id FROM terminal_tabs WHERE task_id='task'").all()).toEqual([
        { id: 'tab' }
      ])

      h.db.prepare(`UPDATE tasks SET ${column}=NULL WHERE id='task'`).run()
      await pc.close()
      pc = openComputer()
      const restored = services()
      await expect(restored.recoverComputer('pc')).resolves.toBeUndefined()
      expect(() => pc.assertTaskActive('task')).not.toThrow()
      expect(await restored.ownership.forTab('tab')).toMatchObject({
        id: reservation.id,
        state: 'active',
        computerId: 'pc',
        epoch: 1
      })
      const retained = await restored.relay.ops.getTabState('tab')
      if (fault === 'lost-ack')
        expect(retained).toMatchObject({ draft: { text: 'durable before archive' } })
      else expect(retained).toBeNull()
      await expect(
        restored.relay.ops.saveTabDraft('tab', { text: 'after restore', attachments: [] })
      ).resolves.toBeDefined()
      expect(await restored.relay.ops.getTabState('tab')).toMatchObject({
        draft: { text: 'after restore' }
      })
      expect(
        h.db.prepare("SELECT COUNT(*) AS n FROM chat_ownership WHERE task_id='task'").get()
      ).toEqual({ n: 1 })
    } finally {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
