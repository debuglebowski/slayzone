import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrations } from '@slayzone/db-migrations'
import { openChatStorage } from '@slayzone/chat-runtime/server'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { bootstrapSchema } from './bootstrap-schema'
import { createComputerChatServices } from './computer-chat'

test.each([171, 177, 182, 186])(
  'review: upgrade schema %i retains mixed-mode history, drafts and prompts (staged) across reconnect',
  async (version) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'chat-released-upgrade-review-'))
    const db = new Database(join(root, 'hub.sqlite'))
    db.pragma('journal_mode=WAL')
    db.pragma('foreign_keys=ON')
    const openComputer = () =>
      createChatRuntimeHandlers({
        stateDir: root,
        hubScope: 'released-review',
        computerId: () => 'pc',
        getProjectPaths: () => null,
        ctx: {
          config: {
            hubUrl: 'ws://review.invalid/computers',
            name: 'review',
            allowedRoots: [root],
            capabilities: ['proc']
          },
          dialer: { notify: () => true },
          log: () => {}
        }
      })
    let pc = openComputer()
    let inspected: ReturnType<typeof openChatStorage> | undefined
    try {
      for (const migration of migrations) {
        if (migration.version > version) break
        db.transaction(() => {
          migration.up(db)
          db.pragma(`user_version=${migration.version}`)
        })()
      }
      db.prepare("INSERT INTO projects(id,name,color,path) VALUES('p','Project','#000',?)").run(
        root
      )
      db.prepare(
        "INSERT INTO tasks(id,project_id,title,worktree_path) VALUES('task','p','Task',?)"
      ).run(root)
      const modes = ['claude-chat', 'codex-chat', 'gemini']
      const expected = modes.map((mode, i) => ({
        tabId: `tab-${i}`,
        mode,
        event: {
          kind: 'assistant-text',
          messageId: `reply-${i}`,
          text: `retained schema ${version} ${mode}`
        }
      }))
      for (const item of expected) {
        db.prepare('INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,?,?,?)').run(
          item.tabId,
          'task',
          item.mode,
          expected.indexOf(item)
        )
        db.prepare('INSERT INTO chat_events(tab_id,seq,event) VALUES(?,0,?)').run(
          item.tabId,
          JSON.stringify(item.event)
        )
        if (version >= 177)
          db.prepare(
            'INSERT INTO chat_tab_state(tab_id,draft_text,rev,updated_at) VALUES(?,?,2,123)'
          ).run(item.tabId, `draft ${item.mode}`)
      }
      db.prepare(
        "INSERT INTO agent_prompts(id,task_id,agent_id,text,created_at) VALUES('prompt','task','claude-code','retained task prompt',123)"
      ).run()

      bootstrapSchema(db)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      const slayDb = createSlayzoneDbAdapter(db)
      const services = () =>
        createComputerChatServices({
          db: slayDb,
          legacyData: {
            ...createDbChatDataOps(slayDb, taskSessionStore),
            buildMcpEnv: async () => ({})
          },
          attachments: {
            read: async () => {
              throw new Error('No attachments in this fixture')
            }
          },
          request: async (_id, request) => pc.request(JSON.parse(JSON.stringify(request))),
          resolveComputer: async () => 'pc',
          defaultComputer: async () => 'pc',
          hasLiveTask: async () => false
        })
      const first = services()
      await first.migrateIdleComputer('pc')
      const owners = await first.ownership.forTask('task')
      expect(owners.filter((owner) => !owner.tabId.startsWith('task-content:'))).toHaveLength(
        expected.length
      )
      expect(owners.every((owner) => owner.state === 'active' && !owner.cleanupPending)).toBe(true)
      expect(db.prepare('SELECT count(*) AS n FROM chat_events').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT count(*) AS n FROM chat_tab_state').get()).toEqual({ n: 0 })
      // The prompt history is handed to the computer directly (v207, robustness plan
      // §9): staged once for the task's computer, the hub table gone.
      expect(
        db
          .prepare(
            "SELECT json_extract(payload,'$.text') AS text FROM computer_data_handoff WHERE kind='agent-prompt' AND item_key='prompt'"
          )
          .get()
      ).toEqual({ text: 'retained task prompt' })
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_prompts'").get()
      ).toBeUndefined()
      await pc.close()
      inspected = openChatStorage({ stateDir: root, hubScope: 'released-review' })
      for (const item of expected) {
        const owner = owners.find((owner) => owner.tabId === item.tabId)!
        expect(inspected.read(owner.id, -1).map((row) => row.event)).toEqual([item.event])
        if (version >= 177)
          expect(inspected.getRecord(owner.id, 'draft', 'state')).toMatchObject({
            draft: { text: `draft ${item.mode}`, rev: 2 }
          })
      }
      inspected.close()
      inspected = undefined
      pc = openComputer()
      const restarted = services()
      await restarted.recoverComputer('pc', true)
      await restarted.migrateIdleComputer('pc')
      expect(
        (await restarted.ownership.forTask('task')).map((owner) => [owner.id, owner.epoch])
      ).toEqual(owners.map((owner) => [owner.id, owner.epoch]))
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      inspected?.close()
      await pc.close()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
