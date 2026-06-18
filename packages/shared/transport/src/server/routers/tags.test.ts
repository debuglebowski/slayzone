/**
 * tags router contract tests — exercise the procedures via tRPC `createCaller`
 * against the in-memory harness DB (async SlayzoneDb). Ports the coverage from
 * the legacy tags IPC-handler test (domains/tags/src/electron/handlers.test.ts).
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { tagsRouter } from './tags.js'

const h = await createTestHarness()
const ctx = { db: h.slayDb }
const caller = tagsRouter.createCaller(ctx)

const projectId = crypto.randomUUID()
const projectId2 = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P1', '#000')
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId2, 'P2', '#111')
const taskId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
  .run(taskId, projectId, 'T1', 'inbox', 3, 0)

test('tags router: create defaults + custom color + per-project sort_order', async () => {
  const bug = await caller.create({ name: 'bug', projectId })
  expect(bug.name).toBe('bug')
  expect(bug.color).toBe('#6366f1')
  expect(bug.project_id).toBe(projectId)
  expect(bug.sort_order).toBe(0)
  expect(bug.id).toBeTruthy()

  const feat = await caller.create({ name: 'feat', color: '#ff0000', textColor: '#ffffff', projectId })
  expect(feat.color).toBe('#ff0000')
  expect(feat.sort_order).toBe(1)

  const chore = await caller.create({ name: 'chore', color: '#22c55e', textColor: '#ffffff', projectId })
  expect(chore.sort_order).toBe(2)
})

test('tags router: same name + same color allowed across projects', async () => {
  const bug2 = await caller.create({ name: 'bug', projectId: projectId2 })
  expect(bug2.name).toBe('bug')
  expect(bug2.project_id).toBe(projectId2)
  const green = await caller.create({ name: 'green', color: '#22c55e', textColor: '#ffffff', projectId: projectId2 })
  expect(green.color).toBe('#22c55e')
  expect(green.project_id).toBe(projectId2)
})

test('tags router: rejects duplicate (color,textColor) within project', async () => {
  let threw = false
  try {
    await caller.create({ name: 'dup', color: '#22c55e', textColor: '#ffffff', projectId })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
})

test('tags router: list ordered by sort_order', async () => {
  const tags = await caller.list()
  const p1 = tags.filter((t) => t.project_id === projectId)
  expect(p1[0].name).toBe('bug')
  expect(p1[1].name).toBe('feat')
  expect(p1[2].name).toBe('chore')
})

test('tags router: update name + color-only preserves name', async () => {
  const p1 = (await caller.list()).filter((t) => t.project_id === projectId)
  const renamed = await caller.update({ id: p1[0].id, name: 'bugfix' })
  expect(renamed.name).toBe('bugfix')
  const recolored = await caller.update({ id: p1[0].id, color: '#00ff00' })
  expect(recolored.color).toBe('#00ff00')
  expect(recolored.name).toBe('bugfix')
})

test('tags router: reorder by id array', async () => {
  const p1 = (await caller.list()).filter((t) => t.project_id === projectId)
  const reversed = [...p1].reverse().map((t) => t.id)
  await caller.reorder({ tagIds: reversed })
  const after = (await caller.list()).filter((t) => t.project_id === projectId)
  expect(after[0].name).toBe('chore')
  expect(after[1].name).toBe('feat')
  expect(after[2].name).toBe('bugfix')
})

test('tags router: delete returns true/false', async () => {
  const temp = await caller.create({ name: 'temp', projectId })
  expect(await caller.delete({ id: temp.id })).toBe(true)
  expect(await caller.delete({ id: 'nonexistent' })).toBe(false)
})

test('tags router: setForTask replace semantics + getForTask + clear', async () => {
  const p1 = (await caller.list()).filter((t) => t.project_id === projectId)
  await caller.setForTask({ taskId, tagIds: [p1[0].id, p1[1].id] })
  expect((await caller.getForTask({ taskId })).length).toBe(2)

  await caller.setForTask({ taskId, tagIds: [p1[0].id] })
  const one = await caller.getForTask({ taskId })
  expect(one.length).toBe(1)
  expect(one[0].id).toBe(p1[0].id)

  // re-add one so getAllTaskTagIds has an entry to assert on
  await caller.setForTask({ taskId, tagIds: [p1[0].id] })
  const all = await caller.getAllTaskTagIds()
  expect(all[taskId]?.length).toBe(1)

  await caller.setForTask({ taskId, tagIds: [] })
  expect((await caller.getForTask({ taskId })).length).toBe(0)
})
