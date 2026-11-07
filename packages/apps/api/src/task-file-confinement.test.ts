/**
 * The `files` scope's confinement against a real, fully migrated database: a scoped
 * (non-`full`) session may reach the file editor only for a task, and only under that
 * task's own folders — its worktree, its base dir, its project's path, or one of its
 * project's computer placements. Everything else is refused, including a path inside
 * nobody's project, which the owner gate alone would let through (`HUB_WIDE`).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/task-file-confinement.test.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { TRPCError } from '@trpc/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { confineTaskFileCall, taskRootsContain } from './task-file-confinement'

const h = await createTestHarness()
const db = h.slayDb
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)

const base = realpathSync(mkdtempSync(join(tmpdir(), 'slz-files-scope-')))
const projectRoot = join(base, 'proj')
const worktree = join(base, 'worktrees', 'feat')
const baseDir = join(base, 'scratch-dir')
const placement = join(base, 'placement')
const otherProject = join(base, 'other')
const outside = join(base, 'outside')
for (const d of [projectRoot, worktree, baseDir, placement, otherProject, outside]) {
  mkdirSync(d, { recursive: true })
}
const escapeLink = join(worktree, 'escape')
symlinkSync(outside, escapeLink)

sql(
  `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES
  ('p1', 'P', '#111', 'u1', ?), ('p2', 'Q', '#222', 'u1', ?)`,
  projectRoot,
  otherProject
)
sql(
  `INSERT INTO tasks (id, project_id, title, worktree_path, base_dir) VALUES
  ('tWorktree', 'p1', 'w', ?, NULL), ('tBase', 'p1', 'b', NULL, ?), ('tOther', 'p2', 'o', NULL, NULL)`,
  worktree,
  baseDir
)
sql(
  `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
  VALUES ('c1', 'p1', ?, 'ok', 0)`,
  placement
)

describe('taskRootsContain', () => {
  test("a path under the task's worktree, base dir, project path or placement", async () => {
    expect(await taskRootsContain(db, 'tWorktree', join(worktree, 'src'))).toBe(true)
    expect(await taskRootsContain(db, 'tWorktree', worktree)).toBe(true)
    expect(await taskRootsContain(db, 'tBase', baseDir)).toBe(true)
    expect(await taskRootsContain(db, 'tWorktree', projectRoot)).toBe(true)
    expect(await taskRootsContain(db, 'tWorktree', join(placement, 'pkg'))).toBe(true)
  })

  test("another task's folder, another project, or a path inside nobody's project", async () => {
    expect(await taskRootsContain(db, 'tWorktree', baseDir)).toBe(false)
    expect(await taskRootsContain(db, 'tWorktree', otherProject)).toBe(false)
    expect(await taskRootsContain(db, 'tOther', projectRoot)).toBe(false)
    expect(await taskRootsContain(db, 'tWorktree', outside)).toBe(false)
    expect(await taskRootsContain(db, 'tWorktree', '/')).toBe(false)
  })

  test('`..` and symlinks are resolved before matching', async () => {
    expect(await taskRootsContain(db, 'tWorktree', join(worktree, '..', '..', 'outside'))).toBe(
      false
    )
    expect(await taskRootsContain(db, 'tWorktree', escapeLink)).toBe(false)
  })

  test('an unknown task, or an empty path, contains nothing', async () => {
    expect(await taskRootsContain(db, 'nope', worktree)).toBe(false)
    expect(await taskRootsContain(db, 'tWorktree', '')).toBe(false)
  })
})

describe('confineTaskFileCall', () => {
  const web = ['read', 'tasks', 'agent', 'files'] as const
  const call = (
    raw: unknown,
    opts: { scopes?: readonly string[]; path?: string } = {}
  ): Promise<void> =>
    confineTaskFileCall({
      db,
      scopes: (opts.scopes ?? web) as never,
      path: opts.path ?? 'fileEditor.readDir',
      getRawInput: async () => raw
    })
  const refused = async (p: Promise<void>): Promise<void> => {
    const err = await p.then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('FORBIDDEN')
  }

  test("a scoped session reaches the editor inside its task's folders", async () => {
    await expect(call({ taskId: 'tWorktree', rootPath: worktree, dirPath: '' })).resolves.toBe(
      undefined
    )
  })

  test('a scoped session without a task is refused', async () => {
    await refused(call({ rootPath: worktree, dirPath: '' }))
  })

  test('a scoped session naming a computer or project instead is refused', async () => {
    await refused(call({ taskId: 'tWorktree', computerId: 'c1', rootPath: worktree }))
    await refused(call({ taskId: 'tWorktree', projectId: 'p1', rootPath: worktree }))
  })

  test("a scoped session pointing outside its task's folders is refused", async () => {
    await refused(call({ taskId: 'tWorktree', rootPath: outside }))
    await refused(call({ taskId: 'tWorktree', rootPath: '/' }))
    await refused(call({ taskId: 'tWorktree', rootPath: escapeLink }))
    await refused(call({ taskId: 'tWorktree' }))
  })

  test('a full session, and a path the files scope does not cover, are untouched', async () => {
    await expect(call({ rootPath: '/' }, { scopes: ['full'] })).resolves.toBe(undefined)
    await expect(call({ id: 'x' }, { path: 'tasks.get' })).resolves.toBe(undefined)
  })
})
