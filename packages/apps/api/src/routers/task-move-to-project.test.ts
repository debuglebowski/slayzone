/**
 * Moving tasks to another project (same hub): `task.moveToProject`, its read-only
 * `task.movePreview`, and the `task.update` / `task.updateMany` project changes that
 * now go through the same move.
 *
 *   - the whole subtree moves (archived subtasks too), in one transaction;
 *   - a task moved without its parent is detached; subtasks left behind are detached;
 *   - tags come along: the target's tag of the same name, else a new one there;
 *   - each moved row's status re-homes to the target's columns, its worktree,
 *     repo and base dir are cleared, and its sessions reset;
 *   - a missing target project is a named BAD_REQUEST, nothing written;
 *   - one activity entry per move (plus the status change), never duplicated.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/task-move-to-project.test.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { CreateTaskInput, Task, TasksChange, UpdateTaskInput } from '@slayzone/task-contracts'
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
import { setTaskMoveSessionsDelegate, type TaskMoveSessionsDelegate } from '@slayzone/task/server'

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
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-task-move-')) }
const killed: string[] = []
/** Tasks whose agents (PTYs and chats) the move stopped. */
const stopped: string[] = []
configureTaskRuntimeAdapters({
  getDataRoot: () => ctx.dataRoot,
  worktrees: defaultWorktreeExecAdapters,
  worktreePolicy: defaultWorktreePolicyAdapters,
  killPtysByTaskId: (taskId: string) => void killed.push(taskId),
  stopTaskAgents: async (taskId: string) => void stopped.push(taskId)
})
const folders = installTaskPathsComputer()
const caller = taskRouter.createCaller(ctx)

beforeEach(() => {
  signals.length = 0
  killed.length = 0
  stopped.length = 0
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
      'SELECT project_id, parent_id, status, repo_name, has_worktree, archived_at FROM tasks WHERE id = ?'
    )
    .get(id) as {
    project_id: string
    parent_id: string | null
    status: string
    repo_name: string | null
    has_worktree: number
    archived_at: string | null
  }
const tagsOf = (taskId: string) =>
  h.db
    .prepare(
      'SELECT tg.project_id, tg.name, tg.color, tg.text_color FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.task_id = ? ORDER BY tg.name'
    )
    .all(taskId) as { project_id: string; name: string; color: string; text_color: string }[]
// Colours are unique per project (tags_project_color_unique): a random pair unless given.
const randomHex = (): string => `#${crypto.randomBytes(3).toString('hex')}`
function tag(projectId: string, name: string, color = randomHex(), textColor = '#ffffff'): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, 0)'
    )
    .run(id, projectId, name, color, textColor)
  return id
}
const tagTask = (taskId: string, tagId: string) =>
  h.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId)
const resetsOf = (taskId: string) =>
  h.db.prepare('SELECT mode, tab_id FROM session_resets WHERE task_id = ?').all(taskId)
const eventsOf = (taskId: string) =>
  h.db
    .prepare('SELECT kind, payload_json FROM activity_events WHERE task_id = ? ORDER BY created_at')
    .all(taskId) as { kind: string; payload_json: string | null }[]
/** A session that ran on the task's computer, so a reset has something to cut off. */
const seedSession = (taskId: string, mode = 'claude-code', tabId?: string) =>
  computer.service.handle({
    op: 'recordConversation',
    args: {
      taskId,
      mode,
      ...(tabId ? { tabId } : {}),
      conversationId: crypto.randomUUID(),
      origin: 'slay-spawned-resume',
      createdAt: Date.now()
    }
  })
/** An agent tab of the task (the main tab's id is the task id). */
function agentTab(taskId: string, mode: string, opts: { main?: boolean; label?: string } = {}) {
  const id = opts.main ? taskId : crypto.randomUUID()
  h.db
    .prepare(
      'INSERT OR REPLACE INTO terminal_tabs (id, task_id, label, mode, is_main, position) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, taskId, opts.label ?? null, mode, opts.main ? 1 : 0, opts.main ? 0 : 1)
  return id
}
/** Forget what the setup signalled and killed; the move's own come after. */
const quiet = () => {
  signals.length = 0
  killed.length = 0
}
const errOf = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await fn()
    return { message: '' }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}

describe('task.moveToProject', () => {
  test('moves the whole subtree, archived subtasks included, and names every row', async () => {
    const a = project('SubtreeA')
    const b = project('SubtreeB', COLUMNS_B)
    const parent = await create(a, 'Parent', { status: 'doing' })
    const child = await create(a, 'Child', { parentId: parent.id, status: 'done' })
    const grandchild = await create(a, 'Grandchild', { parentId: child.id })
    const archivedChild = await create(a, 'Archived child', { parentId: parent.id })
    h.db
      .prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ?")
      .run(archivedChild.id)
    const bystander = await create(a, 'Bystander')
    quiet()

    await caller.moveToProject({ taskIds: [parent.id], targetProjectId: b, includeSubtasks: true })

    for (const id of [parent.id, child.id, grandchild.id, archivedChild.id])
      expect(row(id).project_id).toBe(b)
    expect(row(bystander.id).project_id).toBe(a)
    // The hierarchy is kept.
    expect(row(child.id).parent_id).toBe(parent.id)
    expect(row(grandchild.id).parent_id).toBe(child.id)
    // Each row's status re-homes on its own: 'done' exists in B, the others do not.
    expect(row(parent.id).status).toBe('triage')
    expect(row(child.id).status).toBe('done')
    expect(row(grandchild.id).status).toBe('triage')
    expect(row(archivedChild.id).archived_at).not.toBeNull()
    expect(signals).toEqual([[parent.id, child.id, grandchild.id, archivedChild.id].sort()])
    expect(killed.sort()).toEqual([parent.id, child.id, grandchild.id, archivedChild.id].sort())
  })

  test('without subtasks: the subtasks stay and are detached from the moved parent', async () => {
    const a = project('NoSubA')
    const b = project('NoSubB')
    const parent = await create(a, 'Parent')
    const child = await create(a, 'Child', { parentId: parent.id })
    quiet()
    await caller.moveToProject({ taskIds: [parent.id], targetProjectId: b, includeSubtasks: false })
    expect(row(parent.id).project_id).toBe(b)
    expect(row(child.id)).toMatchObject({ project_id: a, parent_id: null })
    expect(signals).toEqual([[parent.id, child.id].sort()])
  })

  test('a subtask moved on its own is detached from its parent', async () => {
    const a = project('LoneA')
    const b = project('LoneB')
    const parent = await create(a, 'Parent')
    const child = await create(a, 'Child', { parentId: parent.id })
    await caller.moveToProject({ taskIds: [child.id], targetProjectId: b, includeSubtasks: true })
    expect(row(child.id)).toMatchObject({ project_id: b, parent_id: null })
    expect(row(parent.id).project_id).toBe(a)
  })

  test('parent and child both selected: moved once, hierarchy kept', async () => {
    const a = project('BothA')
    const b = project('BothB')
    const parent = await create(a, 'Parent')
    const child = await create(a, 'Child', { parentId: parent.id })
    await caller.moveToProject({
      taskIds: [child.id, parent.id],
      targetProjectId: b,
      includeSubtasks: false
    })
    expect(row(child.id)).toMatchObject({ project_id: b, parent_id: parent.id })
    expect(eventsOf(child.id).filter((e) => e.kind === 'task.project_changed')).toHaveLength(1)
  })

  test('tags come along: same name reused in the target, missing ones created there', async () => {
    const a = project('TagsA')
    const b = project('TagsB')
    const bug = tag(a, 'bug', '#ff0000', '#000000')
    const ui = tag(a, 'ui', '#00ff00', '#111111')
    const bugInB = tag(b, 'bug', '#990000')
    const parent = await create(a, 'Parent')
    const child = await create(a, 'Child', { parentId: parent.id })
    tagTask(parent.id, bug)
    tagTask(parent.id, ui)
    tagTask(child.id, ui)
    quiet()

    await caller.moveToProject({ taskIds: [parent.id], targetProjectId: b, includeSubtasks: true })

    expect(tagsOf(parent.id)).toEqual([
      { project_id: b, name: 'bug', color: '#990000', text_color: '#ffffff' },
      { project_id: b, name: 'ui', color: '#00ff00', text_color: '#111111' }
    ])
    // One 'ui' tag was created in B and both tasks use it.
    expect(tagsOf(child.id)).toEqual([
      { project_id: b, name: 'ui', color: '#00ff00', text_color: '#111111' }
    ])
    const uiTagsInB = h.db
      .prepare("SELECT COUNT(*) AS n FROM tags WHERE project_id = ? AND name = 'ui'")
      .get(b) as { n: number }
    expect(uiTagsInB.n).toBe(1)
    expect(bugInB).toBeTruthy()
    // A tag was created: the board's tag list changed, so a full reload.
    expect(signals).toEqual([null])
  })

  test('a created tag whose colours the target already uses gets a free pair', async () => {
    const a = project('ColorA')
    const b = project('ColorB')
    const red = tag(a, 'red-one', '#ef4444', '#ffffff')
    tag(b, 'other-name', '#ef4444', '#ffffff')
    const t = await create(a, 'Colourful')
    tagTask(t.id, red)
    await caller.moveToProject({ taskIds: [t.id], targetProjectId: b, includeSubtasks: true })
    const [moved] = tagsOf(t.id)
    expect(moved).toMatchObject({ project_id: b, name: 'red-one' })
    expect(`${moved.color}:${moved.text_color}`).not.toBe('#ef4444:#ffffff')
  })

  test('clears worktree, repo and base dir and resets the sessions of every moved row', async () => {
    const a = project('ClearA')
    const b = project('ClearB')
    const parent = await create(a, 'Parent')
    const child = await create(a, 'Child', { parentId: parent.id })
    await seedSession(parent.id)
    await seedSession(child.id)
    await caller.update({
      id: parent.id,
      worktreePath: '/tmp/ClearA/wt',
      repoName: 'r'
    } as unknown as UpdateTaskInput)
    const resetsBefore = resetsOf(parent.id).length
    await caller.moveToProject({ taskIds: [parent.id], targetProjectId: b, includeSubtasks: true })
    expect(row(parent.id)).toMatchObject({ repo_name: null, has_worktree: 0 })
    expect(folders.get(parent.id).worktreePath).toBeNull()
    expect(resetsOf(parent.id)).toHaveLength(resetsBefore + 1)
    expect(resetsOf(child.id)).toHaveLength(1)
  })

  test('one project_changed entry per moved row, the status change beside it', async () => {
    const a = project('HistA')
    const b = project('HistB', COLUMNS_B)
    const t = await create(a, 'Hist', { status: 'doing' })
    await caller.moveToProject({ taskIds: [t.id], targetProjectId: b, includeSubtasks: true })
    const kinds = eventsOf(t.id).map((e) => e.kind)
    expect(kinds.filter((k) => k === 'task.project_changed')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'task.status_changed')).toHaveLength(1)
    const moved = eventsOf(t.id).find((e) => e.kind === 'task.project_changed')
    expect(JSON.parse(moved?.payload_json ?? '{}')).toMatchObject({ from: a, to: b })
  })

  test('a target project that does not exist is a named BAD_REQUEST and writes nothing', async () => {
    const a = project('MissingA')
    const t = await create(a, 'Stay')
    const err = await errOf(() =>
      caller.moveToProject({
        taskIds: [t.id],
        targetProjectId: crypto.randomUUID(),
        includeSubtasks: true
      })
    )
    expect(err.code).toBe('BAD_REQUEST')
    expect(err.message).toMatch(/project not found/i)
    expect(row(t.id).project_id).toBe(a)
  })

  test('rows already in the target are left untouched', async () => {
    const b = project('AlreadyB')
    const t = await create(b, 'Here', { status: 'doing' })
    quiet()
    await caller.moveToProject({ taskIds: [t.id], targetProjectId: b, includeSubtasks: true })
    expect(row(t.id)).toMatchObject({ project_id: b, status: 'doing' })
    expect(eventsOf(t.id).filter((e) => e.kind === 'task.project_changed')).toHaveLength(0)
    expect(signals).toEqual([])
  })
})

describe('task.movePreview', () => {
  test('counts subtasks, names the parent, and lists tags and status changes', async () => {
    const a = project('PreviewA')
    const b = project('PreviewB', COLUMNS_B)
    tag(b, 'bug')
    const bug = tag(a, 'bug')
    const ui = tag(a, 'ui')
    const parent = await create(a, 'Parent', { status: 'doing' })
    const child = await create(a, 'Child', { parentId: parent.id, status: 'done' })
    const grandchild = await create(a, 'Grandchild', { parentId: child.id })
    tagTask(child.id, bug)
    tagTask(child.id, ui)

    const forParent = await caller.movePreview({ taskIds: [parent.id], targetProjectId: b })
    expect(forParent).toMatchObject({
      taskCount: 1,
      subtaskCount: 2,
      detachedFrom: [],
      tagsToCreate: ['ui']
    })
    // Child keeps 'done' (B has it); parent and grandchild re-home.
    expect(forParent.statusChanges.map((c) => [c.taskId, c.from, c.to]).sort()).toEqual(
      [
        [parent.id, 'doing', 'triage'],
        [grandchild.id, 'queued', 'triage']
      ].sort()
    )

    const forChild = await caller.movePreview({ taskIds: [child.id], targetProjectId: b })
    expect(forChild.subtaskCount).toBe(1)
    expect(forChild.detachedFrom).toEqual([
      { taskId: child.id, title: 'Child', parentId: parent.id, parentTitle: 'Parent' }
    ])
  })
})

describe('task.update / task.updateMany with a projectId go through the move', () => {
  test('update: subtasks come along', async () => {
    const a = project('UpdA')
    const b = project('UpdB')
    const parent = await create(a, 'Parent')
    const child = await create(a, 'Child', { parentId: parent.id })
    const moved = (await caller.update({
      id: parent.id,
      projectId: b
    } as unknown as UpdateTaskInput)) as Task
    expect(moved.project_id).toBe(b)
    expect(row(child.id)).toMatchObject({ project_id: b, parent_id: parent.id })
  })

  test('update: a status known in the target is applied after the move', async () => {
    const a = project('UpdStatusA')
    const b = project('UpdStatusB', COLUMNS_B)
    const t = await create(a, 'S', { status: 'doing' })
    const moved = (await caller.update({
      id: t.id,
      projectId: b,
      status: 'done'
    } as unknown as UpdateTaskInput)) as Task
    expect(moved).toMatchObject({ project_id: b, status: 'done' })
  })

  test('update: one project_changed entry, never a duplicate status entry', async () => {
    const a = project('UpdHistA')
    const b = project('UpdHistB', COLUMNS_B)
    const t = await create(a, 'H', { status: 'doing' })
    await caller.update({ id: t.id, projectId: b } as unknown as UpdateTaskInput)
    const kinds = eventsOf(t.id).map((e) => e.kind)
    expect(kinds.filter((k) => k === 'task.project_changed')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'task.status_changed')).toHaveLength(1)
  })

  test('updateMany: every task moves once, with its subtasks', async () => {
    const a = project('ManyA')
    const b = project('ManyB')
    const p1 = await create(a, 'P1')
    const c1 = await create(a, 'C1', { parentId: p1.id })
    const p2 = await create(a, 'P2')
    await caller.updateMany({ ids: [p1.id, p2.id], updates: { projectId: b } })
    for (const id of [p1.id, c1.id, p2.id]) expect(row(id).project_id).toBe(b)
    expect(eventsOf(p1.id).filter((e) => e.kind === 'task.project_changed')).toHaveLength(1)
  })

  test('updateMany: a status change records its activity entry once', async () => {
    const a = project('ManyStatusA')
    const t = await create(a, 'Once', { status: 'queued' })
    await caller.updateMany({ ids: [t.id], updates: { status: 'doing' } })
    expect(eventsOf(t.id).filter((e) => e.kind === 'task.status_changed')).toHaveLength(1)
  })
})

describe('keeping agent sessions (same computer)', () => {
  test('preview: Claude can keep its session, Codex in a terminal cannot (and says why)', async () => {
    const a = project('KeepPreviewA')
    const b = project('KeepPreviewB')
    const t = await create(a, 'Keep preview')
    const main = agentTab(t.id, 'claude-code', { main: true })
    const codex = agentTab(t.id, 'codex', { label: 'Review' })
    agentTab(t.id, 'terminal', { label: 'Shell' })

    const preview = await caller.movePreview({ taskIds: [t.id], targetProjectId: b })
    const byTab = new Map(preview.sessions.map((x) => [x.tabId, x]))
    // Plain shells have no agent session: not listed.
    expect(preview.sessions).toHaveLength(2)
    expect(byTab.get(main)).toMatchObject({ taskId: t.id, mode: 'claude-code', canKeep: true })
    expect(byTab.get(codex)).toMatchObject({ mode: 'codex', canKeep: false, tabLabel: 'Review' })
    expect(byTab.get(codex)?.reason).toMatch(/codex/i)
  })

  test('kept tabs keep their session; the rest reset per tab; every agent stops', async () => {
    const a = project('KeepA')
    const b = project('KeepB')
    const t = await create(a, 'Keeper')
    const main = agentTab(t.id, 'claude-code', { main: true })
    const codex = agentTab(t.id, 'codex')
    await seedSession(t.id, 'claude-code', main)
    await seedSession(t.id, 'codex', codex)
    quiet()

    await caller.moveToProject({
      taskIds: [t.id],
      targetProjectId: b,
      includeSubtasks: true,
      // Codex is asked for too: it cannot follow, so it resets anyway.
      keepSessionTabIds: [main, codex]
    })

    expect(resetsOf(t.id)).toEqual([{ mode: '*', tab_id: codex }])
    // The kept session resumes in the new folder only once its agent restarts there.
    expect(stopped).toEqual([t.id])
  })

  test('no tab kept: the whole task resets, as before', async () => {
    const a = project('KeepNoneA')
    const b = project('KeepNoneB')
    const t = await create(a, 'Fresh')
    agentTab(t.id, 'claude-code', { main: true })
    await seedSession(t.id)
    await caller.moveToProject({ taskIds: [t.id], targetProjectId: b, includeSubtasks: true })
    expect(resetsOf(t.id)).toEqual([{ mode: '*', tab_id: null }])
  })

  test('another computer in the target project: no session can follow', async () => {
    const a = project('KeepComputerA')
    const b = project('KeepComputerB')
    h.db.prepare('UPDATE projects SET default_computer_id = ? WHERE id = ?').run('computer-b', b)
    const t = await create(a, 'Elsewhere')
    const main = agentTab(t.id, 'claude-code', { main: true })
    await seedSession(t.id, 'claude-code', main)

    const preview = await caller.movePreview({ taskIds: [t.id], targetProjectId: b })
    expect(preview.sessions[0]).toMatchObject({ tabId: main, canKeep: false })
    expect(preview.sessions[0].reason).toMatch(/computer/i)

    await caller.moveToProject({
      taskIds: [t.id],
      targetProjectId: b,
      includeSubtasks: true,
      keepSessionTabIds: [main]
    })
    // Nothing could be kept: the whole task resets.
    expect(resetsOf(t.id)).toEqual([{ mode: '*', tab_id: null }])
  })
})

describe('keeping agent sessions (another computer of this hub)', () => {
  /** The hub's computers, in memory: what each call asked for, in order. */
  const calls: string[] = []
  let failLedger = false
  const delegate: TaskMoveSessionsDelegate = {
    exportTask: async (_m, taskId, computers) => {
      calls.push(`export ${taskId} from ${computers?.join(',')}`)
      return { transfers: [], ledger: { rows: taskId } }
    },
    read: async () => '',
    readAttachment: async () => '',
    discard: async () => {
      calls.push('discard')
    },
    forget: async () => undefined,
    holders: async () => ['computer-a'],
    forgetOn: async (taskId, computerId) => {
      calls.push(`forget ${taskId} on ${computerId}`)
    },
    files: async (_m, taskId, computers) => {
      calls.push(`files ${taskId} from ${computers?.join(',')}`)
      return []
    },
    readFile: async () => ({ data: '', eof: true }),
    computerOf: async () => 'computer-b',
    begin: async () => ({ transferId: 'x', offset: 0 }),
    chunk: async () => undefined,
    finish: async () => ({ conversationId: 'c', epoch: 2, missing: [] }),
    putAttachment: async () => undefined,
    activate: async () => undefined,
    importLedger: async (taskId) => {
      if (failLedger) throw new Error('computer-b is not reachable')
      calls.push(`ledger ${taskId}`)
    },
    missingFiles: async () => [],
    writeFile: async () => undefined,
    settle: async (computerId) => {
      calls.push(`settle ${computerId}`)
    }
  }
  beforeAll(() => setTaskMoveSessionsDelegate(delegate))
  afterAll(() => setTaskMoveSessionsDelegate(null))
  beforeEach(() => {
    calls.length = 0
    failLedger = false
  })

  const setup = async (name: string) => {
    const a = project(`${name}A`)
    const b = project(`${name}B`)
    h.db.prepare('UPDATE projects SET default_computer_id = ? WHERE id = ?').run('computer-a', a)
    h.db.prepare('UPDATE projects SET default_computer_id = ? WHERE id = ?').run('computer-b', b)
    const t = await create(a, name)
    const main = agentTab(t.id, 'claude-code', { main: true })
    const codex = agentTab(t.id, 'codex')
    await seedSession(t.id, 'claude-code', main)
    await seedSession(t.id, 'codex', codex)
    return { a, b, t, main, codex }
  }

  test('preview: Claude can follow to the other computer, Codex in a terminal cannot', async () => {
    const { b, t, main, codex } = await setup('FollowPreview')
    const preview = await caller.movePreview({ taskIds: [t.id], targetProjectId: b })
    const byTab = new Map(preview.sessions.map((x) => [x.tabId, x]))
    expect(byTab.get(main)).toMatchObject({ canKeep: true })
    expect(byTab.get(codex)).toMatchObject({ canKeep: false })
  })

  test('a kept session copies to the task’s new computer, the old one lets go, the rest resets', async () => {
    const { b, t, main, codex } = await setup('FollowMove')
    quiet()
    await caller.moveToProject({
      taskIds: [t.id],
      targetProjectId: b,
      includeSubtasks: true,
      keepSessionTabIds: [main, codex]
    })
    // Only the computers that held the task are exported; the new one is the target.
    expect(calls).toEqual([
      `export ${t.id} from computer-a`,
      `files ${t.id} from computer-a`,
      `ledger ${t.id}`,
      'settle computer-b',
      'discard',
      `forget ${t.id} on computer-a`
    ])
    // Codex could not follow: its tab alone resets, as on one computer.
    expect(resetsOf(t.id)).toEqual([{ mode: '*', tab_id: codex }])
    // The agents stopped before anything was copied.
    expect(stopped).toEqual([t.id])
  })

  test('nothing kept: no copy is made', async () => {
    const { b, t } = await setup('FollowNone')
    await caller.moveToProject({ taskIds: [t.id], targetProjectId: b, includeSubtasks: true })
    expect(calls).toEqual([])
    expect(resetsOf(t.id)).toEqual([{ mode: '*', tab_id: null }])
  })

  test('a copy that fails is forgotten on the new computer and the whole task resets', async () => {
    const { b, t, main } = await setup('FollowFail')
    failLedger = true
    await caller.moveToProject({
      taskIds: [t.id],
      targetProjectId: b,
      includeSubtasks: true,
      keepSessionTabIds: [main]
    })
    expect(calls).toContain(`forget ${t.id} on computer-b`)
    // The old computer keeps what it had.
    expect(calls).not.toContain(`forget ${t.id} on computer-a`)
    expect(resetsOf(t.id)).toEqual([{ mode: '*', tab_id: null }])
  })
})
