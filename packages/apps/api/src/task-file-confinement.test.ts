/**
 * The `files` scope's confinement against a real, fully migrated database: a scoped
 * (non-`full`) session may reach the file editor only for a task — named alone, so
 * the task is the call's path scope. Its folders are the computer's to judge (§9
 * Phase 7c): `scope-jail.test.ts` in the computer covers that side.
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
import { confineTaskFileCall } from './task-file-confinement'

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
// The hub keeps only whether each folder is set (§9 7e); the paths are the computer's.
sql(
  `INSERT INTO tasks (id, project_id, title, has_worktree, has_base_dir) VALUES
  ('tWorktree', 'p1', 'w', 1, 0), ('tBase', 'p1', 'b', 0, 1), ('tOther', 'p2', 'o', 0, 0)`
)
sql(
  `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
  VALUES ('c1', 'p1', ?, 'ok', 0)`,
  placement
)

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

  test("its folders are the computer's to judge: the hub keeps no task path", async () => {
    // The hub passes the call on in the task's path scope; the computer confines it.
    await expect(call({ taskId: 'tWorktree', rootPath: outside })).resolves.toBe(undefined)
  })

  test('a full session, and a path the files scope does not cover, are untouched', async () => {
    await expect(call({ rootPath: '/' }, { scopes: ['full'] })).resolves.toBe(undefined)
    await expect(call({ id: 'x' }, { path: 'tasks.get' })).resolves.toBe(undefined)
  })
})
