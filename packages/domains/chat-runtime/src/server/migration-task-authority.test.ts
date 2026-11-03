import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createComputerChatServices } from '../../../../apps/hub/src/computer-chat'
import { createChatRuntimeHandlers } from '../../../../apps/computer/src/handlers/chat-runtime'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { deleteTab } from '../../../task-terminals/src/server/tabs-store'

test.each(['before-snapshot', 'after-prepare', 'after-commit'] as const)(
  'task content authority survives original tab closure %s and completes source cleanup',
  async (phase) => {
    const h = await createTestHarness()
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'task-content-authority-'))
    const pc = createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://test/computers',
          name: 'test',
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
        .prepare("INSERT INTO tasks(id,project_id,title,worktree_path) VALUES('task','p','Task',?)")
        .run(dir)
      h.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at) VALUES('a','task','claude-chat',0,'2020-01-01')"
        )
        .run()
      h.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position,created_at) VALUES('b','task','codex-chat',1,'2020-01-02')"
        )
        .run()
      h.db
        .prepare(
          "INSERT INTO agent_prompts(id,task_id,agent_id,text,created_at) VALUES('prompt','task','claude-code','retained task-wide prompt',1)"
        )
        .run()
      let closed = false
      const close = async () => {
        if (!closed) {
          closed = true
          expect(await deleteTab(h.slayDb, 'a')).toBe(true)
        }
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
        request: async (_id, raw) => {
          const req = JSON.parse(JSON.stringify(raw)) as {
            kind: string
            id?: string
            identity?: { id: string }
          }
          if (
            phase === 'before-snapshot' &&
            req.kind === 'migration.checkpoint' &&
            req.identity?.id === 'b-store'
          )
            await close()
          const result = await pc.request(req)
          if (
            phase === 'after-prepare' &&
            req.kind === 'transfer.finish' &&
            (result as { id?: string }).id === 'b-store'
          )
            await close()
          if (phase === 'after-commit' && req.kind === 'migration.activate' && req.id === 'b-store')
            await close()
          return result
        },
        resolveComputer: async () => 'pc',
        defaultComputer: async () => 'pc',
        hasLiveTask: async () => false
      })
      await services.ownership.register({
        id: 'z-original',
        taskId: 'task',
        tabId: 'a',
        mode: 'claude-chat',
        epoch: 1,
        computerId: null
      })
      await services.ownership.register({
        id: 'b-store',
        taskId: 'task',
        tabId: 'b',
        mode: 'codex-chat',
        epoch: 1,
        computerId: null
      })
      await services.relay
        .ensureTab('b')
        .catch((error) => expect(String(error)).toMatch(/deleted|missing/i))
      await services.migrateIdleComputer('pc')
      expect(closed).toBe(true)
      const authority = h.db
        .prepare('SELECT conversation_id FROM chat_legacy_task_authority WHERE task_id=?')
        .get('task') as { conversation_id: string }
      expect(await services.ownership.get(authority.conversation_id)).toMatchObject({
        tabId: 'task-content:task',
        state: 'active',
        cleanupPending: false
      })
      expect(await pc.request({ kind: 'prompts', taskId: 'task' })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'prompt', text: 'retained task-wide prompt' })
        ])
      )
      expect(
        h.db.prepare("SELECT COUNT(*) AS n FROM agent_prompts WHERE task_id='task'").get()
      ).toEqual({ n: 0 })
      expect(
        h.db.prepare("SELECT id FROM terminal_tabs WHERE id='task-content:task'").get()
      ).toBeUndefined()
      expect(await services.ownership.get('z-original')).toMatchObject({ state: 'deleted' })
    } finally {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
