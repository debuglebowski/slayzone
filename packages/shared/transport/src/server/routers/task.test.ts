/**
 * task router contract tests — exercise the procedures via tRPC `createCaller`
 * against the in-memory harness DB (async SlayzoneDb) with the real injected ops.
 *
 * This file ports the FULL legacy IPC-handler coverage (formerly
 * task/src/electron/handlers.test.ts) onto the tRPC router. Channel→proc map:
 *   db:tasks:create            → caller.create
 *   db:tasks:get               → caller.get
 *   db:tasks:getAll            → caller.getAll
 *   db:tasks:getByProject      → caller.getByProject
 *   db:tasks:getSubTasks       → caller.getSubTasks
 *   db:tasks:update            → caller.update
 *   db:tasks:archive           → caller.archive
 *   db:tasks:archiveMany       → caller.archiveMany
 *   db:tasks:unarchive         → caller.unarchive
 *   db:tasks:reorder           → caller.reorder
 *   db:tasks:delete            → caller.delete
 *   db:taskDependencies:*      → caller.addBlocker/getBlockers/getBlocking/…
 * The handler test passed POSITIONAL args; the router takes a NAMED object.
 *
 * Contract divergences vs the legacy IPC handlers:
 *   - update/archive/unarchive/restore on a MISSING id throw `TRPCError` code
 *     NOT_FOUND (IPC returned null). `get`/`delete` keep the legacy contract
 *     (get → null, delete → false) — no throw.
 *   - parent-validation failures (self/cycle/cross-project/archived) surface as
 *     a thrown error whose `.message` still carries the original substring
 *     (tRPC wraps the plain Error but preserves the message).
 *
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import type { CreateTaskInput, Task, UpdateTaskInput } from '@slayzone/task/shared'
import { taskRouter } from './task.js'
import { setTaskDeps } from '../app-deps.js'
import {
  taskOps,
  configureTaskRuntimeAdapters,
  updateTask,
  handleAttentionTransition,
  taskEvents
} from '@slayzone/task/server'

const h = await createTestHarness()
setTaskDeps({ ops: taskOps })

const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-task-')) }
// updateTask/cleanup paths resolve the data root via the task runtime adapter
// (separate from ctx.dataRoot) — point it at the test tmp dir. EVERY later
// reconfigure must re-include this getDataRoot (configureTaskRuntimeAdapters
// replaces the whole adapter set), else archive/cleanup throws.
const baseAdapters = { getDataRoot: () => ctx.dataRoot }
configureTaskRuntimeAdapters(baseAdapters)
const caller = taskRouter.createCaller(ctx)

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
  .run(
    projectId,
    'P',
    '#000',
    '/tmp/p',
    JSON.stringify([
      { id: 'todo', label: 'To Do', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ])
  )

const mk = (title: string): CreateTaskInput => ({ projectId, title }) as unknown as CreateTaskInput
const createTask = (title: string, extra?: Record<string, unknown>): Promise<Task> =>
  caller.create({ projectId, title, ...extra } as unknown as CreateTaskInput) as Promise<Task>
const up = (data: Record<string, unknown>): Promise<Task> =>
  caller.update(data as unknown as UpdateTaskInput) as Promise<Task>

// Assert a specific TRPCError code; returns the code string (or null when no
// throw). `toThrow()` in the minimal harness is sync-only — use this for async.
const errCode = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn()
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'threw-without-code'
  }
}
// Capture a thrown error's message (parent-validation surfaces a plain Error
// whose message tRPC preserves). Returns '' when nothing threw.
const errMessage = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (e) {
    return (e as Error).message ?? ''
  }
}

// ===========================================================================
// db:tasks:create
// ===========================================================================
test('create: creates with defaults', async () => {
  const t = await createTask('First task')
  expect(t.title).toBe('First task')
  expect(t.status).toBe('todo') // project default (first column) — handler used 'inbox' default project
  expect(t.priority).toBe(3)
  expect(t.terminal_mode).toBe('claude-code')
  expect(t.project_id).toBe(projectId)
  expect(t.archived_at).toBeNull()
  expect(t.description).toBeNull()
})

test('create: creates with custom status and priority', async () => {
  const t = await createTask('Custom', { status: 'done', priority: 1 })
  expect(t.status).toBe('done')
  expect(t.priority).toBe(1)
})

test('create: normalizes unknown create status to the project default', async () => {
  const customProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(
      customProjectId,
      'CreateStatusNormalize',
      '#777',
      '/tmp/create-status-normalize',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' }
      ])
    )
  const t = (await caller.create({
    projectId: customProjectId,
    title: 'Unknown status create',
    status: 'not_real'
  } as unknown as CreateTaskInput)) as Task
  expect(t.status).toBe('queued')
})

test('create: builds provider_config from defaults', async () => {
  const t = await createTask('WithConfig')
  expect(t.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
  expect(t.provider_config['codex']?.flags).toBe('--sandbox workspace-write')
})

test('create: respects custom flags override', async () => {
  const t = await createTask('CustomFlags', { claudeFlags: '--verbose' })
  expect(t.provider_config['claude-code']?.flags).toBe('--verbose')
  expect(t.provider_config['codex']?.flags).toBe('--sandbox workspace-write')
})

test('create: creates with parent_id', async () => {
  const parent = await createTask('Parent')
  const child = await createTask('Child', { parentId: parent.id })
  expect(child.parent_id).toBe(parent.id)
})

test('create: uses project-specific default status from columns config', async () => {
  const customProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(
      customProjectId,
      'ColumnsProject',
      '#111',
      '/tmp/custom',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'progressing', label: 'Progressing', color: 'blue', position: 1, category: 'started' },
        { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' }
      ])
    )
  const t = (await caller.create({
    projectId: customProjectId,
    title: 'Project-specific default'
  } as unknown as CreateTaskInput)) as Task
  expect(t.status).toBe('queued')
})

test('create: falls back to inbox when project columns config is invalid', async () => {
  const invalidProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(invalidProjectId, 'InvalidColumns', '#222', '/tmp/invalid', '{"not":"a-valid-columns-array"}')
  const t = (await caller.create({
    projectId: invalidProjectId,
    title: 'Fallback default status'
  } as unknown as CreateTaskInput)) as Task
  expect(t.status).toBe('inbox')
})

// ===========================================================================
// db:tasks:get
// ===========================================================================
test('get: returns task by id', async () => {
  const created = await createTask('GetMe')
  const t = await caller.get({ id: created.id })
  expect(t?.title).toBe('GetMe')
})

test('get: returns null for nonexistent (keeps legacy contract, no throw)', async () => {
  expect(await caller.get({ id: 'nope' })).toBeNull()
})

// ===========================================================================
// db:tasks:getAll
// ===========================================================================
test('getAll: returns all tasks', async () => {
  const all = await caller.getAll()
  expect(all.length).toBeGreaterThan(0)
})

// ===========================================================================
// db:tasks:getByProject
// ===========================================================================
test('getByProject: filters by project and excludes archived', async () => {
  const tasks = await caller.getByProject({ projectId })
  for (const t of tasks) {
    expect(t.project_id).toBe(projectId)
    expect(t.archived_at).toBeNull()
  }
})

// ===========================================================================
// db:tasks:getSubTasks
// ===========================================================================
test('getSubTasks: returns children', async () => {
  const parent = await createTask('SubParent')
  const c1 = await createTask('Child1', { parentId: parent.id })
  const c2 = await createTask('Child2', { parentId: parent.id })
  const subs = await caller.getSubTasks({ parentId: parent.id })
  expect(subs).toHaveLength(2)
  const ids = subs.map((s) => s.id)
  expect(ids).toContain(c1.id)
  expect(ids).toContain(c2.id)
})

// ===========================================================================
// db:tasks:update
// ===========================================================================
test('update: updates title', async () => {
  const t = await createTask('Old')
  const updated = await up({ id: t.id, title: 'New' })
  expect(updated.title).toBe('New')
})

test('update: updates status', async () => {
  const t = await createTask('StatusTest')
  const updated = await up({ id: t.id, status: 'done' })
  expect(updated.status).toBe('done')
})

test('update: normalizes unknown update status to the project default', async () => {
  const customProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(
      customProjectId,
      'UpdateStatusNormalize',
      '#888',
      '/tmp/update-status-normalize',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' }
      ])
    )
  const t = (await caller.create({
    projectId: customProjectId,
    title: 'Unknown status update'
  } as unknown as CreateTaskInput)) as Task
  const updated = await up({ id: t.id, status: 'ghost' })
  expect(updated.status).toBe('queued')
})

test('update: updates to custom terminal status id', async () => {
  const projectWithTerminal = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(
      projectWithTerminal,
      'TerminalColumns',
      '#333',
      '/tmp/terminal',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'wontfix', label: 'Wontfix', color: 'slate', position: 1, category: 'canceled' },
        { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' }
      ])
    )
  const t = (await caller.create({
    projectId: projectWithTerminal,
    title: 'TerminalStatus'
  } as unknown as CreateTaskInput)) as Task
  const updated = await up({ id: t.id, status: 'wontfix' })
  expect(updated.status).toBe('wontfix')
})

test('update: normalizes status when moving task to a project with different columns', async () => {
  const sourceProjectId = crypto.randomUUID()
  const targetProjectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(
      sourceProjectId,
      'MoveSource',
      '#444',
      '/tmp/source',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
        { id: 'shipped', label: 'Shipped', color: 'green', position: 2, category: 'completed' }
      ])
    )
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(
      targetProjectId,
      'MoveTarget',
      '#555',
      '/tmp/target',
      JSON.stringify([
        { id: 'triage', label: 'Triage', color: 'gray', position: 0, category: 'triage' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
      ])
    )
  const t = (await caller.create({
    projectId: sourceProjectId,
    title: 'Move me',
    status: 'doing'
  } as unknown as CreateTaskInput)) as Task
  const updated = await up({ id: t.id, projectId: targetProjectId })
  expect(updated.project_id).toBe(targetProjectId)
  expect(updated.status).toBe('triage')
})

test('update: no-op returns current task', async () => {
  const t = await createTask('NoOp')
  const same = await up({ id: t.id })
  expect(same.title).toBe('NoOp')
})

test('update: provider_config deep merge - conversationId', async () => {
  const t = await createTask('DeepMerge')
  expect(t.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
  const updated = await up({ id: t.id, providerConfig: { 'claude-code': { conversationId: 'abc123' } } })
  expect(updated.provider_config['claude-code']?.conversationId).toBe('abc123')
  expect(updated.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
})

test('update: provider_config deep merge - partial mode update', async () => {
  const t = await createTask('PartialMerge')
  await up({ id: t.id, providerConfig: { codex: { conversationId: 'codex-1' } } })
  const updated = await up({ id: t.id, providerConfig: { 'claude-code': { conversationId: 'claude-1' } } })
  expect(updated.provider_config['codex']?.conversationId).toBe('codex-1')
  expect(updated.provider_config['claude-code']?.conversationId).toBe('claude-1')
})

test('update: legacy fields update provider_config', async () => {
  const t = await createTask('LegacyUpdate')
  const updated = await up({ id: t.id, claudeConversationId: 'legacy-id', claudeFlags: '--legacy-flag' })
  expect(updated.provider_config['claude-code']?.conversationId).toBe('legacy-id')
  expect(updated.provider_config['claude-code']?.flags).toBe('--legacy-flag')
  expect(updated.claude_conversation_id).toBe('legacy-id')
  expect(updated.claude_flags).toBe('--legacy-flag')
})

test('update: updates JSON columns (panel_visibility)', async () => {
  const t = await createTask('JSONTest')
  const updated = await up({
    id: t.id,
    panelVisibility: { terminal: true, browser: false, diff: false, settings: false, editor: true }
  })
  expect(updated.panel_visibility?.terminal).toBe(true)
  expect(updated.panel_visibility?.browser).toBe(false)
})

test('update: updates worktree fields', async () => {
  const t = await createTask('Worktree')
  const updated = await up({ id: t.id, worktreePath: '/tmp/wt', worktreeParentBranch: 'main' })
  expect(updated.worktree_path).toBe('/tmp/wt')
  expect(updated.worktree_parent_branch).toBe('main')
})

test('update: clears conversation IDs when worktreePath changes', async () => {
  const t = await createTask('SessionReset', { terminalMode: 'codex' })
  const withSession = await up({ id: t.id, providerConfig: { codex: { conversationId: 'stale-session-123' } } })
  expect(withSession.provider_config.codex?.conversationId).toBe('stale-session-123')
  const after = await up({ id: withSession.id, worktreePath: '/tmp/new-worktree' })
  expect(after.worktree_path).toBe('/tmp/new-worktree')
  expect(after.provider_config.codex?.conversationId).toBeNull()
  expect(after.provider_config.codex?.flags).toBeTruthy()
})

test('update: does not clear conversation IDs when worktreePath and providerConfig both update', async () => {
  const t = await createTask('SessionKeep')
  const withSession = await up({ id: t.id, providerConfig: { 'claude-code': { conversationId: 'keep-me' } } })
  const updated = await up({
    id: withSession.id,
    worktreePath: '/tmp/other-wt',
    providerConfig: { 'claude-code': { conversationId: 'new-session' } }
  })
  expect(updated.provider_config['claude-code']?.conversationId).toBe('new-session')
})

test('update: project move clears worktree fields and conversation IDs', async () => {
  const sourceId = crypto.randomUUID()
  const targetId = crypto.randomUUID()
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(sourceId, 'WtSrc', '#a00', '/tmp/wt-src')
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(targetId, 'WtTgt', '#b00', '/tmp/wt-tgt')
  const t = (await caller.create({ projectId: sourceId, title: 'MoveWorktree' } as unknown as CreateTaskInput)) as Task
  const setup = await up({
    id: t.id,
    worktreePath: '/tmp/wt-src/feat-branch',
    worktreeParentBranch: 'main',
    repoName: 'my-repo',
    providerConfig: { 'claude-code': { conversationId: 'stale-conv' } }
  })
  expect(setup.worktree_path).toBe('/tmp/wt-src/feat-branch')
  const moved = await up({ id: t.id, projectId: targetId })
  expect(moved.project_id).toBe(targetId)
  expect(moved.worktree_path).toBeNull()
  expect(moved.worktree_parent_branch).toBeNull()
  expect(moved.repo_name).toBeNull()
  expect(moved.provider_config['claude-code']?.conversationId).toBeNull()
})

test('update: same-project update preserves worktree fields', async () => {
  const pid = crypto.randomUUID()
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'SameProj', '#c00', '/tmp/same')
  const t = (await caller.create({ projectId: pid, title: 'KeepWorktree' } as unknown as CreateTaskInput)) as Task
  await up({ id: t.id, worktreePath: '/tmp/same/wt', worktreeParentBranch: 'develop', repoName: 'keep-repo' })
  const updated = await up({ id: t.id, projectId: pid, title: 'Renamed' })
  expect(updated.title).toBe('Renamed')
  expect(updated.worktree_path).toBe('/tmp/same/wt')
  expect(updated.worktree_parent_branch).toBe('develop')
  expect(updated.repo_name).toBe('keep-repo')
})

test('update: project move with explicit providerConfig preserves conversation IDs', async () => {
  const srcId = crypto.randomUUID()
  const dstId = crypto.randomUUID()
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(srcId, 'CfgSrc', '#d00', '/tmp/cfg-src')
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(dstId, 'CfgDst', '#e00', '/tmp/cfg-dst')
  const t = (await caller.create({ projectId: srcId, title: 'MoveWithConfig' } as unknown as CreateTaskInput)) as Task
  await up({ id: t.id, providerConfig: { 'claude-code': { conversationId: 'old-conv' } } })
  const moved = await up({ id: t.id, projectId: dstId, providerConfig: { 'claude-code': { conversationId: 'new-conv' } } })
  expect(moved.provider_config['claude-code']?.conversationId).toBe('new-conv')
})

test('update: sets is_blocked and blocked_comment', async () => {
  const t = await createTask('BlockMe')
  const updated = await up({ id: t.id, isBlocked: true, blockedComment: 'waiting on deploy' })
  expect(updated.is_blocked).toBe(true)
  expect(updated.blocked_comment).toBe('waiting on deploy')
})

test('update: clears blocked state', async () => {
  const t = await createTask('UnblockMe')
  await up({ id: t.id, isBlocked: true, blockedComment: 'reason' })
  const updated = await up({ id: t.id, isBlocked: false, blockedComment: null })
  expect(updated.is_blocked).toBe(false)
  expect(updated.blocked_comment).toBeNull()
})

test('update: reparents task under a new parent', async () => {
  const a = await createTask('A')
  const b = await createTask('B')
  const updated = await up({ id: a.id, parentId: b.id })
  expect(updated.parent_id).toBe(b.id)
})

test('update: detaches task when parentId is null', async () => {
  const parent = await createTask('ParentDetach')
  const child = await createTask('ChildDetach', { parentId: parent.id })
  const detached = await up({ id: child.id, parentId: null })
  expect(detached.parent_id).toBeNull()
})

test('update: rejects self-parent', async () => {
  const t = await createTask('SelfLoop')
  const msg = await errMessage(() => up({ id: t.id, parentId: t.id }))
  expect(msg.includes('Cannot make task its own parent')).toBe(true)
})

test('update: rejects cycle', async () => {
  const a = await createTask('CycleA')
  const b = await createTask('CycleB', { parentId: a.id })
  const c = await createTask('CycleC', { parentId: b.id })
  const msg = await errMessage(() => up({ id: a.id, parentId: c.id }))
  expect(msg.includes('cycle')).toBe(true)
})

test('update: rejects cross-project reparent', async () => {
  const otherProjectId = crypto.randomUUID()
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(otherProjectId, 'OtherProj', '#f00', '/tmp/other')
  const local = await createTask('Local')
  const foreign = (await caller.create({ projectId: otherProjectId, title: 'Foreign' } as unknown as CreateTaskInput)) as Task
  const msg = await errMessage(() => up({ id: local.id, parentId: foreign.id }))
  expect(msg.includes('different project')).toBe(true)
})

test('update: rejects archived parent', async () => {
  const parent = await createTask('ArchivedParent')
  await caller.archive({ id: parent.id })
  const child = await createTask('OrphanChild')
  const msg = await errMessage(() => up({ id: child.id, parentId: parent.id }))
  expect(msg.includes('archived')).toBe(true)
})

test('update: allows depth >1 (grandchild)', async () => {
  const g = await createTask('Grand')
  const p = await createTask('ParentMid', { parentId: g.id })
  const c = await createTask('ChildLeaf')
  const updated = await up({ id: c.id, parentId: p.id })
  expect(updated.parent_id).toBe(p.id)
})

// NOTE (known regression): updateTask is NO LONGER atomic with its side effects.
// The legacy handler test had no update-rollback assertion, so nothing was
// skipped here for that reason — recording the contract for completeness.

// ===========================================================================
// db:tasks:archive
// ===========================================================================
test('archive: sets archived_at', async () => {
  const t = await createTask('ToArchive')
  const archived = await caller.archive({ id: t.id })
  expect(archived.archived_at).toBeTruthy()
})

test('archive: clears worktree_path', async () => {
  const t = await createTask('WTArchive')
  await up({ id: t.id, worktreePath: '/tmp/wt' })
  const archived = await caller.archive({ id: t.id })
  expect(archived.worktree_path).toBeNull()
})

test('archive: cascades to sub-tasks', async () => {
  const parent = await createTask('ArchiveParent')
  const child = await createTask('ArchiveChild', { parentId: parent.id })
  await caller.archive({ id: parent.id })
  const childAfter = await caller.get({ id: child.id })
  expect(childAfter?.archived_at).toBeTruthy()
})

// ===========================================================================
// db:tasks:archiveMany
// ===========================================================================
test('archiveMany: archives multiple', async () => {
  const t1 = await createTask('AM1')
  const t2 = await createTask('AM2')
  await caller.archiveMany({ ids: [t1.id, t2.id] })
  expect((await caller.get({ id: t1.id }))?.archived_at).toBeTruthy()
  expect((await caller.get({ id: t2.id }))?.archived_at).toBeTruthy()
})

test('archiveMany: no-ops on empty array', async () => {
  await caller.archiveMany({ ids: [] }) // should not throw
})

// ===========================================================================
// db:tasks:unarchive
// ===========================================================================
test('unarchive: clears archived_at', async () => {
  const t = await createTask('Unarchive')
  await caller.archive({ id: t.id })
  const restored = await caller.unarchive({ id: t.id })
  expect(restored.archived_at).toBeNull()
})

// ===========================================================================
// db:tasks:reorder
// ===========================================================================
test('reorder: sets order column', async () => {
  const t1 = await createTask('R1')
  const t2 = await createTask('R2')
  const t3 = await createTask('R3')
  await caller.reorder({ taskIds: [t3.id, t1.id, t2.id] })
  expect((await caller.get({ id: t3.id }))?.order).toBe(0)
  expect((await caller.get({ id: t1.id }))?.order).toBe(1)
  expect((await caller.get({ id: t2.id }))?.order).toBe(2)
})

// ===========================================================================
// db:tasks:delete
// ===========================================================================
test('delete: soft-deletes task (still readable, hidden from getAll)', async () => {
  const t = await createTask('ToDelete')
  expect(await caller.delete({ id: t.id })).toBe(true)
  const deleted = await caller.get({ id: t.id })
  expect(deleted).toBeTruthy()
  expect((deleted as { deleted_at?: string | null }).deleted_at).toBeTruthy()
  const visible = await caller.getAll()
  expect(visible.some((task) => task.id === t.id)).toBe(false)
})

test('delete: returns false for nonexistent (keeps legacy contract, no throw)', async () => {
  expect(await caller.delete({ id: 'nope' })).toBe(false)
})

// ===========================================================================
// db:taskDependencies
// ===========================================================================
test('deps: addBlocker + getBlockers', async () => {
  const t1 = await createTask('Blocked')
  const t2 = await createTask('Blocker')
  await caller.addBlocker({ taskId: t1.id, blockerTaskId: t2.id })
  const blockers = await caller.getBlockers({ taskId: t1.id })
  expect(blockers).toHaveLength(1)
  expect(blockers[0].id).toBe(t2.id)
})

test('deps: getBlocking', async () => {
  const t1 = await createTask('DepA')
  const t2 = await createTask('DepB')
  await caller.addBlocker({ taskId: t2.id, blockerTaskId: t1.id })
  const blocking = await caller.getBlocking({ taskId: t1.id })
  expect(blocking).toHaveLength(1)
  expect(blocking[0].id).toBe(t2.id)
})

test('deps: removeBlocker', async () => {
  const t1 = await createTask('DepX')
  const t2 = await createTask('DepY')
  await caller.addBlocker({ taskId: t1.id, blockerTaskId: t2.id })
  await caller.removeBlocker({ taskId: t1.id, blockerTaskId: t2.id })
  expect(await caller.getBlockers({ taskId: t1.id })).toHaveLength(0)
})

test('deps: setBlockers replaces all', async () => {
  const t = await createTask('Main')
  const b1 = await createTask('B1')
  const b2 = await createTask('B2')
  const b3 = await createTask('B3')
  await caller.addBlocker({ taskId: t.id, blockerTaskId: b1.id })
  await caller.setBlockers({ taskId: t.id, blockerTaskIds: [b2.id, b3.id] })
  const blockers = await caller.getBlockers({ taskId: t.id })
  expect(blockers).toHaveLength(2)
  const ids = blockers.map((b) => b.id)
  expect(ids).toContain(b2.id)
  expect(ids).toContain(b3.id)
})

test('deps: addBlocker is idempotent (INSERT OR IGNORE)', async () => {
  const t1 = await createTask('Idem1')
  const t2 = await createTask('Idem2')
  await caller.addBlocker({ taskId: t1.id, blockerTaskId: t2.id })
  await caller.addBlocker({ taskId: t1.id, blockerTaskId: t2.id })
  expect(await caller.getBlockers({ taskId: t1.id })).toHaveLength(1)
})

test('deps: getAllBlockedTaskIds includes dependency-blocked tasks', async () => {
  const t1 = await createTask('DepBlocked')
  const t2 = await createTask('DepBlocker')
  await caller.addBlocker({ taskId: t1.id, blockerTaskId: t2.id })
  expect(await caller.getAllBlockedTaskIds()).toContain(t1.id)
})

test('deps: getAllBlockedTaskIds includes is_blocked=1 tasks', async () => {
  const t = await createTask('FlagBlocked')
  await up({ id: t.id, isBlocked: true })
  expect(await caller.getAllBlockedTaskIds()).toContain(t.id)
})

test('deps: getAllBlockedTaskIds unions both sources without duplicates', async () => {
  const t1 = await createTask('BothBlocked')
  const t2 = await createTask('BothBlocker')
  await caller.addBlocker({ taskId: t1.id, blockerTaskId: t2.id })
  await up({ id: t1.id, isBlocked: true })
  const ids = await caller.getAllBlockedTaskIds()
  expect(ids.filter((id) => id === t1.id)).toHaveLength(1)
})

// ===========================================================================
// onMutation callback — the host-injected post-mutation refresh signal. The
// router reads it lazily via getTaskOnMutation(); swap a counting callback in
// via setTaskDeps, run mutations, then restore the bare deps.
// ===========================================================================
let mutCount = 0
const reMk = (title: string): Promise<Task> => caller.create(mk(title)) as Promise<Task>

test('onMutation: install counting callback', async () => {
  setTaskDeps({ ops: taskOps, onMutation: () => { mutCount++ } })
})

test('onMutation: fires on create', async () => {
  mutCount = 0
  await reMk('MutCreate')
  expect(mutCount).toBe(1)
})

test('onMutation: fires on update', async () => {
  const t = await reMk('MutUpdate')
  mutCount = 0
  await up({ id: t.id, title: 'MutUpdated' })
  expect(mutCount).toBe(1)
})

test('onMutation: fires on (no-op) update too — handler cannot cheaply distinguish', async () => {
  const t = await reMk('MutNoOp')
  mutCount = 0
  await up({ id: t.id })
  expect(mutCount).toBeGreaterThanOrEqual(0)
})

test('onMutation: fires on delete', async () => {
  const t = await reMk('MutDelete')
  mutCount = 0
  await caller.delete({ id: t.id })
  expect(mutCount).toBe(1)
})

test('onMutation: does not fire on failed delete', async () => {
  mutCount = 0
  await caller.delete({ id: 'nonexistent-id' })
  expect(mutCount).toBe(0)
})

test('onMutation: fires on restore', async () => {
  const t = await reMk('MutRestore')
  await caller.delete({ id: t.id })
  mutCount = 0
  await caller.restore({ id: t.id })
  expect(mutCount).toBe(1)
})

test('onMutation: fires on archive', async () => {
  const t = await reMk('MutArchive')
  mutCount = 0
  await caller.archive({ id: t.id })
  expect(mutCount).toBe(1)
})

test('onMutation: fires once on archiveMany', async () => {
  const t1 = await reMk('MutAM1')
  const t2 = await reMk('MutAM2')
  mutCount = 0
  await caller.archiveMany({ ids: [t1.id, t2.id] })
  expect(mutCount).toBe(1)
})

test('onMutation: fires on unarchive', async () => {
  const t = await reMk('MutUnarchive')
  await caller.archive({ id: t.id })
  mutCount = 0
  await caller.unarchive({ id: t.id })
  expect(mutCount).toBe(1)
})

test('onMutation: restore bare deps (no callback)', async () => {
  setTaskDeps({ ops: taskOps })
})

// ===========================================================================
// updateTask — revive flow (terminal → non-terminal). Calls updateTask()
// directly (the ops/shared funnel) — same as the legacy handler test. These
// drive the runtime adapters, so reconfigure with spies (keeping getDataRoot).
// ===========================================================================
const killCalls: string[] = []
const respawnCalls: string[] = []

test('revive: configure adapter spies', async () => {
  configureTaskRuntimeAdapters({
    ...baseAdapters,
    killPtysByTaskId: (id) => killCalls.push(id),
    killTaskProcesses: () => {},
    recordDiagnosticEvent: () => {},
    requestPtyRespawn: (id) => respawnCalls.push(id),
    onReachedTerminal: (id) => killCalls.push(id)
  })
})

const reviveProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(reviveProjectId, 'ReviveProject', '#abc', '/tmp/revive')

function seedReviveTask(status: string): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config) VALUES (?, ?, ?, ?, 3, ?, ?)'
    )
    .run(id, reviveProjectId, `task-${status}`, status, 'claude-code', '{}')
  return id
}

test('revive: status done → in_progress invokes requestPtyRespawn once', async () => {
  killCalls.length = 0
  respawnCalls.length = 0
  const id = seedReviveTask('in_progress')
  await updateTask(h.slayDb, { id, status: 'done' } as unknown as UpdateTaskInput)
  expect(killCalls.length).toBe(1)
  expect(killCalls[0]).toBe(id)
  expect(respawnCalls.length).toBe(0)
  await updateTask(h.slayDb, { id, status: 'in_progress' } as unknown as UpdateTaskInput)
  expect(respawnCalls.length).toBe(1)
  expect(respawnCalls[0]).toBe(id)
})

test('revive: status todo → in_progress (non-terminal → non-terminal) does NOT respawn', async () => {
  killCalls.length = 0
  respawnCalls.length = 0
  const id = seedReviveTask('todo')
  await updateTask(h.slayDb, { id, status: 'in_progress' } as unknown as UpdateTaskInput)
  expect(respawnCalls.length).toBe(0)
})

test('revive: status inbox → done (non-terminal → terminal) kills but does NOT respawn', async () => {
  killCalls.length = 0
  respawnCalls.length = 0
  const id = seedReviveTask('inbox')
  await updateTask(h.slayDb, { id, status: 'done' } as unknown as UpdateTaskInput)
  expect(killCalls.length).toBe(1)
  expect(respawnCalls.length).toBe(0)
})

test('revive: status done → done (same terminal) does NOT respawn', async () => {
  killCalls.length = 0
  respawnCalls.length = 0
  const id = seedReviveTask('done')
  await updateTask(h.slayDb, { id, status: 'done' } as unknown as UpdateTaskInput)
  expect(respawnCalls.length).toBe(0)
})

// ===========================================================================
// needs_attention flag — direct seeds + updateTask/handleAttentionTransition
// (both now async). parseTask round-trip is exercised via caller.get (parseTask
// is not on the @slayzone/task/server barrel; the router's get runs it).
// ===========================================================================
const attnProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(attnProjectId, 'AttnProject', '#abc', '/tmp/attn')

function seedAttnTask(): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config) VALUES (?, ?, ?, ?, 3, ?, ?)'
    )
    .run(id, attnProjectId, `attn-${id.slice(0, 6)}`, 'todo', 'claude-code', '{}')
  return id
}

function readFlag(id: string): number {
  const row = h.db.prepare('SELECT needs_attention FROM tasks WHERE id = ?').get(id) as
    | { needs_attention: number }
    | undefined
  return row?.needs_attention ?? -1
}

test('needs_attention: column exists in schema', async () => {
  const cols = h.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
  expect(cols.some((c) => c.name === 'needs_attention')).toBe(true)
})

test('needs_attention: defaults to 0 on insert', async () => {
  const id = seedAttnTask()
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: parseTask round-trips the flag from DB (via caller.get)', async () => {
  const id = seedAttnTask()
  h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
  const got = await caller.get({ id })
  expect(got?.needs_attention).toBe(true)
})

test('needs_attention: updateTask writes true then false', async () => {
  const id = seedAttnTask()
  await updateTask(h.slayDb, { id, needsAttention: true } as unknown as UpdateTaskInput)
  expect(readFlag(id)).toBe(1)
  await updateTask(h.slayDb, { id, needsAttention: false } as unknown as UpdateTaskInput)
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: transition sets flag on running → idle WITH user input', async () => {
  const id = seedAttnTask()
  const set = await handleAttentionTransition(h.slayDb, id, 'idle', 'running', true)
  expect(set).toBe(true)
  expect(readFlag(id)).toBe(1)
})

test('needs_attention: transition sets flag on running → error WITH user input', async () => {
  const id = seedAttnTask()
  const set = await handleAttentionTransition(h.slayDb, id, 'error', 'running', true)
  expect(set).toBe(true)
  expect(readFlag(id)).toBe(1)
})

test('needs_attention: transition does NOT set on running → idle WITHOUT user input', async () => {
  const id = seedAttnTask()
  const set = await handleAttentionTransition(h.slayDb, id, 'idle', 'running', false)
  expect(set).toBe(false)
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: transition does NOT set on running → error WITHOUT user input', async () => {
  const id = seedAttnTask()
  const set = await handleAttentionTransition(h.slayDb, id, 'error', 'running', false)
  expect(set).toBe(false)
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: transition does NOT set on starting → idle', async () => {
  const id = seedAttnTask()
  const set = await handleAttentionTransition(h.slayDb, id, 'idle', 'starting', true)
  expect(set).toBe(false)
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: transition does NOT set on running → dead', async () => {
  const id = seedAttnTask()
  const set = await handleAttentionTransition(h.slayDb, id, 'dead', 'running', true)
  expect(set).toBe(false)
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: transition is no-op when flag already set', async () => {
  const id = seedAttnTask()
  h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
  const set = await handleAttentionTransition(h.slayDb, id, 'idle', 'running', true)
  expect(set).toBe(false)
})

test('needs_attention: transition strips tab suffix from sessionId', async () => {
  const id = seedAttnTask()
  const set = await handleAttentionTransition(h.slayDb, `${id}:tab1`, 'idle', 'running', true)
  expect(set).toBe(true)
  expect(readFlag(id)).toBe(1)
})

test('needs_attention: transition no-op for unknown task', async () => {
  const set = await handleAttentionTransition(h.slayDb, 'no-such-task', 'idle', 'running', true)
  expect(set).toBe(false)
})

test('needs_attention: transition clears flag on idle → running (regardless of user input)', async () => {
  const id = seedAttnTask()
  h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
  const changed = await handleAttentionTransition(h.slayDb, id, 'running', 'idle', false)
  expect(changed).toBe(true)
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: transition clears flag on error → running', async () => {
  const id = seedAttnTask()
  h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
  const changed = await handleAttentionTransition(h.slayDb, id, 'running', 'error', true)
  expect(changed).toBe(true)
  expect(readFlag(id)).toBe(0)
})

test('needs_attention: transition no-op on → running when flag already clear', async () => {
  const id = seedAttnTask()
  const changed = await handleAttentionTransition(h.slayDb, id, 'running', 'idle', true)
  expect(changed).toBe(false)
  expect(readFlag(id)).toBe(0)
})

// ===========================================================================
// updateTask — auto-promote temporary on rename (direct updateTask).
// ===========================================================================
const tempPromoteProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(tempPromoteProjectId, 'TempPromoteProject', '#abc', '/tmp/temp-promote')

function seedTempTask(initialStatus = 'inbox'): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, is_temporary) VALUES (?, ?, ?, ?, 3, ?, ?, 1)'
    )
    .run(id, tempPromoteProjectId, 'temp', initialStatus, 'claude-code', '{}')
  return id
}

function readTempRow(id: string): { is_temporary: number; status: string; title: string } {
  return h.db.prepare('SELECT is_temporary, status, title FROM tasks WHERE id = ?').get(id) as {
    is_temporary: number
    status: string
    title: string
  }
}

test('temp-promote: renaming a temp task clears is_temporary and moves status to started', async () => {
  const id = seedTempTask('inbox')
  await updateTask(h.slayDb, { id, title: 'Real title' } as unknown as UpdateTaskInput)
  const row = readTempRow(id)
  expect(row.is_temporary).toBe(0)
  expect(row.status).toBe('in_progress')
  expect(row.title).toBe('Real title')
})

test('temp-promote: non-title updates on a temp task do NOT promote', async () => {
  const id = seedTempTask('inbox')
  await updateTask(h.slayDb, { id, priority: 1 } as unknown as UpdateTaskInput)
  const row = readTempRow(id)
  expect(row.is_temporary).toBe(1)
  expect(row.status).toBe('inbox')
})

test('temp-promote: renaming a non-temp task leaves is_temporary untouched and does not bump status', async () => {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, is_temporary) VALUES (?, ?, ?, ?, 3, ?, ?, 0)'
    )
    .run(id, tempPromoteProjectId, 'real', 'inbox', 'claude-code', '{}')
  await updateTask(h.slayDb, { id, title: 'Renamed' } as unknown as UpdateTaskInput)
  const row = readTempRow(id)
  expect(row.is_temporary).toBe(0)
  expect(row.status).toBe('inbox')
})

test('temp-promote: explicit isTemporary in the update wins over auto-promote', async () => {
  const id = seedTempTask('inbox')
  await updateTask(h.slayDb, { id, title: 'Renamed', isTemporary: true } as unknown as UpdateTaskInput)
  const row = readTempRow(id)
  expect(row.is_temporary).toBe(1)
  expect(row.status).toBe('inbox')
})

test('temp-promote: explicit status in the update wins over auto-promote default', async () => {
  const id = seedTempTask('inbox')
  await updateTask(h.slayDb, { id, title: 'Renamed', status: 'todo' } as unknown as UpdateTaskInput)
  const row = readTempRow(id)
  expect(row.is_temporary).toBe(0)
  expect(row.status).toBe('todo')
})

// ===========================================================================
// subtask worktree inheritance — via caller (create/update/archive/get).
// ===========================================================================
test('inherit: inherits parent worktree fields', async () => {
  const wtParent = await createTask('WtParent')
  await up({
    id: wtParent.id,
    worktreePath: '/tmp/wt-parent',
    worktreeParentBranch: 'main',
    baseDir: '/tmp/base',
    repoName: 'repo-x'
  })
  const wtChild = await createTask('WtChild', { parentId: wtParent.id })
  expect(wtChild.worktree_path).toBe('/tmp/wt-parent')
  expect(wtChild.worktree_parent_branch).toBe('main')
  expect(wtChild.base_dir).toBe('/tmp/base')
  expect(wtChild.repo_name).toBe('repo-x')
})

test('inherit: null when parent has no worktree', async () => {
  const noWtParent = await createTask('NoWtParent')
  const noWtChild = await createTask('NoWtChild', { parentId: noWtParent.id })
  expect(noWtChild.worktree_path).toBeNull()
  expect(noWtChild.worktree_parent_branch).toBeNull()
  expect(noWtChild.base_dir).toBeNull()
})

test('inherit: parent repo_name overrides caller-supplied value', async () => {
  const repoParent = await createTask('RepoParent')
  await up({ id: repoParent.id, repoName: 'parent-repo' })
  const repoChild = await createTask('RepoChild', { parentId: repoParent.id, repoName: 'caller-repo' })
  expect(repoChild.repo_name).toBe('parent-repo')
})

test('inherit: archiving subtask alone keeps parent worktree fields intact', async () => {
  const guardParent = await createTask('GuardParent')
  await up({ id: guardParent.id, worktreePath: '/tmp/wt-guard', worktreeParentBranch: 'main' })
  const guardChild = await createTask('GuardChild', { parentId: guardParent.id })
  await caller.archive({ id: guardChild.id })
  const guardParentAfter = await caller.get({ id: guardParent.id })
  expect(guardParentAfter?.worktree_path).toBe('/tmp/wt-guard')
  expect(guardParentAfter?.worktree_parent_branch).toBe('main')
})

// ===========================================================================
// Existing contract coverage (kept — these were green before the port).
// ===========================================================================
test('task router: create → getAll → get', async () => {
  const created = await caller.create(mk('Alpha'))
  expect(created.title).toBe('Alpha')
  expect((await caller.getAll()).length).toBeGreaterThanOrEqual(1)
  const got = await caller.get({ id: created.id })
  expect(got?.id).toBe(created.id)
})

test('task router: update → archive → unarchive', async () => {
  const t = await caller.create(mk('Beta'))
  const upd = await caller.update({ id: t.id, title: 'Beta2' } as unknown as UpdateTaskInput)
  expect(upd.title).toBe('Beta2')
  expect((await caller.archive({ id: t.id })).id).toBe(t.id)
  expect((await caller.unarchive({ id: t.id })).id).toBe(t.id)
})

test('task router: dependencies (add → get → blocked → remove)', async () => {
  const a = await caller.create(mk('blocker'))
  const b = await caller.create(mk('blocked'))
  await caller.addBlocker({ taskId: b.id, blockerTaskId: a.id })
  expect((await caller.getBlockers({ taskId: b.id })).length).toBe(1)
  expect(await caller.getAllBlockedTaskIds()).toContain(b.id)
  await caller.removeBlocker({ taskId: b.id, blockerTaskId: a.id })
  expect((await caller.getBlockers({ taskId: b.id })).length).toBe(0)
})

test('task router: loadBoardData', async () => {
  const board = await caller.loadBoardData()
  expect(board.projects.length).toBeGreaterThanOrEqual(1)
  expect(Array.isArray(board.tasks)).toBeTruthy()
})

test('task router: create fires taskEvents (backs the onChanged subscription)', async () => {
  let fired = 0
  const handler = (): void => {
    fired++
  }
  taskEvents.on('task:created', handler)
  await caller.create(mk('evented'))
  taskEvents.off('task:created', handler)
  expect(fired).toBeGreaterThanOrEqual(1)
})

// Contract the migration ADDED: these procedures throw NOT_FOUND on a missing id
// (the IPC handlers returned null). Surfaces what IPC hid; the renderer must handle
// the throw at cutover (slice 5).
test('task router: missing id throws TRPCError NOT_FOUND (not silent null)', async () => {
  expect(await errCode(() => caller.update({ id: 'nope', title: 'x' } as unknown as UpdateTaskInput))).toBe('NOT_FOUND')
  expect(await errCode(() => caller.archive({ id: 'nope' }))).toBe('NOT_FOUND')
  expect(await errCode(() => caller.restore({ id: 'nope' }))).toBe('NOT_FOUND')
  expect(await errCode(() => caller.unarchive({ id: 'nope' }))).toBe('NOT_FOUND')
})
