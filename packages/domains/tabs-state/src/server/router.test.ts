/**
 * openTabs router contract tests: one user's open task tabs on this hub, shared by
 * every client that user signs in with (desktop tab bar, iPad tab bar). Exercised via
 * tRPC `createCaller` against the in-memory harness DB.
 */
import crypto from 'node:crypto'
import { test, expect } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { openTabsRouter } from './router.js'

const h = await createTestHarness()
const principal = (userId: string) => ({ userId, role: 'user' as const, scopes: ['full' as const] })
const anon = openTabsRouter.createCaller({ db: h.slayDb, dataRoot: '' })
const userA = openTabsRouter.createCaller({ db: h.slayDb, dataRoot: '', principal: principal('a') })
const userB = openTabsRouter.createCaller({ db: h.slayDb, dataRoot: '', principal: principal('b') })

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const newTask = (): string => {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, 'T', 'inbox', 3, 0)
  return id
}

test('openTabs: open appends in order, is idempotent, close removes', async () => {
  const [t1, t2, t3] = [newTask(), newTask(), newTask()]
  await anon.open({ taskId: t1 })
  await anon.open({ taskId: t2 })
  await anon.open({ taskId: t3 })
  await anon.open({ taskId: t1 })
  expect(await anon.list()).toEqual([t1, t2, t3])
  await anon.close({ taskId: t2 })
  await anon.close({ taskId: t2 })
  expect(await anon.list()).toEqual([t1, t3])
  await anon.close({ taskId: t1 })
  await anon.close({ taskId: t3 })
})

test('openTabs: opening a task this hub does not have is a no-op', async () => {
  await anon.open({ taskId: 'not-a-task' })
  expect(await anon.list()).toEqual([])
})

test('openTabs: reorder moves the named tabs within their own slots, others stay put', async () => {
  const [t1, t2, t3, t4] = [newTask(), newTask(), newTask(), newTask()]
  for (const t of [t1, t2, t3, t4]) await anon.open({ taskId: t })
  // t4 and t2 swap; t1 and t3 (unnamed) keep their slots. Unknown ids are ignored.
  await anon.reorder({ taskIds: [t4, 'gone', t2] })
  expect(await anon.list()).toEqual([t1, t4, t3, t2])
  // Opening after a reorder still appends at the end.
  const t5 = newTask()
  await anon.open({ taskId: t5 })
  expect(await anon.list()).toEqual([t1, t4, t3, t2, t5])
  for (const t of [t1, t2, t3, t4, t5]) await anon.close({ taskId: t })
})

test('openTabs: each user has their own tabs; no user = the hub without login', async () => {
  const [t1, t2] = [newTask(), newTask()]
  await userA.open({ taskId: t1 })
  await userB.open({ taskId: t2 })
  expect(await userA.list()).toEqual([t1])
  expect(await userB.list()).toEqual([t2])
  expect(await anon.list()).toEqual([])
  await userB.close({ taskId: t1 })
  expect(await userA.list()).toEqual([t1])
})

test('openTabs: deleting a task drops its tab', async () => {
  const t1 = newTask()
  await anon.open({ taskId: t1 })
  h.db.prepare('DELETE FROM tasks WHERE id = ?').run(t1)
  expect(await anon.list()).toEqual([])
})

test('openTabs: onChanged pings the writing user, not another user', async () => {
  const t1 = newTask()
  const seenA: unknown[] = []
  const seenB: unknown[] = []
  const subA = (await userA.onChanged()) as unknown as {
    subscribe: (o: { next: (v: unknown) => void }) => { unsubscribe: () => void }
  }
  const subB = (await userB.onChanged()) as unknown as typeof subA
  const a = subA.subscribe({ next: (v) => seenA.push(v) })
  const b = subB.subscribe({ next: (v) => seenB.push(v) })
  await userA.open({ taskId: t1 })
  await userA.open({ taskId: t1 }) // no change: no ping
  await userA.close({ taskId: t1 })
  a.unsubscribe()
  b.unsubscribe()
  expect(seenA).toHaveLength(2)
  expect(seenB).toHaveLength(0)
})
