/**
 * `createTaskOp` takes a warm agent's reserved task id when the task is created to
 * be opened right away and its first agent would match the warm one.
 *
 * A warm agent boots with the id of a task that does not exist yet, so a task that
 * adopts it must be created UNDER that id. Reserving is only worth it when the
 * task's terminal will auto-start in the project root: anything else (a worktree, a
 * child repo, a subtask in its parent's workspace, a Start gate) would make the
 * claim miss, and a missed reservation kills a booted agent.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'
import type { OpDeps } from './shared.js'

type Reserve = NonNullable<OpDeps['reserveWarmTaskId']>
type ReserveCall = Parameters<Reserve>[0]

async function setup(opts: { selectedRepo?: string; autoWorktree?: 0 | 1 } = {}) {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO projects (id, name, color, path, columns_config, selected_repo, auto_create_worktree_on_task_create) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      projectId,
      'Proj',
      '#000',
      '/tmp/proj',
      JSON.stringify([]),
      opts.selectedRepo ?? null,
      opts.autoWorktree ?? 0
    )
  const calls: ReserveCall[] = []
  const reservedId = crypto.randomUUID()
  let answer: string | null = reservedId
  const deps: OpDeps = {
    reserveWarmTaskId: async (c) => {
      calls.push(c)
      return answer
    }
  }
  return {
    h,
    projectId,
    calls,
    reservedId,
    deps,
    setAnswer: (a: string | null) => {
      answer = a
    },
    setStartup: (v: 'manual' | 'auto' | 'instant') =>
      h.db
        .prepare(
          "INSERT INTO settings (key, value) VALUES ('terminal_agent_startup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(v)
  }
}

test('temporary task opened at once takes the reserved id', async () => {
  const s = await setup()
  const task = await createTaskOp(
    s.h.slayDb,
    { projectId: s.projectId, title: 'Terminal 1', isTemporary: true, openAfterCreate: true },
    s.deps
  )
  expect(task?.id).toBe(s.reservedId)
  expect(s.calls.length).toBe(1)
  expect(s.calls[0].projectId).toBe(s.projectId)
  expect(s.calls[0].mode).toBe('claude-code')
  // The pool compares these against the flags baked into the running agent.
  expect(s.calls[0].flags).toBe(task!.provider_config['claude-code']?.flags ?? '')
  s.h.cleanup()
})

for (const mode of [null, 'auto', 'instant'] as const) {
  test(`regular task opened at once takes the reserved id (startup mode ${mode ?? 'unset → auto'})`, async () => {
    const s = await setup()
    if (mode) s.setStartup(mode)
    const task = await createTaskOp(
      s.h.slayDb,
      { projectId: s.projectId, title: 'Real', openAfterCreate: true },
      s.deps
    )
    expect(task?.id).toBe(s.reservedId)
    s.h.cleanup()
  })
}

test("a created task's main tab starts out `new` (never started)", async () => {
  const s = await setup()
  const task = await createTaskOp(s.h.slayDb, { projectId: s.projectId, title: 'Fresh' }, {})
  const row = s.h.db
    .prepare('SELECT agent_state, is_main FROM terminal_tabs WHERE id = ?')
    .get(task!.id) as { agent_state: string; is_main: number } | undefined
  expect(row?.agent_state).toBe('new')
  expect(row?.is_main).toBe(1)
  s.h.cleanup()
})

test('no warm agent available → a fresh id, task still created', async () => {
  const s = await setup()
  s.setAnswer(null)
  const task = await createTaskOp(
    s.h.slayDb,
    { projectId: s.projectId, title: 'Terminal 1', isTemporary: true, openAfterCreate: true },
    s.deps
  )
  expect(s.calls.length).toBe(1)
  expect(!!task?.id && task.id !== s.reservedId).toBe(true)
  s.h.cleanup()
})

const NOT_RESERVED: Array<{
  name: string
  project?: { selectedRepo?: string; autoWorktree?: 0 | 1 }
  startup?: 'manual' | 'auto' | 'instant'
  input: Record<string, unknown>
}> = [
  { name: 'not opened after create', input: { isTemporary: true } },
  {
    name: 'regular task whose agent waits behind the Start gate (manual)',
    startup: 'manual',
    input: { openAfterCreate: true }
  },
  {
    name: 'a child repo (cwd is not the project root)',
    input: { isTemporary: true, openAfterCreate: true, repoName: 'web' }
  },
  {
    name: "the project's selected repo (cwd is not the project root)",
    project: { selectedRepo: 'web' },
    input: { isTemporary: true, openAfterCreate: true }
  },
  {
    name: 'a worktree will be auto-created (cwd is the worktree)',
    project: { autoWorktree: 1 },
    input: { isTemporary: true, openAfterCreate: true }
  }
]
// Provider, flags and computer are the pool's to check (warm-process-manager.test.ts).

for (const c of NOT_RESERVED) {
  test(`no reservation: ${c.name}`, async () => {
    const s = await setup(c.project)
    if (c.startup) s.setStartup(c.startup)
    const task = await createTaskOp(
      s.h.slayDb,
      { projectId: s.projectId, title: 'T', ...c.input },
      s.deps
    )
    expect(s.calls.length).toBe(0)
    expect(!!task?.id && task.id !== s.reservedId).toBe(true)
    s.h.cleanup()
  })
}

test('no reservation: a subtask (it runs in its parent workspace)', async () => {
  const s = await setup()
  const parent = await createTaskOp(s.h.slayDb, { projectId: s.projectId, title: 'Parent' }, {})
  const child = await createTaskOp(
    s.h.slayDb,
    {
      projectId: s.projectId,
      title: 'Child',
      parentId: parent!.id,
      isTemporary: true,
      openAfterCreate: true
    },
    s.deps
  )
  expect(s.calls.length).toBe(0)
  expect(child?.parent_id).toBe(parent!.id)
  s.h.cleanup()
})

test('no reserve dep wired (REST, MCP, Electron host) → a fresh id', async () => {
  const s = await setup()
  const task = await createTaskOp(
    s.h.slayDb,
    { projectId: s.projectId, title: 'Terminal 1', isTemporary: true, openAfterCreate: true },
    {}
  )
  expect(!!task?.id && task.id !== s.reservedId).toBe(true)
  s.h.cleanup()
})
