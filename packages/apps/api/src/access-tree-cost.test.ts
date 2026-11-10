/**
 * Round-7 N5: a directory-tree access check (`pathTree`: a folder upload, a walk)
 * read the identity of every folder above every registered root, uncached, on every
 * check — thousands of tasks meant thousands of synchronous stats per check, on the
 * hub's event loop. Roots' ancestry is now remembered for the same while as their
 * forms and identities: a repeated check stats only the folder it is asked about.
 */
import * as realFs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'

const stats = { n: 0 }
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof realFs>()
  return {
    ...actual,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      stats.n++
      return actual.statSync(...args)
    }) as typeof actual.statSync
  }
})

const { createTestHarness } = await import('../../../shared/test-utils/ipc-harness.js')
const { canAccess, resource } = await import('./access')

const h = await createTestHarness()
const base = realpathSync(mkdtempSync(join(tmpdir(), 'slz-tree-cost-')))
const A = 'user-a'
h.db
  .prepare(
    `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES ('pA', 'A', '#1', ?, ?)`
  )
  .run(A, join(base, 'a'))
const ROOTS = 300
// Many roots of A's (projects: the hub keeps no task folder, §9 7e).
const insert = h.db.prepare(
  `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES (?, 'r', '#1', ?, ?)`
)
for (let i = 0; i < ROOTS; i++) {
  const root = join(base, 'a', 'wt', `t${i}`)
  mkdirSync(root, { recursive: true })
  insert.run(`p${i}`, A, root)
}
const dir = join(base, 'a', 'upload')
mkdirSync(dir, { recursive: true })
afterAll(() => {
  h.cleanup()
  rmSync(base, { recursive: true, force: true })
})

const check = () =>
  canAccess(
    h.slayDb,
    { authRequired: true, principal: { userId: A }, hubRoots: [] },
    resource('pathTree', dir)
  )

test('a repeated tree check does not stat every root again', async () => {
  expect(await check()).toBe(true)
  stats.n = 0
  expect(await check()).toBe(true)
  // The asked folder's own chain (a handful of folders), not ROOTS × depth.
  expect(stats.n, `${stats.n} stats for one check over ${ROOTS} roots`).toBeLessThan(50)
})
