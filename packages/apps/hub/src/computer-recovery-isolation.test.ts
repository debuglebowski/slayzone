import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'

/**
 * One bad conversation or task on a computer must fail on its own. Every pass
 * the hub runs when a computer connects (recovery, lifecycle, metadata, folder
 * deletions) used to abort on its first bad item, so every chat AND terminal
 * on the computer failed. Each case plants one bad item for task `bad` and
 * checks that task `good` still opens its chat and starts agents.
 */

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** Fails one computer request, or rewrites its reply. */
interface Plant {
  fail?(request: Record<string, unknown>, badConversation: string): Error | undefined
  reply?(request: Record<string, unknown>, result: unknown, badConversation: string): unknown
}

async function setup() {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-isolation-'))
  roots.push(dir)
  const pc = createFixtureChatRuntime({
    // Each task its own folder: one task's folder is never another's (§9 7c).
    taskFolder: (taskId) => {
      const folder = join(dir, 'tasks', taskId)
      mkdirSync(folder, { recursive: true })
      return folder
    },
    stateDir: join(dir, 'pc'),
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
  })
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
  for (const id of ['good', 'bad']) {
    h.db
      .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,'p',?,1)")
      .run(id, id)
    h.db
      .prepare("INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,?,'claude-chat',0)")
      .run(`${id}-tab`, id)
  }
  let plant: Plant | null = null
  const ids = { badConversation: '' }
  const request = async (_pc: string, raw: unknown) => {
    const p = raw as Record<string, unknown>
    const failure = plant?.fail?.(p, ids.badConversation)
    if (failure) throw failure
    const result = await pc.request(raw)
    return plant?.reply ? plant.reply(p, result, ids.badConversation) : result
  }
  const chat = createComputerChatServices({
    db: h.slayDb,
    legacyData: {
      ...createDbChatDataOps(h.slayDb, taskSessionStore),
      buildMcpEnv: async () => ({})
    },
    attachments: { read: async () => new Uint8Array() },
    request,
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false
  })
  for (const id of ['good', 'bad'])
    await chat.relay.ops.saveTabDraft(`${id}-tab`, { text: id, attachments: [] })
  ids.badConversation = (await chat.ownership.forTab('bad-tab'))!.id
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  /** A fresh recovery pass (as after a hub restart), with `p` planted. */
  async function reconnect(p: Plant) {
    plant = p
    chat.invalidateRecovery('pc')
    h.db.prepare('DELETE FROM chat_metadata_progress').run()
    await chat.recoverComputer('pc')
  }
  async function expectGoodWorks() {
    await expect(chat.relay.ops.getTabState('good-tab')).resolves.toMatchObject({
      draft: { text: 'good' }
    })
    await expect(chat.resolvePtyComputer('good')).resolves.toBe('pc')
  }
  return {
    h,
    chat,
    reconnect,
    expectGoodWorks,
    errors,
    unplant: () => {
      plant = null
    },
    async cleanup() {
      await pc.close()
      h.cleanup()
    }
  }
}

const planted = () => new Error('planted failure')

test('a conversation the hub cannot reconcile is fenced alone', async () => {
  const t = await setup()
  try {
    await t.reconnect({
      reply: (p, result, bad) =>
        p.kind === 'inventory'
          ? (result as Array<{ identity: { id: string }; bootstrapRevision: number }>).map((e) =>
              e.identity.id === bad ? { ...e, bootstrapRevision: -1 } : e
            )
          : result
    })
    await t.expectGoodWorks()
    await expect(t.chat.relay.ops.getTabState('bad-tab')).rejects.toThrow(
      /could not be recovered: Invalid computer ownership/
    )
    await expect(t.chat.resolvePtyComputer('bad')).rejects.toThrow(/could not be recovered/)
    // Fixed data: opening the chat again re-runs recovery and lifts the fence.
    t.unplant()
    await expect(t.chat.relay.ops.getTabState('bad-tab')).resolves.toMatchObject({
      draft: { text: 'bad' }
    })
  } finally {
    await t.cleanup()
  }
})

test('a conversation whose metadata snapshot fails is fenced alone', async () => {
  const t = await setup()
  try {
    await t.reconnect({
      fail: (p, bad) => (p.kind === 'metadata.snapshot' && p.id === bad ? planted() : undefined)
    })
    await t.expectGoodWorks()
    await expect(t.chat.relay.ops.getTabState('bad-tab')).rejects.toThrow(
      /could not be recovered: planted failure/
    )
  } finally {
    await t.cleanup()
  }
})

test('a task whose lifecycle cannot be delivered is fenced alone', async () => {
  const t = await setup()
  try {
    t.h.db
      .prepare(
        "INSERT INTO chat_task_lifecycle(task_id,state,revision) VALUES('bad','active',7),('good','active',7) ON CONFLICT(task_id) DO UPDATE SET revision=7"
      )
      .run()
    await t.reconnect({
      fail: (p) => (p.kind === 'task.lifecycle' && p.taskId === 'bad' ? planted() : undefined)
    })
    await t.expectGoodWorks()
    await expect(t.chat.relay.ops.getTabState('bad-tab')).rejects.toThrow(
      /state could not be delivered to its computer: planted failure/
    )
    await expect(t.chat.resolvePtyComputer('bad')).rejects.toThrow(/could not be delivered/)
  } finally {
    await t.cleanup()
  }
})

test('a failing provider switch, initialization, chat deletion or folder deletion stays with its task', async () => {
  const t = await setup()
  const failing = new Set<string>()
  const plant: Plant = {
    fail: (p) => {
      const value = p.value as
        | { identity?: { taskId?: string }; to?: { taskId?: string } }
        | undefined
      const task =
        (p.taskId as string | undefined) ??
        (p.identity as { taskId?: string } | undefined)?.taskId ??
        value?.identity?.taskId ??
        value?.to?.taskId
      return task === 'bad' && failing.has(String(p.kind)) ? planted() : undefined
    }
  }
  try {
    // A second chat of the bad task, created while everything works...
    t.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('bad-old','bad','claude-chat',1)"
      )
      .run()
    await t.chat.relay.ops.saveTabDraft('bad-old', { text: 'old', attachments: [] })
    for (const kind of [
      'conversation.transition',
      'bootstrap',
      'conversation.delete',
      'folders.delete'
    ])
      failing.add(kind)
    await t.reconnect(plant)
    // ...then deleted: its deletion is pending on the computer.
    await t.chat.ownership.deleteConversation((await t.chat.ownership.forTab('bad-old'))!.id)
    // Pending folder deletion for the bad task.
    t.h.db
      .prepare("INSERT INTO artifact_folders(id,task_id,name) VALUES('bad-folder','bad','F')")
      .run()
    await t.chat.folderDeletions.record('bad', ['bad-folder'])
    // A new chat whose first initialization fails (stays reserved).
    t.h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('bad-new','bad','claude-chat',2)"
      )
      .run()
    await expect(
      t.chat.relay.ops.saveTabDraft('bad-new', { text: 'new', attachments: [] })
    ).rejects.toThrow('planted failure')
    // A provider switch whose transition fails (stays reserved).
    t.h.db.prepare("UPDATE terminal_tabs SET mode='codex-chat' WHERE id='bad-tab'").run()
    await expect(t.chat.relay.ops.getTabState('bad-tab')).rejects.toThrow()
    expect(
      t.h.db
        .prepare("SELECT count(*) AS n FROM chat_provider_transitions WHERE state='reserved'")
        .get()
    ).toEqual({ n: 1 })
    expect(
      (
        t.h.db.prepare('SELECT count(*) AS n FROM chat_bootstrap_reservations').get() as {
          n: number
        }
      ).n
    ).toBeGreaterThan(0)

    // Every pending item of the bad task fails again on the next pass.
    await t.reconnect(plant)
    await t.expectGoodWorks()
    const failed = t.errors.mock.calls.map((c) => String(c[0]))
    for (const label of [
      'provider transition',
      'initialization of conversation',
      'deletion of conversation',
      'folder deletions of task bad'
    ])
      expect(failed.some((line) => line.includes(label))).toBe(true)
  } finally {
    await t.cleanup()
  }
})

test('an unreachable computer still fails the pass (no per-item timeouts)', async () => {
  const t = await setup()
  try {
    const timeout = () => Object.assign(new Error('timed out'), { name: 'RpcTimeoutError' })
    let snapshots = 0
    await expect(
      t.reconnect({
        fail: (p) => {
          if (p.kind !== 'metadata.snapshot') return undefined
          snapshots++
          return timeout()
        }
      })
    ).rejects.toThrow('timed out')
    expect(snapshots).toBe(1)
  } finally {
    await t.cleanup()
  }
})

test('a task whose only chat state is stored files still starts agents when chat recovery fails', async () => {
  const t = await setup()
  try {
    t.h.db
      .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('files','p','files',1)")
      .run()
    await t.chat.artifactOwner('files', 'pc')
    // A computer-wide chat failure (its inventory cannot be read).
    await expect(
      t.reconnect({ fail: (p) => (p.kind === 'inventory' ? planted() : undefined) })
    ).rejects.toThrow('planted failure')
    await expect(t.chat.resolvePtyComputer('files')).resolves.toBe('pc')
    // A task with a chat on that computer still reports the failure.
    await expect(t.chat.resolvePtyComputer('good')).rejects.toThrow('planted failure')
  } finally {
    await t.cleanup()
  }
})
