/**
 * Creating and re-pointing a project's folder when the hub has computers: the
 * folder is recorded on a computer, never in the hub's `projects.path` column.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { projectsRouter } from './projects-router.js'
import { setProjectFolderHost, type ProjectFolderHost } from './project-folders.js'

const h = await createTestHarness()
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-project-folders-')) }
const caller = projectsRouter.createCaller(ctx)

type Call = [op: string, ...args: unknown[]]
let calls: Call[]
let refuse: string | null
let callerDefault: string | null

beforeEach(() => {
  calls = []
  refuse = null
  callerDefault = 'c-default'
  const host: ProjectFolderHost = {
    computerForNewProject: async () => callerDefault,
    computerForProject: async (projectId) => {
      const row = await h.slayDb.get<{ d: string | null }>(
        'SELECT default_computer_id AS d FROM projects WHERE id = ?',
        [projectId]
      )
      return row?.d ?? null
    },
    setFolder: async (computerId, projectId, path) => {
      calls.push(['set', computerId, projectId, path])
      if (refuse === path) throw new Error(`'${path}' is outside the folders this computer allows`)
      return { path, status: 'ready' }
    },
    relocateFolder: async (computerId, projectId, sourcePath, path) => {
      calls.push(['relocate', computerId, projectId, sourcePath, path])
      return { path, status: 'ready' }
    },
    forgetFolder: async (computerId, projectId) => {
      calls.push(['forget', computerId, projectId])
    }
  }
  setProjectFolderHost(host)
})

afterEach(() => setProjectFolderHost(null))

const legacyPath = async (id: string) =>
  (await h.slayDb.get<{ path: string | null }>('SELECT path FROM projects WHERE id = ?', [id]))!
    .path

test('relocate routes disk work to the existing computer and keeps project identity', async () => {
  const p = await caller.create({ name: 'Move me', color: '#000000', computerId: 'c-3' })
  const result = await caller.relocate({
    id: p.id,
    computerId: 'c-3',
    sourcePath: '/old',
    path: '/new'
  })
  expect(result.id).toBe(p.id)
  expect(result.name).toBe('Move me')
  expect(calls).toEqual([['relocate', 'c-3', p.id, '/old', '/new']])
})

test('relocate refuses a changed computer before touching disk', async () => {
  const p = await caller.create({ name: 'Stay', color: '#000000', computerId: 'c-3' })
  await expect(
    caller.relocate({ id: p.id, computerId: 'other', sourcePath: '/old', path: '/new' })
  ).rejects.toThrow(/computer changed/i)
  expect(calls).toEqual([])
})

const placeFolder = (computerId: string, projectId: string, path: string) =>
  h.slayDb.run(
    `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
     VALUES (?, ?, ?, 'ready', ?)`,
    [computerId, projectId, path, Date.now()]
  )

// Settings → project → Computers: every computer holding a folder offers Relocate,
// not only the one the hub runs the project on.
test('relocate on a computer that is not the project’s, but holds its folder', async () => {
  const p = await caller.create({ name: 'Two homes', color: '#000000', computerId: 'c-3' })
  await placeFolder('c-4', p.id, '/old-4')
  await caller.relocate({ id: p.id, computerId: 'c-4', sourcePath: '/old-4', path: '/new-4' })
  expect(calls).toEqual([['relocate', 'c-4', p.id, '/old-4', '/new-4']])
})

test('relocate on another computer refuses a folder that changed meanwhile', async () => {
  const p = await caller.create({ name: 'Stale', color: '#000000', computerId: 'c-3' })
  await placeFolder('c-4', p.id, '/moved-elsewhere')
  await expect(
    caller.relocate({ id: p.id, computerId: 'c-4', sourcePath: '/old-4', path: '/new-4' })
  ).rejects.toThrow(/folder changed/i)
  expect(calls).toEqual([])
})

test('create with no computer named: the caller’s default becomes the project’s default', async () => {
  const p = await caller.create({ name: 'A', color: '#000000' })
  expect(p.default_computer_id).toBe('c-default')
  expect(calls).toEqual([])
})

test('create with a computer and a folder: the folder is recorded on that computer, not the hub', async () => {
  const p = await caller.create({
    name: 'B',
    color: '#000000',
    computerId: 'c-2',
    path: ' /work/b '
  })
  expect(p.default_computer_id).toBe('c-2')
  expect(calls).toEqual([['set', 'c-2', p.id, '/work/b']])
  expect(await legacyPath(p.id)).toBeNull()
})

// The user is looking at the dialog: a folder the computer refuses must fail the
// create, and must not leave a half-made project behind.
test('a refused folder fails the create and leaves no project', async () => {
  refuse = '/etc/nope'
  const before = (await caller.list()).length
  await expect(caller.create({ name: 'C', color: '#000000', path: '/etc/nope' })).rejects.toThrow(
    /outside/
  )
  expect((await caller.list()).length).toBe(before)
})

test('a folder with no computer to put it on is refused before anything is created', async () => {
  callerDefault = null
  const before = (await caller.list()).length
  await expect(caller.create({ name: 'D', color: '#000000', path: '/work/d' })).rejects.toThrow(
    /computer/i
  )
  expect((await caller.list()).length).toBe(before)
  expect(calls).toEqual([])
})

test('update path: re-points the folder on the project’s computer; null forgets it', async () => {
  const p = await caller.create({ name: 'E', color: '#000000', computerId: 'c-3' })
  await caller.update({ id: p.id, path: '/work/e' })
  await caller.update({ id: p.id, path: null })
  expect(calls).toEqual([
    ['set', 'c-3', p.id, '/work/e'],
    ['forget', 'c-3', p.id]
  ])
  expect(await legacyPath(p.id)).toBeNull()
})

test('update path together with other fields applies both', async () => {
  const p = await caller.create({ name: 'F', color: '#000000', computerId: 'c-3' })
  const updated = await caller.update({ id: p.id, name: 'F2', path: '/work/f' })
  expect(updated.name).toBe('F2')
  expect(calls).toEqual([['set', 'c-3', p.id, '/work/f']])
})

// A project from before folders moved to computers still has the old hub column.
// Re-pointing or clearing its folder must clear that too, or the old value comes
// back (it is carried over to the local computer on the next start).
test('update path clears the legacy column, so the old folder cannot come back', async () => {
  const p = await caller.create({ name: 'G', color: '#000000', computerId: 'c-3' })
  await h.slayDb.run('UPDATE projects SET path = ? WHERE id = ?', ['/old', p.id])
  await caller.update({ id: p.id, path: '/new' })
  expect(await legacyPath(p.id)).toBeNull()

  await h.slayDb.run('UPDATE projects SET path = ? WHERE id = ?', ['/old', p.id])
  await caller.update({ id: p.id, path: null })
  expect(await legacyPath(p.id)).toBeNull()
})

test('updating a project deleted in the meantime is a clear not-found', async () => {
  await expect(caller.update({ id: 'gone', name: 'x' })).rejects.toThrow(/not found/i)
})
