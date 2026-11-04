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
  let live = false
  let intercept: ((raw: { kind?: string }) => Promise<void> | undefined) | null = null
  const sent: unknown[] = []
  const services = () =>
    createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request: async (_id: string, raw: unknown) => {
        sent.push(raw)
        await intercept?.(raw as { kind?: string })
        if (chatBroken)
          throw new Error('Chat storage is unavailable (database disk image is malformed)')
        return pc.request(JSON.parse(JSON.stringify(raw)))
      },
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      hasLiveTask: async () => live
    } as never)
  return {
    ...h,
    services,
    breakChat: () => {
      chatBroken = true
    },
    /** Every request the hub sent the computer, in order. */
    sent,
    setLive: (value: boolean) => {
      live = value
    },
    /** Holds the next computer request of `kind` until `release()`. */
    pauseAt: (kind: string) => {
      let reached!: () => void
      let release!: () => void
      const arrived = new Promise<void>((r) => {
        reached = r
      })
      const gate = new Promise<void>((r) => {
        release = r
      })
      intercept = (raw) => {
        if (raw.kind !== kind) return undefined
        intercept = null
        reached()
        return gate
      }
      return { arrived, release }
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

/**
 * Issue #172 (v0.37.0). A task with recorded agent prompts gets a storage-only
 * `task-content:` owner. Its legacy session election skipped that owner (no
 * terminal tab), found zero candidates, and persisted NULL — the same marker
 * as a genuine cross-computer ambiguity. Every terminal-mode Claude resume in
 * such a task then failed with "…historical provider session is ambiguous…",
 * even on a single-computer install.
 */
function seedTerminalClaudeTask(f: Awaited<ReturnType<typeof fixture>>) {
  f.db
    .prepare(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-code',0)"
    )
    .run()
  f.db
    .prepare(
      "INSERT INTO agent_prompts(id,task_id,agent_id,cli_session_id,text,created_at) VALUES('p1','task','claude-code','session-1','hello',1)"
    )
    .run()
  f.db
    .prepare(
      "INSERT INTO task_conversations(id,task_id,mode,conversation_id,origin,created_at) VALUES('c1','task','claude-code','session-1','slay-spawned-fresh',1)"
    )
    .run()
}

const authorityRows = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.db
    .prepare(
      "SELECT conversation_id FROM chat_legacy_session_authority WHERE task_id='task' AND provider_session_id='session-1'"
    )
    .all()

test('#172: terminal Claude session in a task with only storage-only chat history resumes after migration', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    const s = f.services()
    await s.migrateIdleComputer('pc')
    const owners = await s.ownership.forTask('task')
    expect(owners.map((o) => o.tabId)).toEqual(['task-content:task'])
    // No chat owner competes for the session, so nothing is ambiguous.
    expect(authorityRows(f)).toEqual([])
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).resolves.toBe('pc')
  } finally {
    await f.close()
  }
})

test('#172: a NULL authority row persisted by v0.37.0 with no competing owner self-heals', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    const s = f.services()
    await s.migrateIdleComputer('pc')
    // What v0.37.0 left on disk.
    f.db
      .prepare(
        "INSERT OR REPLACE INTO chat_legacy_session_authority VALUES('task','claude-code','session-1',NULL)"
      )
      .run()
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).resolves.toBe('pc')
    expect(authorityRows(f)).toEqual([])
  } finally {
    await f.close()
  }
})

test('#172: a stale NULL row is re-elected once a single-computer chat owner exists', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    const s = f.services()
    await s.migrateIdleComputer('pc')
    f.db
      .prepare(
        "INSERT OR REPLACE INTO chat_legacy_session_authority VALUES('task','claude-code','session-1',NULL)"
      )
      .run()
    // User opened a chat tab in the task after the bad election.
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('chat','task','claude-chat',1)"
      )
      .run()
    await s.ownership.register({
      id: 'chat-owner',
      taskId: 'task',
      tabId: 'chat',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).resolves.toBe('pc')
    expect(authorityRows(f)).toEqual([{ conversation_id: 'chat-owner' }])
  } finally {
    await f.close()
  }
})

/**
 * A storage-only `task-content:` owner holds task history, never a provider
 * session, and has no tab — so "reopen chat" cannot run its migration. If its
 * copy keeps failing (damaged legacy row), a terminal-only user must still be
 * able to start agents. Chat-tab owners keep fencing.
 */
const seedDamagedTaskContent = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.db
    .prepare(
      "INSERT INTO chat_attachment_messages(task_id,message_id,attachments) VALUES('task','m1','{not json')"
    )
    .run()

test('a stuck storage-only task-content migration does not fence terminal agent starts', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    seedDamagedTaskContent(f)
    const s = f.services()
    await s.migrateIdleComputer('pc')
    const owners = await s.ownership.forTask('task')
    expect(owners.map((o) => [o.tabId, o.state])).toEqual([['task-content:task', 'copying']])
    await expect(s.resolvePtyComputer('task', { mode: 'terminal' })).resolves.toBe('pc')
    await expect(s.resolvePtyComputer('task', { mode: 'claude-code' })).resolves.toBe('pc')
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).resolves.toBe('pc')
    // Still pending: the copy is retried, never abandoned.
    expect((await s.ownership.forTab('task-content:task'))?.state).toBe('copying')
  } finally {
    await f.close()
  }
})

test('a pending chat-tab migration still fences agent starts alongside a stuck task-content owner', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    seedDamagedTaskContent(f)
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('chat','task','claude-chat',1)"
      )
      .run()
    f.db.prepare("INSERT INTO chat_events(tab_id,seq,event) VALUES('chat',1,'{not json')").run()
    const s = f.services()
    await s.migrateIdleComputer('pc')
    // A task migrates its owners in id order and stops at the first failure,
    // so the other damaged owner may not have started yet. Start it.
    for (const o of await s.ownership.forTask('task'))
      if (o.state === 'legacy')
        await s.ownership.beginMigration(o.id, {
          expectedComputerId: null,
          expectedEpoch: o.epoch,
          migrationId: `m-${o.id}`,
          destinationComputerId: 'pc'
        })
    expect((await s.ownership.forTask('task')).map((o) => [o.tabId, o.state]).sort()).toEqual([
      ['chat', 'copying'],
      ['task-content:task', 'copying']
    ])
    for (const mode of ['terminal', 'claude-code'])
      await expect(s.resolvePtyComputer('task', { mode })).rejects.toThrow(/migration is pending/i)
  } finally {
    await f.close()
  }
})

test('a pending chat-tab migration still fences agent starts on its own', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position,label) VALUES('chat','task','claude-chat',1,'Planning')"
      )
      .run()
    f.db.prepare("INSERT INTO chat_events(tab_id,seq,event) VALUES('chat',1,'{not json')").run()
    const s = f.services()
    await s.migrateIdleComputer('pc')
    expect((await s.ownership.forTab('chat'))?.state).toBe('copying')
    await expect(s.resolvePtyComputer('task', { mode: 'claude-code' })).rejects.toThrow(
      'Chat history migration is pending for "Planning". Open that chat to finish it, then start this agent.'
    )
  } finally {
    await f.close()
  }
})

test('#172: a genuine cross-computer ambiguity still fences the terminal resume', async () => {
  const f = await fixture()
  try {
    const s = f.services()
    for (const [tab, pc] of [
      ['a', 'pc'],
      ['b', 'pc2']
    ] as const) {
      f.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,'task','claude-chat',0)"
        )
        .run(tab)
      await s.ownership.register({
        id: tab,
        taskId: 'task',
        tabId: tab,
        mode: 'claude-chat',
        computerId: pc,
        epoch: 1
      })
    }
    f.db
      .prepare(
        "INSERT INTO chat_legacy_session_authority VALUES('task','claude-code','session-1',NULL)"
      )
      .run()
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).rejects.toThrow(/historical provider session is ambiguous/)
    expect(authorityRows(f)).toEqual([{ conversation_id: null }])
  } finally {
    await f.close()
  }
})

const insertTurn = (f: Awaited<ReturnType<typeof fixture>>, id: string, preview: string) =>
  f.db
    .prepare(
      "INSERT INTO agent_turns(id,worktree_path,task_id,terminal_tab_id,snapshot_sha,prompt_preview,created_at) VALUES(?,'/w','task','tab','sha',?,?)"
    )
    .run(id, preview, Date.now())
const turnPreviews = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.db.prepare("SELECT id,prompt_preview FROM agent_turns WHERE task_id='task' ORDER BY id").all()
const killRequests = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.sent.filter((r) => /"(kill|pty\.kill|stop[A-Za-z]*|release[A-Za-z]*)"/.test(JSON.stringify(r)))

test('a terminal agent starting during a healthy task-content copy leaves the migration intact', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    insertTurn(f, 'turn-before', 'before copy')
    const s = f.services()
    const pause = f.pauseAt('transfer.begin')
    const migrating = s.migrateIdleComputer('pc')
    await pause.arrived
    expect((await s.ownership.forTab('task-content:task'))?.state).toBe('copying')
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).resolves.toBe('pc')
    f.setLive(true)
    pause.release()
    await migrating
    const owner = await s.ownership.forTab('task-content:task')
    expect(owner).toMatchObject({ state: 'active', computerId: 'pc', cleanupPending: false })
    // Every copied legacy row reached the computer before the hub dropped it.
    const local = f.storage()
    try {
      expect(local.records(owner!.id, 'prompt').map((r) => r.id)).toEqual(['p1'])
      expect(
        local
          .records(owner!.id, 'settings')
          .filter((r) => r.id.startsWith('legacy-turn-preview:'))
          .map((r) => [r.id, (r.value as { promptPreview: string }).promptPreview])
      ).toEqual([['legacy-turn-preview:turn-before', 'before copy']])
    } finally {
      local.close()
    }
    expect(f.db.prepare("SELECT id FROM agent_prompts WHERE task_id='task'").all()).toEqual([])
    expect(turnPreviews(f)).toEqual([{ id: 'turn-before', prompt_preview: '' }])
    // The running agent was never stopped by the migration.
    expect(killRequests(f)).toEqual([])
    expect((await s.prompts('task')).map((p) => [p.id, p.text])).toEqual([['p1', 'hello']])
  } finally {
    await f.close()
  }
})

test('a terminal turn cannot write a legacy prompt preview during the copy, same as after activation', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    const s = f.services()
    const pause = f.pauseAt('transfer.begin')
    const migrating = s.migrateIdleComputer('pc')
    await pause.arrived
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).resolves.toBe('pc')
    f.setLive(true)
    // The hub refuses legacy preview text once any owner of the task left
    // `legacy` (migration v187 trigger): nothing can slip in behind the frozen
    // copy. The turn boundary itself still records.
    expect(() => insertTurn(f, 'turn-during', 'during copy')).toThrow(
      /Prompt previews are computer-owned/
    )
    insertTurn(f, 'turn-during', '')
    pause.release()
    await migrating
    expect((await s.ownership.forTab('task-content:task'))?.state).toBe('active')
    expect(() => insertTurn(f, 'turn-after', 'after activation')).toThrow(
      /Prompt previews are computer-owned/
    )
    expect(turnPreviews(f)).toEqual([{ id: 'turn-during', prompt_preview: '' }])
    expect(killRequests(f)).toEqual([])
    expect((await s.prompts('task')).map((p) => p.text)).toEqual(['hello'])
  } finally {
    await f.close()
  }
})

test('an unavailable storage-only owner does not fence terminal agent starts', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    const s = f.services()
    await s.migrateIdleComputer('pc')
    const artifacts = await s.artifactOwner('task')
    for (const o of await s.ownership.forTask('task'))
      await s.ownership.markUnavailable(o.id, 'pc', o.epoch)
    expect((await s.ownership.forTask('task')).map((o) => o.tabId.split(':')[0]).sort()).toEqual([
      'artifact-store',
      'task-content'
    ])
    expect(await s.ownership.unavailable(artifacts.id)).toBeTruthy()
    await expect(s.resolvePtyComputer('task', { mode: 'terminal' })).resolves.toBe('pc')
    await expect(
      s.resolvePtyComputer('task', { mode: 'claude-code', conversationId: 'session-1' })
    ).resolves.toBe('pc')
  } finally {
    await f.close()
  }
})

test('an unavailable chat-tab owner still fences agent starts', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('chat','task','claude-chat',1)"
      )
      .run()
    const s = f.services()
    await s.migrateIdleComputer('pc')
    const chat = (await s.ownership.forTab('chat'))!
    expect(chat.state).toBe('active')
    await s.ownership.markUnavailable(chat.id, 'pc', chat.epoch)
    await expect(s.resolvePtyComputer('task', { mode: 'claude-code' })).rejects.toThrow(
      /Chat history unavailable/
    )
  } finally {
    await f.close()
  }
})

test('a chat deletion awaiting its computer fences agent starts with its own message', async () => {
  const f = await fixture()
  try {
    seedTerminalClaudeTask(f)
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('chat','task','claude-chat',1)"
      )
      .run()
    const s = f.services()
    await s.migrateIdleComputer('pc')
    const chat = (await s.ownership.forTab('chat'))!
    expect(chat.state).toBe('active')
    await s.ownership.deleteConversation(chat.id)
    expect(await s.ownership.get(chat.id)).toMatchObject({ state: 'deleted', cleanupPending: true })
    await expect(s.resolvePtyComputer('task', { mode: 'claude-code' })).rejects.toThrow(
      'A deleted chat is still being removed from its computer. Reconnect that computer, then start this agent.'
    )
  } finally {
    await f.close()
  }
})
