import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { openChatStorage } from '@slayzone/chat-runtime/server'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'

/**
 * Investigation #4 (follow-up to #172). Pre-ledger builds wrote one Claude
 * session id into the provider_config of TWO tasks; migration v-ledger
 * backfilled both as `legacy-migration` (honored). Stable DB has 5 such ids,
 * e.g. d85ebcc8 is the CURRENT claude-code session of both 70c55783 and
 * 845f6ca8. Once task A's chat holds the id (formerly a global hub provider
 * binding; since v208 the chat's own record on its computer), task B's terminal agent was refused
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
      .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
      .run(id, 'p', id)
  const computer = (id: string, stateDir: string) =>
    createFixtureChatRuntime({
      taskFolder: () => dir,
      stateDir,
      hubScope: 'hub',
      computerId: () => id,
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
  const pc = computer('pc', dir)
  const dir2 = mkdtempSync(join(realpathSync(tmpdir()), 'shared-session-2-'))
  const pc2 = computer('pc2', dir2)
  /** Which computers answer; `resolved` = where the task resolves (tests move it). */
  const net = { offline: new Set<string>(), resolved: 'pc' }
  const legacyData = {
    ...createDbChatDataOps(h.slayDb, taskSessionStore),
    buildMcpEnv: async () => ({})
  }
  const services = createComputerChatServices({
    db: h.slayDb,
    legacyData,
    attachments: { read: async () => new Uint8Array() },
    request: async (id: string, raw: unknown) => {
      if (net.offline.has(id))
        throw Object.assign(new Error(`${id} is not connected`), {
          name: 'NoComputerAvailableError'
        })
      return (id === 'pc2' ? pc2 : pc).request(JSON.parse(JSON.stringify(raw)))
    },
    resolveComputer: async () => net.resolved,
    defaultComputer: async () => 'pc',
    hasLiveTask: async () => false
  } as never)
  /** One raw operation on the computer's session ledger (robustness plan §9). */
  const ledger = (op: string, args: object) =>
    pc.request({ kind: 'ledger', value: { op, args } }) as Promise<unknown>
  return {
    ...h,
    services,
    legacyData,
    ledger,
    net,
    dir,
    close: async () => {
      await pc.close()
      await pc2.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
      rmSync(dir2, { recursive: true, force: true })
    }
  }
}

/** Both tasks' ledgers name the same session, as the v-ledger backfill left them. */
async function seedSharedLegacySession(f: Awaited<ReturnType<typeof fixture>>, session: string) {
  for (const [i, task] of ['task-a', 'task-b'].entries()) {
    await f.ledger('recordConversation', {
      id: `legacy-${task}`,
      taskId: task,
      mode: 'claude-code',
      conversationId: session,
      origin: 'legacy-migration',
      createdAt: i + 1
    })
  }
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
  // The chat records the session in its own store on the computer (the only copy:
  // the hub keeps no provider bindings, robustness plan §9 v208).
  const store = openChatStorage({ stateDir: f.dir, hubScope: 'hub' })
  try {
    store.putRecord(ownerA!.id, ownerA!.epoch, {
      kind: 'settings',
      id: `session:${JSON.stringify(['claude-chat', session])}`,
      value: { mode: 'claude-chat', conversationId: session, origin: 'handoff' },
      at: Date.now()
    })
  } finally {
    store.close()
  }
  await expect(
    f.ledger('chatSessionOwner', { sessionId: session, mode: 'claude-code' })
  ).resolves.toMatchObject({ taskId: 'task-a' })
}

test('#4: a session shared by two tasks, bound to task A chat, must not block task B terminal', async () => {
  const f = await fixture()
  try {
    await seedSharedLegacySession(f, 'shared-session')
    // One task per provider session: the earliest claimant (A) keeps it; B has no
    // current session, so its agent starts fresh and never shows A's history.
    await expect(
      f.ledger('getCurrentConversationId', { taskId: 'task-a', mode: 'claude-code' })
    ).resolves.toBe('shared-session')
    await expect(
      f.ledger('getCurrentConversationId', { taskId: 'task-b', mode: 'claude-code' })
    ).resolves.toBeNull()

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
    await seedSharedLegacySession(f, 'shared-session')
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

test('a session whose chat computer is offline is refused, naming it — never started elsewhere', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('pc','Studio Mac','darwin','1','{}',0)"
      )
      .run()
    await seedSharedLegacySession(f, 'shared-session')
    await bindToTaskAChat(f, 'shared-session')
    // The chat's computer goes offline; the task now resolves to another computer
    // that does not hold the session. Starting there would silently fork it.
    f.net.offline.add('pc')
    f.net.resolved = 'pc2'
    await expect(
      f.services.resolvePtyComputer('task-a', {
        mode: 'claude-code',
        conversationId: 'shared-session'
      })
    ).rejects.toThrow(/Studio Mac.*offline/)
  } finally {
    await f.close()
  }
})
