/**
 * artifacts router contract tests via tRPC `createCaller` against the harness DB.
 * The artifact store (CRUD/versions/folders) is electron-free + imported directly.
 * The Electron-only download procedures are covered by e2e (93-artifacts-panel),
 * not here. The task row is seeded via createTaskOp (knows all columns + the FK).
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { test, expect } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import type {
  CreateTaskInput,
  CreateArtifactInput,
  CreateArtifactFolderInput
} from '@slayzone/task-contracts'
import { artifactsRouter, READ_BASE64_MAX_BYTES } from './artifacts-router.js'
import { getArtifactStorage, setArtifactStorage } from './artifact-storage.js'
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
    JSON.stringify([
      { id: 'todo', label: 'To Do', color: 'gray', position: 0, category: 'unstarted' }
    ])
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
  const f = await caller.foldersCreate({
    taskId,
    name: 'Folder'
  } as unknown as CreateArtifactFolderInput)
  expect(f).toBeTruthy()
  expect((await caller.foldersGetByTask({ taskId })).length).toBeGreaterThanOrEqual(1)
})

test('artifacts router: versions list after create', async () => {
  const a = await caller.create(mkArtifact('v.md', 'one'))
  const versions = await caller.versionsList({ artifactId: a!.id })
  expect(Array.isArray(versions)).toBeTruthy()
})

// Per-artifact document zoom (v152 `zoom_pct`). NULL means "the 100% default",
// so the reset path must write NULL back rather than the literal 100 — otherwise
// every artifact the user ever zoomed keeps a row-level override forever.
test('artifacts router: zoomPct round-trips and resets to null', async () => {
  const a = await caller.create(mkArtifact('zoom.md', 'x'))
  expect(a!.zoom_pct).toBeNull()

  const zoomed = await caller.update({ id: a!.id, zoomPct: 150 })
  expect(zoomed!.zoom_pct).toBe(150)
  expect((await caller.get({ id: a!.id }))!.zoom_pct).toBe(150)

  const reset = await caller.update({ id: a!.id, zoomPct: null })
  expect(reset!.zoom_pct).toBeNull()
})

// An unrelated update must not disturb a stored zoom — the store forwards only
// the keys the caller actually provided.
test('artifacts router: update without zoomPct leaves zoom untouched', async () => {
  const a = await caller.create(mkArtifact('zoom-keep.md', 'x'))
  await caller.update({ id: a!.id, zoomPct: 200 })
  const renamed = await caller.update({ id: a!.id, title: 'zoom-kept.md' })
  expect(renamed!.zoom_pct).toBe(200)
})

// Per-artifact forced HTML preview theme (v167 `html_theme_override`). NULL
// means "no override / system", so the reset path must write NULL back
// rather than a literal — same round-trip contract as zoomPct above.
test('artifacts router: htmlThemeOverride round-trips and resets to null', async () => {
  const a = await caller.create(mkArtifact('theme.html', '<html></html>'))
  expect(a!.html_theme_override).toBeNull()

  const darkened = await caller.update({ id: a!.id, htmlThemeOverride: 'dark' })
  expect(darkened!.html_theme_override).toBe('dark')
  expect((await caller.get({ id: a!.id }))!.html_theme_override).toBe('dark')

  const reset = await caller.update({ id: a!.id, htmlThemeOverride: null })
  expect(reset!.html_theme_override).toBeNull()
})

// An unrelated update must not disturb a stored theme override — the store
// forwards only the keys the caller actually provided.
test('artifacts router: update without htmlThemeOverride leaves it untouched', async () => {
  const a = await caller.create(mkArtifact('theme-keep.html', '<html></html>'))
  await caller.update({ id: a!.id, htmlThemeOverride: 'light' })
  const renamed = await caller.update({ id: a!.id, title: 'theme-kept.html' })
  expect(renamed!.html_theme_override).toBe('light')
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

// ── Binary viewers: a zip's listing and a font's bytes ──

const ZIP_FIXTURE = readFileSync(new URL('./__fixtures__/python-made.zip', import.meta.url))

test('artifacts router: listArchive lists a zip artifact from its central directory', async () => {
  const a = await caller.uploadBlob({
    taskId,
    title: 'bundle.zip',
    bytes: new Uint8Array(ZIP_FIXTURE)
  })
  const listing = await caller.listArchive({ id: a!.id })
  expect(listing!.totalEntries).toBe(4)
  expect(listing!.entries.map((e) => e.path)).toEqual([
    'docs/',
    'docs/readme.md',
    'docs/naïve café.txt',
    'big.bin'
  ])
  expect(await caller.listArchive({ id: 'nope' })).toBeNull()
})

test('artifacts router: listArchive on an artifact a computer holds lists its bytes', async () => {
  const a = await caller.uploadBlob({
    taskId,
    title: 'remote.zip',
    bytes: new Uint8Array(ZIP_FIXTURE)
  })
  const local = getArtifactStorage(ctx.dataRoot)
  setArtifactStorage(ctx.dataRoot, {
    ...local,
    getArtifact: async (db, id) => {
      const row = await local.getArtifact(db, id)
      return row && id === a!.id ? { ...row, storage: { computerId: 'c1', available: true } } : row
    },
    // A computer-held artifact has no file on the hub's disk.
    getArtifactPath: async (db, id) => (id === a!.id ? null : local.getArtifactPath(db, id))
  })
  try {
    expect((await caller.listArchive({ id: a!.id }))!.totalEntries).toBe(4)
  } finally {
    setArtifactStorage(ctx.dataRoot, local)
  }
})

test('artifacts router: listArchive on a file that is not a zip fails with the reason', async () => {
  const a = await caller.uploadBlob({
    taskId,
    title: 'fake.zip',
    bytes: new TextEncoder().encode('not a zip')
  })
  await expect(caller.listArchive({ id: a!.id })).rejects.toThrow(/not a zip archive/i)
})

test('artifacts router: readBase64 returns a small binary artifact, refuses a large one', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  const a = await caller.uploadBlob({ taskId, title: 'face.woff2', bytes })
  expect(await caller.readBase64({ id: a!.id })).toBe(Buffer.from(bytes).toString('base64'))
  expect(await caller.readBase64({ id: 'nope' })).toBeNull()

  const big = await caller.uploadBlob({
    taskId,
    title: 'huge.ttf',
    bytes: new Uint8Array(READ_BASE64_MAX_BYTES + 1)
  })
  await expect(caller.readBase64({ id: big!.id })).rejects.toMatchObject({
    code: 'PAYLOAD_TOO_LARGE'
  })
})
