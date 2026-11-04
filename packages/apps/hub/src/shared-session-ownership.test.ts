import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'

/**
 * Investigation #4 (follow-up to #172). Pre-ledger builds wrote one Claude
 * session id into the provider_config of TWO tasks; migration v-ledger
 * backfilled both as `legacy-migration` (honored). Stable DB has 5 such ids,
 * e.g. d85ebcc8 is the CURRENT claude-code session of both 70c55783 and
 * 845f6ca8. Provider bindings are global per (provider_session_id, mode), so
 * once task A's chat owner binds the id, task B's terminal agent is refused
 * by resolvePtyComputer with "Provider session ownership is unavailable" —
 * a fence B can never clear (it does not own A's chat).
 */
async function fixture() {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'shared-session-'))
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  for (const id of ['task-a', 'task-b'])
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
      .run(id, 'p', id, dir)
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
  const legacyData = {
    ...createDbChatDataOps(h.slayDb, taskSessionStore),
    buildMcpEnv: async () => ({})
  }
  const services = createComputerChatServices({
    db: h.slayDb,
    legacyData,
    attachments: { read: async () => new Uint8Array() },
    request: async (_id: string, raw: unknown) => pc.request(JSON.parse(JSON.stringify(raw))),
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false
  } as never)
  return {
    ...h,
    services,
    legacyData,
    close: async () => {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Both tasks' ledgers name the same session, as the v-ledger backfill left them. */
function seedSharedLegacySession(f: Awaited<ReturnType<typeof fixture>>, session: string) {
  for (const [i, task] of ['task-a', 'task-b'].entries())
    f.db
      .prepare(
        "INSERT INTO task_conversations(id,task_id,mode,conversation_id,origin,created_at) VALUES(?,?,'claude-code',?,'legacy-migration',?)"
      )
      .run(`legacy-${task}`, task, session, i + 1)
  for (const [i, task] of ['task-a', 'task-b'].entries())
    f.db
      .prepare(
        "INSERT INTO agent_sessions(id,mode,task_id,conversation_id,origin,status,created_at,bound_at) VALUES(?,'claude-code',?,?,'legacy-migration','dead',?,?)"
      )
      .run(`session-${task}`, task, session, i + 1, i + 1)
  // Resumability proof (v158) — stable DB has it for all 5 shared ids.
  f.db.prepare('INSERT INTO session_turns(conversation_id,first_turn_at) VALUES(?,1)').run(session)
}

// Known bug #4, fix pending: `test.fails` keeps the suite green and flips red
// once the fix lands — then change it back to `test`.
test.fails('#4: a session shared by two tasks, bound to task A chat, must not block task B terminal', async () => {
  const f = await fixture()
  try {
    seedSharedLegacySession(f, 'shared-session')
    // Both tasks resolve the shared id as their current claude-code session.
    for (const task of ['task-a', 'task-b'])
      await expect(f.legacyData.getCurrentConversationId(task, 'claude-code')).resolves.toBe(
        'shared-session'
      )

    // Task A: a chat tab whose owner binds the shared provider session
    // (what "Continue in chat" / a chat resume of it does).
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('chat-a','task-a','claude-chat',0)"
      )
      .run()
    await f.services.relay.ensureTab('chat-a')
    const ownerA = await f.services.ownership.forTab('chat-a')
    expect(ownerA).toMatchObject({ taskId: 'task-a', state: 'active', computerId: 'pc' })
    await f.services.ownership.bindProvider(ownerA!.id, 'shared-session', 'claude-chat')
    expect(
      (await f.services.ownership.forProviderSession('shared-session', 'claude-code'))?.taskId
    ).toBe('task-a')

    // Task A itself is unaffected.
    await expect(f.services.resolvePtyComputer('task-a', { mode: 'claude-code' })).resolves.toBe(
      'pc'
    )

    // Task B: starting its terminal Claude agent. Today this throws
    // "Provider session ownership is unavailable" (computer-chat.ts
    // resolvePtyComputer, owner.taskId !== taskId).
    await expect(f.services.resolvePtyComputer('task-b', { mode: 'claude-code' })).resolves.toBe(
      'pc'
    )
  } finally {
    await f.close()
  }
})
