/**
 * Duplicating a task as a fresh follow-up: `task.duplicate`.
 *
 *   - the copy keeps what describes the work: title (or the one given), description
 *     and its format, priority, assignee, agent;
 *   - it starts fresh: the target project's default status, no parent, no subtasks,
 *     no worktree, no sessions;
 *   - tags come along by name (the target's tag of the same name, else created there);
 *   - same project: its repo is kept; another project: it has none;
 *   - both tasks get an activity entry naming the other;
 *   - a missing task or project is an error, nothing written.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/task-duplicate.test.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import type { CreateTaskInput, Task, TasksChange } from '@slayzone/task-contracts'
import {
  taskRouter,
  setTaskDeps,
  taskOps,
  configureTaskRuntimeAdapters,
  setTaskSessionLedger
} from '@slayzone/task/server'
import { createSessionLedgerHarness } from '@slayzone/chat-runtime/server'
import {
  defaultWorktreeExecAdapters,
  defaultWorktreePolicyAdapters
} from '@slayzone/worktrees/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { installTaskPathsComputer } from '../../../../shared/test-utils/task-paths-computer.js'

const h = await createTestHarness()
const computer = createSessionLedgerHarness({ db: h.slayDb })
setTaskSessionLedger(computer.ledger)
const signals: Array<string[] | null> = []
setTaskDeps({
  ops: taskOps,
  onMutation: (change?: TasksChange) => {
    signals.push(change ? [...change.taskIds].sort() : null)
  }
})
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-task-duplicate-')) }
configureTaskRuntimeAdapters({
  getDataRoot: () => ctx.dataRoot,
  worktrees: defaultWorktreeExecAdapters,
  worktreePolicy: defaultWorktreePolicyAdapters,
  killPtysByTaskId: () => {},
  stopTaskAgents: async () => {}
})
installTaskPathsComputer()
const caller = taskRouter.createCaller(ctx)

beforeEach(() => {
  signals.length = 0
})

const COLUMNS_A = [
  { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
  { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
]
const COLUMNS_B = [
  { id: 'triage', label: 'Triage', color: 'gray', position: 0, category: 'triage' },
  { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
]
function project(name: string, columns: unknown[] = COLUMNS_A): string {
  const id = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, '#000', `/tmp/${name}`, JSON.stringify(columns))
  return id
}
const create = (projectId: string, title: string, extra: Record<string, unknown> = {}) =>
  caller.create({ projectId, title, ...extra } as unknown as CreateTaskInput) as Promise<Task>
const row = (id: string) =>
  h.db
    .prepare(
      `SELECT project_id, parent_id, title, description, description_format, status, priority,
              assignee, agent_id, repo_name, has_worktree FROM tasks WHERE id = ?`
    )
    .get(id) as {
    project_id: string
    parent_id: string | null
    title: string
    description: string | null
    description_format: string
    status: string
    priority: number
    assignee: string | null
    agent_id: string
    repo_name: string | null
    has_worktree: number
  }
const tagsOf = (taskId: string) =>
  h.db
    .prepare(
      'SELECT tg.project_id, tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.task_id = ? ORDER BY tg.name'
    )
    .all(taskId) as { project_id: string; name: string }[]
const randomHex = (): string => `#${crypto.randomBytes(3).toString('hex')}`
function tag(projectId: string, name: string): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, 0)'
    )
    .run(id, projectId, name, randomHex(), '#ffffff')
  return id
}
const tagTask = (taskId: string, tagId: string) =>
  h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId)
const eventsOf = (taskId: string) =>
  h.db
    .prepare(
      'SELECT kind, summary, payload_json FROM activity_events WHERE task_id = ? ORDER BY created_at, rowid'
    )
    .all(taskId) as { kind: string; summary: string; payload_json: string | null }[]
const errOf = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await fn()
    return { message: '' }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}

describe('task.duplicate', () => {
  test('copies what describes the work and starts fresh in the same project', async () => {
    const a = project('DupSame')
    const source = await create(a, 'Fix login', {
      description: 'Steps to reproduce',
      priority: 1,
      assignee: 'kim',
      agentId: 'codex',
      status: 'done',
      repoName: 'web'
    })
    h.db.prepare("UPDATE tasks SET description_format = 'html' WHERE id = ?").run(source.id)

    const { taskId } = await caller.duplicate({ taskId: source.id, targetProjectId: a })

    expect(taskId).not.toBe(source.id)
    expect(row(taskId)).toMatchObject({
      project_id: a,
      parent_id: null,
      title: 'Fix login',
      description: 'Steps to reproduce',
      description_format: 'html',
      status: 'queued',
      priority: 1,
      assignee: 'kim',
      agent_id: 'codex',
      repo_name: 'web',
      has_worktree: 0
    })
    // The source is untouched.
    expect(row(source.id)).toMatchObject({ status: 'done', title: 'Fix login' })
  })

  test('a given title replaces the source title', async () => {
    const a = project('DupTitle')
    const source = await create(a, 'Original')
    const { taskId } = await caller.duplicate({
      taskId: source.id,
      targetProjectId: a,
      title: 'Follow-up: Original'
    })
    expect(row(taskId).title).toBe('Follow-up: Original')
  })

  test('another project: its default status, no repo, tags by name', async () => {
    const a = project('DupFromA')
    const b = project('DupToB', COLUMNS_B)
    const bug = tag(a, 'bug')
    const ui = tag(a, 'ui')
    tag(b, 'bug')
    const source = await create(a, 'Cross', { repoName: 'web', status: 'doing' })
    tagTask(source.id, bug)
    tagTask(source.id, ui)

    const { taskId } = await caller.duplicate({ taskId: source.id, targetProjectId: b })

    expect(row(taskId)).toMatchObject({ project_id: b, status: 'triage', repo_name: null })
    expect(tagsOf(taskId)).toEqual([
      { project_id: b, name: 'bug' },
      { project_id: b, name: 'ui' }
    ])
    // The source keeps its own tags.
    expect(tagsOf(source.id)).toEqual([
      { project_id: a, name: 'bug' },
      { project_id: a, name: 'ui' }
    ])
    const uiInB = h.db
      .prepare("SELECT COUNT(*) AS n FROM tags WHERE project_id = ? AND name = 'ui'")
      .get(b) as { n: number }
    expect(uiInB.n).toBe(1)
  })

  test('subtasks are not copied, and a subtask duplicates as a top-level task', async () => {
    const a = project('DupSub')
    const parent = await create(a, 'Parent')
    const child = await create(a, 'Child', { parentId: parent.id })

    const fromParent = await caller.duplicate({ taskId: parent.id, targetProjectId: a })
    const fromChild = await caller.duplicate({ taskId: child.id, targetProjectId: a })

    const children = h.db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?')
      .get(fromParent.taskId) as { n: number }
    expect(children.n).toBe(0)
    expect(row(fromChild.taskId).parent_id).toBeNull()
  })

  test('both tasks record an entry naming the other', async () => {
    const a = project('DupHistory')
    const b = project('DupHistoryB')
    const source = await create(a, 'Source task')

    const { taskId } = await caller.duplicate({
      taskId: source.id,
      targetProjectId: b,
      title: 'Copy task'
    })

    const copyEvents = eventsOf(taskId)
    expect(copyEvents.map((e) => e.kind)).toEqual(['task.created', 'task.duplicated'])
    expect(copyEvents[1].summary).toBe('Duplicated from “Source task”')
    expect(JSON.parse(copyEvents[1].payload_json!)).toEqual({ sourceTaskId: source.id })

    const sourceEvents = eventsOf(source.id)
    const last = sourceEvents[sourceEvents.length - 1]
    expect(last.kind).toBe('task.duplicate_created')
    expect(last.summary).toBe('Duplicated to “Copy task” in DupHistoryB')
    expect(JSON.parse(last.payload_json!)).toEqual({ taskId, projectId: b })
  })

  test('a missing task or target project is an error and creates nothing', async () => {
    const a = project('DupMissing')
    const source = await create(a, 'Here')
    const count = () => (h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
    const before = count()

    const noTask = await errOf(() =>
      caller.duplicate({ taskId: crypto.randomUUID(), targetProjectId: a })
    )
    expect(noTask.code).toBe('NOT_FOUND')
    const noProject = await errOf(() =>
      caller.duplicate({ taskId: source.id, targetProjectId: crypto.randomUUID() })
    )
    expect(noProject.code).toBe('NOT_FOUND')
    expect(count()).toBe(before)
  })
})
