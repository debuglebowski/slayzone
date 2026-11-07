/**
 * Round-6 L3 on every OS (round-7 N2): the hub folded a COMPUTER's path by probing its
 * own disk, so the bug showed only where the hub's disk folds case (a Mac) — on a
 * Linux CI runner the L3 reproduction passed on the buggy code. Here the hub's disk
 * is made case-insensitive for every probe (`pathFoldsCase` → true, as on a Mac), so
 * a hub that still consulted it for project roots fails on any OS.
 *
 * Part of the ONE review-regression suite (`pnpm test:review-regressions`).
 */
import { describe, expect, test, vi } from 'vitest'

vi.mock('@slayzone/platform/computer-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slayzone/platform/computer-path')>()
  return { ...actual, pathFoldsCase: () => true, volumeIsCaseInsensitive: () => true }
})

const { createTestHarness } = await import('../../../shared/test-utils/ipc-harness.js')
const { canAccess, invalidateAccessCache, resource } = await import('@slayzone/api')
const { gitTargetForPath } = await import('@slayzone/worktrees/hub')

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
const A = 'user-a'
const B = 'user-b'
const project = (id: string, owner: string, path: string) =>
  sql(
    `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES (?, ?, '#000', ?, ?)`,
    id,
    id,
    owner,
    path
  )
// Two users' roots on a (case-sensitive) Linux computer, differing only in case.
project('pA', A, '/home/u/proj')
project('pB', B, '/home/u/PROJ')
sql(
  `INSERT INTO tasks (id, project_id, title, worktree_path) VALUES ('tA', 'pA', 'T', ?)`,
  '/home/u/wt'
)
sql(
  `INSERT INTO tasks (id, project_id, title, worktree_path) VALUES ('tB', 'pB', 'T', ?)`,
  '/home/u/WT'
)

const can = async (user: string, path: string): Promise<boolean> => {
  invalidateAccessCache()
  return canAccess(
    h.slayDb,
    { authRequired: true, principal: { userId: user }, hubRoots: [] },
    resource('path', path)
  )
}

describe("L3 with a case-insensitive hub disk: the computer's case still decides", () => {
  test('each user gets exactly their own letter case', async () => {
    expect(await can(A, '/home/u/proj/.env')).toBe(true)
    expect(await can(B, '/home/u/proj/.env')).toBe(false)
    expect(await can(B, '/home/u/PROJ/.env')).toBe(true)
    expect(await can(A, '/home/u/PROJ/.env')).toBe(false)
  })

  test('routing picks the exact case', async () => {
    expect(await gitTargetForPath(h.slayDb, '/home/u/wt/x')).toEqual({ taskId: 'tA' })
    expect(await gitTargetForPath(h.slayDb, '/home/u/WT/x')).toEqual({ taskId: 'tB' })
  })
})
