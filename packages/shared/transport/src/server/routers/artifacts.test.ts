/**
 * artifacts router contract tests via tRPC `createCaller` against the harness DB.
 * The artifact store (CRUD/versions/folders) is electron-free + imported directly.
 * The Electron-only download procedures are covered by e2e (93-artifacts-panel),
 * not here. The task row is seeded via createTaskOp (knows all columns + the FK).
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import type { CreateTaskInput, CreateArtifactInput, CreateArtifactFolderInput } from '@slayzone/task/shared'
import { artifactsRouter } from './artifacts.js'
import { taskOps } from '@slayzone/task/server'

const h = await createTestHarness()
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-artifacts-')) }
const caller = artifactsRouter.createCaller(ctx)

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
const seeded = await taskOps.createTaskOp(
  h.slayDb,
  { projectId, title: 'Host' } as unknown as CreateTaskInput,
  {}
)
const taskId = seeded!.id

const mkArtifact = (title: string, content: string): CreateArtifactInput =>
  ({ taskId, title, content }) as unknown as CreateArtifactInput

test('artifacts router: create → getByTask → readContent', async () => {
  const a = await caller.create(mkArtifact('note.md', 'hello'))
  expect(a).toBeTruthy()
  expect(a!.title).toBe('note.md')
  expect((await caller.getByTask({ taskId })).length).toBe(1)
  expect(await caller.readContent({ id: a!.id })).toBe('hello')
})

test('artifacts router: readContent falls back to the blob when no working file', async () => {
  // Artifacts created via `slay artifacts write` persist ONLY blobs — no
  // materialized working file. Simulate that by deleting the working file after
  // create, then assert readContent still returns the content (from the current
  // version's blob) instead of '' (the blank-editor bug).
  const a = await caller.create(mkArtifact('blob-only.md', 'from-blob'))
  const workingFile = join(ctx.dataRoot, 'artifacts', taskId, `${a!.id}.md`)
  rmSync(workingFile, { force: true })
  expect(existsSync(workingFile)).toBe(false)
  expect(await caller.readContent({ id: a!.id })).toBe('from-blob')
})

test('artifacts router: folders create → list', async () => {
  const f = await caller.foldersCreate(
    { taskId, name: 'Folder' } as unknown as CreateArtifactFolderInput
  )
  expect(f).toBeTruthy()
  expect((await caller.foldersGetByTask({ taskId })).length).toBeGreaterThanOrEqual(1)
})

test('artifacts router: versions list after create', async () => {
  const a = await caller.create(mkArtifact('v.md', 'one'))
  const versions = await caller.versionsList({ artifactId: a!.id })
  expect(Array.isArray(versions)).toBeTruthy()
})

test('artifacts router: delete', async () => {
  const a = await caller.create(mkArtifact('del.md', 'x'))
  expect(await caller.delete({ id: a!.id })).toBe(true)
})

// Contract: artifacts return null/false on a missing id (no throw).
test('artifacts router: missing id → null / false (no throw)', async () => {
  expect(await caller.get({ id: 'nope' })).toBeNull()
  expect(await caller.readContent({ id: 'nope' })).toBeNull()
  expect(await caller.delete({ id: 'nope' })).toBe(false)
})
