import '../../procedure-policy'
import { setAuthGate } from '@slayzone/trpc-server'
import { bindRestPrincipal } from './principal'
import { withOwnerGate } from './owner-routes'
import { withAdminGate } from './admin-routes'
import express from 'express'
import { afterAll, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureTaskRuntimeAdapters,
  setTaskDeps,
  taskOps,
  taskMovesRouter
} from '@slayzone/task/server'
import type { TaskMove } from '@slayzone/task-contracts'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness'
import { mountRestApp } from '../../../../../shared/test-utils/rest-harness'
import { registerTransferRoutes } from './transfers'

const h = await createTestHarness()
const root = mkdtempSync(join(tmpdir(), 'rest-transfers-'))
configureTaskRuntimeAdapters({ getDataRoot: () => root })
setTaskDeps({ ops: taskOps })
const source = randomUUID()
const target = randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
  .run(source, 'Source', '#123456')
h.db
  .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
  .run(target, 'Destination', '#123456')
const app = express()
app.use(express.json())
registerTransferRoutes(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)
afterAll(() => rest.close())
const task = (title: string) => {
  const id = randomUUID()
  h.db
    .prepare('INSERT INTO tasks (id, project_id, title, "order") VALUES (?, ?, ?, 0)')
    .run(id, source, title)
  return id
}
type Answer = { ok: boolean; error?: string; data: TaskMove }

test('same-hub task copy resolves project names and preserves originals', async () => {
  const id = task('Original')
  const result = await rest.request<Answer>('POST', `/api/tasks/${id.slice(0, 8)}/copy`, {
    project: 'Destination',
    title: 'Fork'
  })
  expect(result.status, result.body.error).toBe(200)
  expect(result.body.data.status).toBe('done')
  expect(h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(id)).toEqual({
    title: 'Original'
  })
  expect(h.db.prepare('SELECT title FROM tasks WHERE project_id = ?').all(target)).toEqual([
    { title: 'Fork' }
  ])
})

test('same-hub move resolves refs and honors no-subtasks', async () => {
  const id = task('Mover')
  const child = task('Stays')
  h.db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(id, child)
  const result = await rest.request<Answer>('POST', `/api/tasks/${id}/move`, {
    project: 'Destination',
    includeSubtasks: false,
    includeSessions: false
  })
  expect(result.status, result.body.error).toBe(200)
  expect(h.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id)).toEqual({
    project_id: target
  })
  expect(h.db.prepare('SELECT project_id, parent_id FROM tasks WHERE id = ?').get(child)).toEqual({
    project_id: source,
    parent_id: null
  })
})

test('cross-hub handoff is durable and exposes controls and progress', async () => {
  const id = task('Queued copy')
  const result = await rest.request<Answer>('POST', `/api/tasks/${id}/copy`, {
    hub: 'Remote hub',
    project: 'Remote project'
  })
  expect(result.status, result.body.error).toBe(200)
  const move = result.body.data
  expect(move.runnerRequested).toBe(true)
  expect(move.includeSessions).toBe(false)
  expect(move.peerHubId).toBe('Remote hub')
  const pause = await rest.request<Answer>('POST', `/api/task-moves/${move.id}/pause`, {})
  expect(pause.body.data.runnerAction).toBe('pause')
  const get = await rest.request<Answer>('GET', `/api/task-moves/${move.id}`)
  expect(get.body.data.id).toBe(move.id)
  expect(h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(id)).toEqual({
    title: 'Queued copy'
  })
})

test('same-hub project copy returns new project ID and chosen name', async () => {
  const result = await rest.request<Answer>('POST', `/api/projects/${source}/copy`, {
    name: 'Project fork'
  })
  expect(result.status, result.body.error).toBe(200)
  expect(result.body.data.targetProjectId).not.toBe(source)
  expect(
    h.db.prepare('SELECT name FROM projects WHERE id = ?').get(result.body.data.targetProjectId)
  ).toEqual({ name: 'Project fork' })
})

test('explicit destination equal to source hub completes through the same-hub move', async () => {
  const id = task('Explicit local move')
  const queued = await rest.request<Answer>('POST', `/api/tasks/${id}/move`, {
    hub: 'This hub',
    project: 'Destination',
    includeSessions: false
  })
  const caller = taskMovesRouter.createCaller({ db: h.slayDb } as never)
  const result = await caller.finishLocal({ id: queued.body.data.id, projectId: target })
  expect(result.status).toBe('done')
  expect(h.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id)).toEqual({
    project_id: target
  })
})

test('authenticated REST transfers work and list only owned journals', async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    bindRestPrincipal(req, { userId: 'transfer-user', role: 'user', scopes: ['full'] })
    next()
  })
  const ownProject = randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, ?, ?, ?)')
    .run(ownProject, 'Owned transfer project', '#123456', 'transfer-user')
  const id = randomUUID()
  h.db
    .prepare('INSERT INTO tasks (id, project_id, title, "order") VALUES (?, ?, ?, 0)')
    .run(id, ownProject, 'Owned original')
  registerTransferRoutes(withOwnerGate(withAdminGate(app), h.slayDb), {
    db: h.slayDb,
    notifyRenderer: () => {}
  })
  const authenticated = await mountRestApp(app)
  setAuthGate(() => true)
  try {
    const copied = await authenticated.request<Answer>('POST', `/api/tasks/${id}/copy`, {
      project: ownProject
    })
    expect(copied.status, copied.body.error).toBe(200)
    const list = await authenticated.request<{ data: TaskMove[] }>('GET', '/api/task-moves')
    expect(list.status).toBe(200)
    expect(list.body.data.length).toBeGreaterThan(0)
    expect(
      list.body.data.every((move) =>
        move.taskIds.every(
          (taskId) =>
            (
              h.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as {
                project_id: string
              }
            )?.project_id === ownProject
        )
      )
    ).toBe(true)
    h.db
      .prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
      .run('transfer-user', `commit_graph:project:${ownProject}`, '{"layout":"mine"}')
    const copiedProject = await authenticated.request<Answer>(
      'POST',
      `/api/projects/${ownProject}/copy`,
      { name: 'Owned project fork' }
    )
    expect(copiedProject.status, copiedProject.body.error).toBe(200)
    expect(
      h.db
        .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
        .get('transfer-user', `commit_graph:project:${copiedProject.body.data.targetProjectId}`)
    ).toEqual({ value: '{"layout":"mine"}' })
  } finally {
    setAuthGate(() => false)
    await authenticated.close()
  }
})
