/**
 * A move between two hubs (slice 3b), end to end through each hub's real router and
 * the app's step engine: the task, its subtree and their tabs, tags, blockers,
 * artifacts (rows), activity and usage arrive on the target with their ids; the
 * target hides and locks them until it commits; the source then lets them go
 * (rows removed — never erased — and redirects left). A move back works.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/task-moves-two-hubs.test.ts
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { CreateTaskInput, Task, TaskMove, UpdateTaskInput } from '@slayzone/task-contracts'
import { configureTaskRuntimeAdapters, setTaskDeps, taskOps } from '@slayzone/task/server'
import { createTaskMoveSteps, runTaskMove } from '@slayzone/task/client'
import {
  defaultWorktreeExecAdapters,
  defaultWorktreePolicyAdapters
} from '@slayzone/worktrees/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { appRouter } from '../router'

const A = await createTestHarness()
const B = await createTestHarness()
// Each hub its own storage: artifact files really travel.
const rootA = mkdtempSync(join(tmpdir(), 'task-moves-hub-a-'))
const rootB = mkdtempSync(join(tmpdir(), 'task-moves-hub-b-'))
setTaskDeps({ ops: taskOps })
configureTaskRuntimeAdapters({
  getDataRoot: () => rootA,
  worktrees: defaultWorktreeExecAdapters,
  worktreePolicy: defaultWorktreePolicyAdapters
})
const hubA = appRouter.createCaller({ db: A.slayDb, dataRoot: rootA } as never)
const hubB = appRouter.createCaller({ db: B.slayDb, dataRoot: rootB } as never)

const COLUMNS_A = [
  { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
  { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
]
const COLUMNS_B = [
  { id: 'triage', label: 'Triage', color: 'gray', position: 0, category: 'triage' },
  { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
]
function project(h: typeof A, name: string, columns: unknown[]): string {
  const id = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, columns_config) VALUES (?, ?, ?, ?)')
    .run(id, name, '#000', JSON.stringify(columns))
  return id
}
const projectA = project(A, 'On A', COLUMNS_A)
const projectB = project(B, 'On B', COLUMNS_B)

const createOn = (hub: typeof hubA, projectId: string, title: string, extra = {}) =>
  hub.task.create({ projectId, title, ...extra } as unknown as CreateTaskInput) as Promise<Task>

/** The app's side: begin on the source, then the step engine against both hubs. */
async function move(
  from: { hub: typeof hubA; id: string },
  to: { hub: typeof hubA; id: string; projectId: string },
  taskIds: string[],
  opts: { pauseAfter?: TaskMove['step'] } = {}
): Promise<TaskMove> {
  const begun = await from.hub.taskMoves.begin({
    taskIds,
    targetHubId: to.id,
    targetProjectId: to.projectId
  })
  let lastStep: TaskMove['step'] = begun.step
  return runTaskMove(begun.id, {
    journal: {
      get: (id) => from.hub.taskMoves.get({ id }),
      advance: (id, completed) => from.hub.taskMoves.advance({ id, completed }),
      progress: (id, step, done, total) => from.hub.taskMoves.progress({ id, step, done, total }),
      pause: (id) => from.hub.taskMoves.pause({ id }),
      fail: (id, error) => from.hub.taskMoves.fail({ id, error }),
      release: (id) => from.hub.taskMoves.release({ id })
    },
    steps: createTaskMoveSteps({
      sourceHubId: from.id,
      source: {
        exportBundle: (id) => from.hub.taskMoves.export({ id }),
        fileManifest: (moveId) => from.hub.artifacts.moveManifest({ moveId }),
        readFile: (moveId, ref, offset, length) =>
          from.hub.artifacts.moveRead({ moveId, ref, offset, length })
      },
      target: {
        importBundle: (input) => to.hub.taskMoves.import(input).then(() => undefined),
        missingFiles: (moveId, entries) => to.hub.artifacts.moveMissing({ moveId, entries }),
        writeFile: (input) => to.hub.artifacts.moveWrite(input).then(() => undefined),
        clearStaging: (moveId) => to.hub.artifacts.moveClearStaging({ moveId }),
        commit: (id) => to.hub.taskMoves.commit({ id }).then(() => undefined)
      }
    }),
    pauseRequested: () => lastStep === opts.pauseAfter,
    onUpdate: (m) => {
      lastStep = m.step
    }
  })
}

const row = (h: typeof A, id: string) =>
  h.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
const count = (h: typeof A, sql: string, ...params: unknown[]) =>
  (h.db.prepare(sql).get(...params) as { n: number }).n
const errOf = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await fn()
    return { message: '' }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}

describe('a move from hub A to hub B', () => {
  test('everything arrives with its ids; A keeps redirects, no rows', async () => {
    const parent = await createOn(hubA, projectA, 'Mover', { status: 'doing' })
    const child = await createOn(hubA, projectA, 'Mover child', {
      parentId: parent.id,
      status: 'done'
    })
    const stays = await createOn(hubA, projectA, 'Stays on A')
    // A tab, a tag, a blocker inside the subtree and one to a task staying on A.
    A.db
      .prepare(
        `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position) VALUES (?, ?, 'Review', 'codex', 0, 1)`
      )
      .run(`tab-${parent.id}`, parent.id)
    const tag = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO tags (id, project_id, name, color, text_color) VALUES (?, ?, 'bug', '#ef4444', '#ffffff')`
      )
      .run(tag, projectA)
    A.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(parent.id, tag)
    A.db
      .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
      .run(child.id, parent.id)
    A.db
      .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
      .run(stays.id, parent.id)
    // A real artifact: a blob and a working copy on A's disk, more than two chunks.
    const big = 'x'.repeat(1_300_000)
    const created = await hubA.artifacts.create({
      taskId: parent.id,
      title: 'notes.md',
      content: `final ${big}`
    })
    const artifact = created!.id
    A.db
      .prepare(`INSERT INTO usage_records (id, provider, model, task_id, input_tokens, output_tokens, timestamp, source_file)
                VALUES (?, 'claude', 'm', ?, 1, 2, '2026-11-12T00:00:00Z', 'f.jsonl')`)
      .run(crypto.randomUUID(), parent.id)

    const done = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [parent.id]
    )
    expect(done.status).toBe('done')

    // On B, with the same ids, in B's project, statuses re-homed, hierarchy kept.
    expect(row(B, parent.id)).toMatchObject({
      project_id: projectB,
      status: 'triage',
      parent_id: null
    })
    expect(row(B, child.id)).toMatchObject({
      project_id: projectB,
      status: 'done',
      parent_id: parent.id
    })
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM terminal_tabs WHERE id = ?', `tab-${parent.id}`)
    ).toBe(1)
    expect(
      B.db
        .prepare(
          `SELECT tg.project_id, tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.task_id = ?`
        )
        .all(parent.id)
    ).toEqual([{ project_id: projectB, name: 'bug' }])
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ?', child.id)
    ).toBe(1)
    // The blocker to a task left on A is not a row on B (a cross-hub link, 3d).
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ?', stays.id)
    ).toBe(0)
    expect(count(B, 'SELECT COUNT(*) AS n FROM task_artifacts WHERE id = ?', artifact)).toBe(1)
    // Its bytes came along, checked by hash: the content and every version's blob.
    expect(await hubB.artifacts.readContent({ id: artifact })).toBe(`final ${big}`)
    const versions = await hubB.artifacts.versionsList({ artifactId: artifact })
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(rootA, 'artifacts', parent.id))).toBe(false)
    expect(count(B, 'SELECT COUNT(*) AS n FROM usage_records WHERE task_id = ?', parent.id)).toBe(1)
    // Its history came along, plus the move itself.
    expect(
      count(
        B,
        "SELECT COUNT(*) AS n FROM activity_events WHERE task_id = ? AND kind = 'task.created'",
        parent.id
      )
    ).toBe(1)
    expect(
      count(
        B,
        "SELECT COUNT(*) AS n FROM activity_events WHERE task_id = ? AND kind = 'task.project_changed'",
        parent.id
      )
    ).toBe(1)
    // Unlocked on B once committed.
    await hubB.task.update({ id: parent.id, title: 'Renamed on B' } as unknown as UpdateTaskInput)

    // Gone from A — not erased — and redirected.
    expect(row(A, parent.id)).toBeUndefined()
    expect(row(A, child.id)).toBeUndefined()
    expect(row(A, stays.id)).toBeDefined()
    expect(
      count(A, 'SELECT COUNT(*) AS n FROM content_erasure_tasks WHERE task_id = ?', parent.id)
    ).toBe(0)
    expect(await hubA.taskMoves.redirects({ taskIds: [parent.id, child.id] })).toEqual({
      [parent.id]: { hubId: 'hub-b', moveId: done.id },
      [child.id]: { hubId: 'hub-b', moveId: done.id }
    })
  })

  test('before the target commits, its copy is hidden from its board and locked', async () => {
    const t = await createOn(hubA, projectA, 'Half way')
    const paused = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id],
      { pauseAfter: 'commit' }
    )
    expect(paused).toMatchObject({ status: 'paused', step: 'commit' })
    expect(row(B, t.id)).toBeDefined()
    const board = await hubB.task.loadBoardData()
    expect(board.tasks.map((x: { id: string }) => x.id)).not.toContain(t.id)
    const write = await errOf(() =>
      hubB.task.update({ id: t.id, title: 'too early' } as unknown as UpdateTaskInput)
    )
    expect(write.code).toBe('PRECONDITION_FAILED')
    // Still A's: on its board, locked.
    expect((await hubA.task.loadBoardData()).tasks.map((x: { id: string }) => x.id)).toContain(t.id)
  })

  test('import is idempotent: a retried import changes nothing', async () => {
    const t = await createOn(hubA, projectA, 'Twice')
    const begun = await hubA.taskMoves.begin({
      taskIds: [t.id],
      targetHubId: 'hub-b',
      targetProjectId: projectB
    })
    const bundle = await hubA.taskMoves.export({ id: begun.id })
    const input = { sourceHubId: 'hub-a', targetProjectId: projectB, bundle }
    await hubB.taskMoves.import(input)
    await hubB.taskMoves.import(input)
    expect(count(B, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ?', t.id)).toBe(1)
    // Canceled: the target's copy goes away, the source's lock lifts.
    await hubB.taskMoves.abort({ id: begun.id })
    expect(row(B, t.id)).toBeUndefined()
    await hubA.taskMoves.cancel({ id: begun.id })
    await hubA.task.update({ id: t.id, title: 'still on A' } as unknown as UpdateTaskInput)
  })

  test('a target project the target hub does not have is refused before anything is written', async () => {
    const t = await createOn(hubA, projectA, 'Nowhere')
    const begun = await hubA.taskMoves.begin({
      taskIds: [t.id],
      targetHubId: 'hub-b',
      targetProjectId: 'missing'
    })
    const bundle = await hubA.taskMoves.export({ id: begun.id })
    const err = await errOf(() =>
      hubB.taskMoves.import({ sourceHubId: 'hub-a', targetProjectId: 'missing', bundle })
    )
    expect(err.code).toBe('BAD_REQUEST')
    expect(row(B, t.id)).toBeUndefined()
    await hubA.taskMoves.cancel({ id: begun.id })
  })

  test('and back again: B to A', async () => {
    const t = await createOn(hubA, projectA, 'Round trip')
    await move({ hub: hubA, id: 'hub-a' }, { hub: hubB, id: 'hub-b', projectId: projectB }, [t.id])
    const back = await move(
      { hub: hubB, id: 'hub-b' },
      { hub: hubA, id: 'hub-a', projectId: projectA },
      [t.id]
    )
    expect(back.status).toBe('done')
    expect(row(A, t.id)).toMatchObject({ project_id: projectA })
    expect(row(B, t.id)).toBeUndefined()
  })
})
