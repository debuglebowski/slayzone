import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'
import { createComputerChatCommandBarrier } from './computer-chat-maintenance'
import { openChatStorage } from '../../../domains/chat-runtime/src/server/storage'

/**
 * One damaged legacy conversation, or a computer whose chat storage cannot
 * open, must not take down native work (pty/fs/git) for every task on that
 * computer. Release blocker found in the v0.36.4 → main review.
 */
async function fixture() {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-isolation-'))
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
    .run('task', 'p', 'Task', dir)
  h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('other','p','Other task')").run()
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
  let chatBroken = false
  const services = () =>
    createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request: async (_id: string, raw: unknown) => {
        if (chatBroken)
          throw new Error('Chat storage is unavailable (database disk image is malformed)')
        return pc.request(JSON.parse(JSON.stringify(raw)))
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => false
    } as never)
  return {
    ...h,
    services,
    breakChat: () => {
      chatBroken = true
    },
    storage: () => openChatStorage({ stateDir: dir, hubScope: 'hub' }),
    close: async () => {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const deletedRef = {
  artifactId: 'deleted-artifact',
  contentHash: 'a'.repeat(64),
  name: 'shot.png',
  kind: 'image',
  mediaType: 'image/png',
  size: 3
}

test('legacy refs to a deleted or moved artifact migrate as unavailable placeholders', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    // Moved: the artifact exists, but in another task. It must not cross tasks.
    f.db
      .prepare("INSERT INTO task_artifacts(id,task_id,title) VALUES('moved-artifact','other','m')")
      .run()
    f.db
      .prepare(
        "INSERT INTO artifact_versions(id,artifact_id,version_num,content_hash,size) VALUES('mv','moved-artifact',1,?,3)"
      )
      .run('b'.repeat(64))
    const movedRef = {
      ...deletedRef,
      artifactId: 'moved-artifact',
      contentHash: 'b'.repeat(64),
      name: 'moved.png'
    }
    f.db.prepare("INSERT INTO chat_events(tab_id,seq,event) VALUES('tab',1,?)").run(
      JSON.stringify({
        kind: 'user-message',
        id: 'm1',
        text: 'see files',
        content: [
          { type: 'text', text: 'see files' },
          { type: 'attachment', attachment: deletedRef },
          { type: 'attachment', attachment: movedRef }
        ]
      })
    )
    f.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,draft_attachments,rev,updated_at) VALUES('tab','draft text',?,1,1)"
      )
      .run(JSON.stringify([deletedRef]))
    const s = f.services()
    await expect(s.relay.ops.getTabState('tab')).resolves.toBeDefined()
    const owner = await s.ownership.forTab('tab')
    expect(owner).toMatchObject({ state: 'active', computerId: 'pc', cleanupPending: false })
    const local = f.storage()
    try {
      const message = local.read(owner!.id, -1).find((e) => e.event.kind === 'user-message')!
        .event as { content?: unknown[] }
      expect(message.content).toEqual([
        { type: 'text', text: 'see files' },
        { type: 'text', text: '[Attachment unavailable: shot.png]' },
        { type: 'text', text: '[Attachment unavailable: moved.png]' }
      ])
      expect(local.records(owner!.id, 'attachment')).toEqual([])
      const draft = local.records(owner!.id, 'draft')[0]!.value as {
        draft: { text: string; attachments: unknown[] }
      }
      expect(draft.draft).toMatchObject({
        text: 'draft text\n[Attachment unavailable: shot.png]',
        attachments: []
      })
    } finally {
      local.close()
    }
    // The moved artifact's bytes were never pinned for this task.
    expect(
      f.db
        .prepare("SELECT count(*) AS n FROM artifact_blob_pins WHERE artifact_id='moved-artifact'")
        .get()
    ).toEqual({ n: 0 })
  } finally {
    await f.close()
  }
})

test('one conversation whose migration keeps failing does not fail recovery for the computer', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    // Unreadable legacy row: this conversation can never copy until repaired.
    f.db.prepare("INSERT INTO chat_events(tab_id,seq,event) VALUES('tab',1,'{not json')").run()
    const s = f.services()
    await s.migrateIdleComputer('pc')
    expect((await s.ownership.forTab('tab'))?.state).toBe('copying')
    // Reconnect forces recovery, which re-runs the stuck migration.
    s.invalidateRecovery('pc')
    await expect(s.recoverComputer('pc', true)).resolves.toBeUndefined()
    await expect(s.resolvePtyComputer('other', { mode: 'terminal' })).resolves.toBe('pc')
    // The damaged task itself stays fenced, with its own error.
    await expect(s.resolvePtyComputer('task', { mode: 'claude-code' })).rejects.toThrow(
      /migration is pending/i
    )
    await expect(s.relay.ops.getTabState('tab')).rejects.toThrow()
    const barrier = createComputerChatCommandBarrier({ lifecycle: s.lifecycle.syncNative })
    for (const method of ['pty.spawn', 'pty.write', 'fs.readDir', 'git.getCurrentBranch'])
      await expect(barrier('pc', method)).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})

test('native work is not gated on chat recovery when chat storage cannot open', async () => {
  const f = await fixture()
  try {
    const s = f.services()
    f.breakChat()
    await expect(s.recoverComputer('pc', true)).rejects.toThrow(/malformed/)
    const barrier = createComputerChatCommandBarrier({ lifecycle: s.lifecycle.syncNative })
    for (const method of ['pty.spawn', 'pty.write', 'fs.readDir', 'git.getCurrentBranch'])
      await expect(barrier('pc', method)).resolves.toBeUndefined()
    // A task with no chat conversation on this computer can still start agents.
    await expect(s.resolvePtyComputer('other', { mode: 'terminal' })).resolves.toBe('pc')
    await expect(s.resolvePtyComputer('other', { mode: 'claude-code' })).resolves.toBe('pc')
    // Now tracked on the computer with an undeliverable 'active' lifecycle row:
    // reactivation is chat-store state, not a native-work fence.
    for (const method of ['pty.spawn', 'fs.readDir'])
      await expect(barrier('pc', method)).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})

test('a pending task pause/delete still fences native commands', async () => {
  const f = await fixture()
  try {
    const s = f.services()
    await s.lifecycle.track('task', 'pc')
    f.db
      .prepare(
        `INSERT INTO chat_task_lifecycle(task_id,state,revision) VALUES('task','deleted',1)
        ON CONFLICT(task_id) DO UPDATE SET state='deleted',revision=revision+1`
      )
      .run()
    f.breakChat()
    const barrier = createComputerChatCommandBarrier({ lifecycle: s.lifecycle.syncNative })
    await expect(barrier('pc', 'pty.spawn')).rejects.toThrow(/malformed/)
    await expect(barrier('pc', 'pty.kill')).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})
