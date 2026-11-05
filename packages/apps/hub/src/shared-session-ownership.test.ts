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
 *
 * Fixed by "one task per provider session": the session is the task's that
 * claimed it first (agent-sessions.ts `NOT_CLAIMED_ELSEWHERE_SQL`), so B starts
 * fresh and never shows A's history; the boot repair
 * (shared-session-repair.ts) tombstones the losing claims, letting a chat binding
 * pick the winner. The fence stays (two tasks must never drive one transcript),
 * and names the owning task when it still fires.
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

async function bindToTaskAChat(f: Awaited<ReturnType<typeof fixture>>, session: string) {
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
  await f.services.ownership.bindProvider(ownerA!.id, session, 'claude-chat')
  expect((await f.services.ownership.forProviderSession(session, 'claude-code'))?.taskId).toBe(
    'task-a'
  )
}

test('#4: a session shared by two tasks, bound to task A chat, must not block task B terminal', async () => {
  const f = await fixture()
  try {
    seedSharedLegacySession(f, 'shared-session')
    // One task per provider session: the earliest claimant (A) keeps it; B has no
    // current session, so its agent starts fresh and never shows A's history.
    await expect(f.legacyData.getCurrentConversationId('task-a', 'claude-code')).resolves.toBe(
      'shared-session'
    )
    await expect(f.legacyData.getCurrentConversationId('task-b', 'claude-code')).resolves.toBeNull()

    await bindToTaskAChat(f, 'shared-session')

    // Task A itself is unaffected.
    await expect(f.services.resolvePtyComputer('task-a', { mode: 'claude-code' })).resolves.toBe(
      'pc'
    )
    // Task B: starting its terminal Claude agent. Before the fix this threw
    // "Provider session ownership is unavailable" (resolvePtyComputer,
    // owner.taskId !== taskId).
    await expect(f.services.resolvePtyComputer('task-b', { mode: 'claude-code' })).resolves.toBe(
      'pc'
    )
  } finally {
    await f.close()
  }
})

test('#4: when the fence still fires (an explicit id of another task), it names the owning task', async () => {
  const f = await fixture()
  try {
    seedSharedLegacySession(f, 'shared-session')
    await bindToTaskAChat(f, 'shared-session')
    // e.g. a stale resume hint from before the fix.
    await expect(
      f.services.resolvePtyComputer('task-b', {
        mode: 'claude-code',
        conversationId: 'shared-session'
      })
    ).rejects.toThrow(
      'This session belongs to task "task-a". Continue it there, or start a fresh session here.'
    )
  } finally {
    await f.close()
  }
})
