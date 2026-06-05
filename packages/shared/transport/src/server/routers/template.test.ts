/**
 * template router contract tests via tRPC `createCaller` against the harness DB.
 * The template store is electron-free and imported directly by the router.
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import type { CreateTaskTemplateInput, UpdateTaskTemplateInput } from '@slayzone/task/shared'
import { templateRouter } from './template.js'

const h = await createTestHarness()
const caller = templateRouter.createCaller({ db: h.slayDb, dataRoot: '/tmp' })

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
  .run(
    projectId,
    'P',
    '#000',
    '/tmp/p',
    JSON.stringify([{ id: 'todo', label: 'To Do', color: 'gray', position: 0, category: 'unstarted' }])
  )

const mk = (name: string): CreateTaskTemplateInput =>
  ({ projectId, name }) as unknown as CreateTaskTemplateInput

test('template router: create → get → getByProject', async () => {
  const t = await caller.create(mk('T1'))
  expect(t).toBeTruthy()
  expect(t!.name).toBe('T1')
  const got = await caller.get({ id: t!.id })
  expect(got?.id).toBe(t!.id)
  expect((await caller.getByProject({ projectId })).length).toBe(1)
})

test('template router: update → setDefault → delete', async () => {
  const t = await caller.create(mk('T2'))
  const up = await caller.update({ id: t!.id, name: 'T2x' } as unknown as UpdateTaskTemplateInput)
  expect(up!.name).toBe('T2x')
  await caller.setDefault({ projectId, templateId: t!.id })
  expect((await caller.get({ id: t!.id }))?.is_default).toBe(true)
  expect(await caller.delete({ id: t!.id })).toBe(true)
  expect(await caller.get({ id: t!.id })).toBeNull()
})

// Contract: templates do NOT throw on a missing id (unlike the task router) — get/update
// return null, delete returns false. Locks the cross-router asymmetry.
test('template router: missing id → null / false (no throw)', async () => {
  expect(await caller.get({ id: 'nope' })).toBeNull()
  expect(await caller.update({ id: 'nope', name: 'x' } as unknown as UpdateTaskTemplateInput)).toBeNull()
  expect(await caller.delete({ id: 'nope' })).toBe(false)
})
