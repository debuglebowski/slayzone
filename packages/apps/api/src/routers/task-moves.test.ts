/**
 * Moving tasks to another hub, the source hub's side (slice 3a): the move's journal
 * (`taskMoves.*`), the lock it holds on its tasks, and the redirects it leaves.
 *
 *   - begin locks the tasks (the subtree too, archived included) and stops their
 *     agents; a retried begin (same id) is the same move;
 *   - a task linked to an integration, or already moving, cannot begin a move;
 *   - while a move runs, is paused or failed, every write to its tasks is refused
 *     (through the real router, so the gate in the middleware chain is what refuses);
 *   - the journal advances one step at a time, idempotently; pause, resume, fail and
 *     cancel move its status; cancel only before the target took the tasks;
 *   - release leaves a redirect per task and lifts the lock.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/task-moves.test.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import type { CreateTaskInput, Task, TaskMove, UpdateTaskInput } from '@slayzone/task-contracts'
import { configureTaskRuntimeAdapters, setTaskDeps, taskOps } from '@slayzone/task/server'
import {
  defaultWorktreeExecAdapters,
  defaultWorktreePolicyAdapters
} from '@slayzone/worktrees/server'
import express from 'express'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../shared/test-utils/rest-harness.js'
import { appRouter } from '../router'
import { withOwnerGate } from '../http/rest-api/owner-routes'
import { withMcpMoveLockGate, withMoveLockGate } from '../http/move-lock-gates'
import { registerUpdateTaskRoute } from '../http/rest-api/tasks/update'
import { withMcpOwnerGate } from '../http/mcp-tools/owner-gate'

const h = await createTestHarness()
const dataRoot = mkdtempSync(join(tmpdir(), 'task-moves-'))
setTaskDeps({ ops: taskOps })
const stopped: string[] = []
configureTaskRuntimeAdapters({
  getDataRoot: () => dataRoot,
  worktrees: defaultWorktreeExecAdapters,
  worktreePolicy: defaultWorktreePolicyAdapters,
  stopTaskAgents: async (taskId: string) => void stopped.push(taskId)
})
const caller = appRouter.createCaller({ db: h.slayDb, dataRoot } as never)

beforeEach(() => {
  stopped.length = 0
})

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const create = (title: string, extra: Record<string, unknown> = {}) =>
  caller.task.create({ projectId, title, ...extra } as unknown as CreateTaskInput) as Promise<Task>
const begin = (taskIds: string[], extra: Record<string, unknown> = {}) =>
  caller.taskMoves.begin({
    taskIds,
    targetHubId: 'hub-b',
    targetProjectId: 'project-on-b',
    ...extra
  }) as Promise<TaskMove>
const errOf = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await fn()
    return { message: '' }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}
/** Run the journal up to (not including) `step`. */
async function advanceTo(move: TaskMove, step: TaskMove['step']): Promise<TaskMove> {
  let m = move
  while (m.step !== step) m = await caller.taskMoves.advance({ id: m.id, completed: m.step })
  return m
}

describe('begin', () => {
  test('locks the task and its subtree (archived too) and stops their agents', async () => {
    const parent = await create('Parent')
    const child = await create('Child', { parentId: parent.id })
    const archived = await create('Archived child', { parentId: parent.id })
    h.db.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ?").run(archived.id)

    const move = await begin([parent.id])
    expect(move).toMatchObject({
      direction: 'out',
      peerHubId: 'hub-b',
      targetProjectId: 'project-on-b',
      rootTaskIds: [parent.id],
      includeSubtasks: true,
      step: 'export',
      status: 'running',
      error: null
    })
    expect([...move.taskIds].sort()).toEqual([parent.id, child.id, archived.id].sort())
    expect([...stopped].sort()).toEqual([parent.id, child.id, archived.id].sort())
    await caller.taskMoves.cancel({ id: move.id })
  })

  test('without subtasks: only the picked tasks', async () => {
    const parent = await create('Alone')
    await create('Stays', { parentId: parent.id })
    const move = await begin([parent.id], { includeSubtasks: false })
    expect(move.taskIds).toEqual([parent.id])
    await caller.taskMoves.cancel({ id: move.id })
  })

  test('the same id again is the same move', async () => {
    const t = await create('Retry')
    const id = crypto.randomUUID()
    const first = await begin([t.id], { id })
    const again = await begin([t.id], { id })
    expect(again.id).toBe(first.id)
    expect((await caller.taskMoves.list({})).filter((m) => m.id === id)).toHaveLength(1)
    await caller.taskMoves.cancel({ id })
  })

  test('a task already moving cannot begin another move', async () => {
    const t = await create('Busy')
    const first = await begin([t.id])
    const err = await errOf(() => begin([t.id]))
    expect(err.code).toBe('CONFLICT')
    expect(err.message).toMatch(/already being moved/i)
    await caller.taskMoves.cancel({ id: first.id })
  })

  test('a task linked to an integration cannot move to another hub', async () => {
    const t = await create('Linked')
    const connection = crypto.randomUUID()
    h.db
      .prepare(
        `INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
         VALUES (?, 'linear', 'ref', 1, datetime('now'), datetime('now'))`
      )
      .run(connection)
    h.db
      .prepare(
        `INSERT INTO external_links (id, provider, connection_id, external_type, external_id, external_key, task_id)
         VALUES (?, 'linear', ?, 'issue', 'x', 'X-1', ?)`
      )
      .run(crypto.randomUUID(), connection, t.id)
    const err = await errOf(() => begin([t.id]))
    expect(err.code).toBe('BAD_REQUEST')
    expect(err.message).toMatch(/integration/i)
  })
})

describe('the lock', () => {
  test('every write to a moving task is refused; other tasks are not', async () => {
    const parent = await create('Locked')
    const child = await create('Locked child', { parentId: parent.id })
    const free = await create('Free')
    const move = await begin([parent.id])

    for (const id of [parent.id, child.id]) {
      const err = await errOf(() =>
        caller.task.update({ id, title: 'nope' } as unknown as UpdateTaskInput)
      )
      expect(err.code).toBe('PRECONDITION_FAILED')
      expect(err.message).toMatch(/being moved to another hub/i)
    }
    const tagErr = await errOf(() => caller.tags.setForTask({ taskId: parent.id, tagIds: [] }))
    expect(tagErr.code).toBe('PRECONDITION_FAILED')
    // Reads still work, and so do other tasks' writes.
    expect((await caller.task.get({ id: parent.id }))?.title).toBe('Locked')
    await caller.task.update({ id: free.id, title: 'Free renamed' } as unknown as UpdateTaskInput)

    // Paused and failed moves still hold the lock.
    await caller.taskMoves.pause({ id: move.id })
    expect((await errOf(() => caller.task.archive({ id: parent.id }))).code).toBe(
      'PRECONDITION_FAILED'
    )
    await caller.taskMoves.resume({ id: move.id })
    await caller.taskMoves.fail({ id: move.id, error: 'target hub went away' })
    expect((await errOf(() => caller.task.archive({ id: parent.id }))).code).toBe(
      'PRECONDITION_FAILED'
    )

    // Canceled: the lock is gone.
    await caller.taskMoves.cancel({ id: move.id })
    await caller.task.update({
      id: parent.id,
      title: 'Writable again'
    } as unknown as UpdateTaskInput)
  })
})

describe('the journal', () => {
  test('advance goes one step at a time; repeating a finished step changes nothing', async () => {
    const t = await create('Steps')
    const move = await begin([t.id])
    const imported = await caller.taskMoves.advance({ id: move.id, completed: 'export' })
    expect(imported.step).toBe('import')
    const again = await caller.taskMoves.advance({ id: move.id, completed: 'export' })
    expect(again.step).toBe('import')
    // A step not yet reached cannot be reported done.
    const skip = await errOf(() => caller.taskMoves.advance({ id: move.id, completed: 'commit' }))
    expect(skip.code).toBe('PRECONDITION_FAILED')
    await caller.taskMoves.cancel({ id: move.id })
  })

  test('a paused move does not advance until resumed; progress is kept', async () => {
    const t = await create('Pausing')
    const move = await begin([t.id])
    await caller.taskMoves.progress({ id: move.id, step: 'export', done: 3, total: 10 })
    const paused = await caller.taskMoves.pause({ id: move.id })
    expect(paused).toMatchObject({
      status: 'paused',
      progress: { step: 'export', done: 3, total: 10 }
    })
    const refused = await errOf(() =>
      caller.taskMoves.advance({ id: move.id, completed: 'export' })
    )
    expect(refused.code).toBe('PRECONDITION_FAILED')
    const resumed = await caller.taskMoves.resume({ id: move.id })
    expect(resumed.status).toBe('running')
    expect((await caller.taskMoves.advance({ id: move.id, completed: 'export' })).step).toBe(
      'import'
    )
    await caller.taskMoves.cancel({ id: move.id })
  })

  test('a failed move resumes from the step that failed', async () => {
    const t = await create('Failing')
    const move = await advanceTo(await begin([t.id]), 'copy-files')
    const failed = await caller.taskMoves.fail({ id: move.id, error: 'disk full' })
    expect(failed).toMatchObject({ status: 'failed', error: 'disk full', step: 'copy-files' })
    const resumed = await caller.taskMoves.resume({ id: move.id })
    expect(resumed).toMatchObject({ status: 'running', error: null, step: 'copy-files' })
    await caller.taskMoves.cancel({ id: move.id })
  })

  test('a move that failed copying the sessions can go on without them', async () => {
    const t = await create('Skip the sessions')
    const move = await advanceTo(await begin([t.id]), 'copy-sessions')
    expect(move.includeSessions).toBe(true)
    // Running: not yet.
    const running = await errOf(() => caller.taskMoves.skipSessions({ id: move.id }))
    expect(running.code).toBe('PRECONDITION_FAILED')

    await caller.taskMoves.fail({ id: move.id, error: 'computer away' })
    const skipped = await caller.taskMoves.skipSessions({ id: move.id })
    expect(skipped).toMatchObject({
      includeSessions: false,
      status: 'failed',
      step: 'copy-sessions'
    })
    // Saying it again changes nothing.
    expect((await caller.taskMoves.skipSessions({ id: move.id })).includeSessions).toBe(false)
    const resumed = await caller.taskMoves.resume({ id: move.id })
    expect(resumed).toMatchObject({ status: 'running', includeSessions: false })
    await caller.taskMoves.cancel({ id: move.id })
  })

  test('the sessions cannot be skipped once they were copied', async () => {
    const t = await create('Too late to skip')
    const move = await advanceTo(await begin([t.id]), 'links')
    await caller.taskMoves.pause({ id: move.id })
    const err = await errOf(() => caller.taskMoves.skipSessions({ id: move.id }))
    expect(err.code).toBe('PRECONDITION_FAILED')
    await caller.taskMoves.cancel({ id: move.id })
  })

  test('cancel is refused once the target took the tasks', async () => {
    const t = await create('Committed')
    const move = await advanceTo(await begin([t.id]), 'release')
    const err = await errOf(() => caller.taskMoves.cancel({ id: move.id }))
    expect(err.code).toBe('PRECONDITION_FAILED')
  })

  test('list answers the moves in the given states', async () => {
    const t = await create('Listed')
    const move = await begin([t.id])
    await caller.taskMoves.pause({ id: move.id })
    const paused = await caller.taskMoves.list({ statuses: ['paused'] })
    expect(paused.map((m) => m.id)).toContain(move.id)
    const running = await caller.taskMoves.list({ statuses: ['running'] })
    expect(running.map((m) => m.id)).not.toContain(move.id)
    await caller.taskMoves.cancel({ id: move.id })
  })
})

describe('release', () => {
  test('leaves a redirect per task and lifts the lock', async () => {
    const parent = await create('Leaving')
    const child = await create('Leaving child', { parentId: parent.id })
    const move = await advanceTo(await begin([parent.id]), 'release')
    const early = await errOf(() => caller.taskMoves.release({ id: crypto.randomUUID() }))
    expect(early.code).toBe('NOT_FOUND')

    const done = await caller.taskMoves.release({ id: move.id })
    expect(done.status).toBe('done')
    expect(await caller.taskMoves.redirects({ taskIds: [parent.id, child.id, 'other'] })).toEqual({
      [parent.id]: { hubId: 'hub-b', moveId: move.id },
      [child.id]: { hubId: 'hub-b', moveId: move.id }
    })
    // Released again: the same answer (a retried step).
    expect((await caller.taskMoves.release({ id: move.id })).status).toBe('done')
  })

  test('release before the release step is refused', async () => {
    const t = await create('Too early')
    const move = await begin([t.id])
    const err = await errOf(() => caller.taskMoves.release({ id: move.id }))
    expect(err.code).toBe('PRECONDITION_FAILED')
    await caller.taskMoves.cancel({ id: move.id })
  })
})

describe('the lock over REST and MCP (the CLI and agents)', () => {
  test('PATCH /api/tasks/:id on a moving task (also by id prefix) is 409', async () => {
    const app = express()
    app.use(express.json())
    registerUpdateTaskRoute(withMoveLockGate(withOwnerGate(app, h.slayDb), h.slayDb), {
      db: h.slayDb,
      notifyRenderer: () => {}
    })
    const rest = await mountRestApp(app)
    try {
      const t = await create('Rest locked')
      const move = await begin([t.id])
      for (const id of [t.id, t.id.slice(0, 8)]) {
        const res = await rest.request<{ ok: boolean; error: string }>(
          'PATCH',
          `/api/tasks/${id}`,
          {
            title: 'nope'
          }
        )
        expect(res.status).toBe(409)
        expect(res.body.error).toMatch(/being moved to another hub/i)
      }
      await caller.taskMoves.cancel({ id: move.id })
      const ok = await rest.request('PATCH', `/api/tasks/${t.id}`, { title: 'fine' })
      expect(ok.status).toBe(200)
    } finally {
      await rest.close()
    }
  })

  test('an MCP tool that writes a moving task is refused; the handler never runs', async () => {
    let ran = 0
    const tools = new Map<string, (...args: unknown[]) => unknown>()
    const server = {
      tool: (name: string, ...rest: unknown[]) =>
        tools.set(name, rest[rest.length - 1] as (...args: unknown[]) => unknown)
    }
    const gated = withMcpMoveLockGate(withMcpOwnerGate(server as never, h.slayDb), h.slayDb)
    ;(gated as unknown as typeof server).tool('update_task', {}, async () => {
      ran++
      return { content: [] }
    })
    const t = await create('Mcp locked')
    const move = await begin([t.id])
    const out = (await tools.get('update_task')?.({ task_id: t.id }, {})) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/being moved to another hub/i)
    expect(ran).toBe(0)
    await caller.taskMoves.cancel({ id: move.id })
  })
})
