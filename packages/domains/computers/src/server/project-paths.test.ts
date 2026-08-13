/**
 * The hub's mirror of computer-reported project paths.
 *
 * Built on `project_placements` (v149), which modelled exactly this and had
 * never been wired to anything. The computer authors; the hub records. What matters
 * here is that recording is WHOLESALE (a project a computer dropped must vanish, not
 * linger for reverse lookup to trust) and that the legacy `projects.path` column
 * still answers during the upgrade window, when no computer has reported yet.
 *
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { createTestHarness, test, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { recordComputerProjectPaths, resolveProjectByPath } from './project-paths.js'

const h = await createTestHarness()
const db = h.slayDb

/**
 * Mirror rows for one project, read directly. `listProjectLocations` was deleted
 * along with the dead checkout CRUD — it had no non-test consumer — but the
 * behavior it was used to observe here (wholesale replace, isolation between
 * computers) is the point of this file, so the read moves inline.
 */
async function locations(projectId: string): Promise<{ computerId: string; path: string }[]> {
  const rows = await db.all<{ computer_id: string; root_path: string }>(
    `SELECT computer_id, root_path FROM project_placements WHERE project_id = ?`,
    [projectId]
  )
  return rows.map((r) => ({ computerId: r.computer_id, path: r.root_path }))
}

async function makeProject(id: string, name: string, path: string | null): Promise<void> {
  await db.run(
    `INSERT INTO projects (id, name, color, path, sort_order) VALUES (?, ?, '#fff', ?, 0)`,
    [id, name, path]
  )
}

await makeProject('p-legacy', 'Legacy', '/legacy/root')
await makeProject('p-mirror', 'Mirrored', null)

test('records what a computer reports, and lists every machine holding a project', async () => {
  await recordComputerProjectPaths(db, 'r1', [{ projectId: 'p-mirror', path: '/srv/work/app' }])
  await recordComputerProjectPaths(db, 'r2', [{ projectId: 'p-mirror', path: '/home/deploy/app' }])

  const held = await locations('p-mirror')
  expect(held.length).toBe(2)
  // The case one hub-side column could never express: the same project at two
  // different absolute paths, both correct, on two different machines.
  expect(held.map((l) => l.path).sort()).toEqual(['/home/deploy/app', '/srv/work/app'])
})

// The report IS the computer's complete state. Merging would leave a row for a
// project it no longer holds, which reverse lookup would then treat as fact.
test('a later report replaces that computer’s rows wholesale', async () => {
  await recordComputerProjectPaths(db, 'r1', [
    { projectId: 'p-mirror', path: '/srv/work/app' },
    { projectId: 'p-legacy', path: '/srv/work/other' }
  ])
  await recordComputerProjectPaths(db, 'r1', [{ projectId: 'p-mirror', path: '/srv/work/moved' }])

  const forMirror = await locations('p-mirror')
  expect(forMirror.find((l) => l.computerId === 'r1')!.path).toBe('/srv/work/moved')
  // The dropped project is gone from THIS computer, and untouched on the other.
  const forLegacy = await locations('p-legacy')
  expect(forLegacy.filter((l) => l.computerId === 'r1').length).toBe(0)
})

test('one computer’s report never disturbs another’s rows', async () => {
  const forMirror = await locations('p-mirror')
  expect(forMirror.find((l) => l.computerId === 'r2')!.path).toBe('/home/deploy/app')
})

test('reverse lookup finds a project through the mirror', async () => {
  const hit = await resolveProjectByPath(db, '/srv/work/moved/src/deep')
  expect(hit!.id).toBe('p-mirror')
  expect(hit!.path).toBe('/srv/work/moved')
})

// Without this the boot right after upgrade breaks `slay`: the mirror is empty
// until a computer connects and reports, and every project would 404 in between.
test('reverse lookup still answers from the legacy column', async () => {
  const hit = await resolveProjectByPath(db, '/legacy/root/pkg')
  expect(hit!.id).toBe('p-legacy')
})

test('reverse lookup picks the deepest match across both sources', async () => {
  await recordComputerProjectPaths(db, 'r3', [
    { projectId: 'p-mirror', path: '/legacy/root/nested' }
  ])
  const hit = await resolveProjectByPath(db, '/legacy/root/nested/thing')
  expect(hit!.id).toBe('p-mirror')
})

test('reverse lookup returns null for an unrelated directory', async () => {
  expect(await resolveProjectByPath(db, '/tmp/nowhere')).toBeNull()
})

// A computer may still hold a checkout of a project the hub has since deleted. The
// row is stored (no FK on this table) but stays invisible: every reader JOINs
// `projects`. Rejecting instead would let one deleted project fail a whole
// computer's report.
test('a report naming an unknown project neither fails nor becomes visible', async () => {
  await recordComputerProjectPaths(db, 'r4', [
    { projectId: 'p-mirror', path: '/srv/keep' },
    { projectId: 'does-not-exist', path: '/srv/ghost' }
  ])
  const kept = await locations('p-mirror')
  expect(kept.filter((l) => l.computerId === 'r4').length).toBe(1)
  // The orphan is not reachable by reverse lookup either.
  expect(await resolveProjectByPath(db, '/srv/ghost/inside')).toBeNull()
  // Cleanup rides the LAST test: `test()` is fire-and-forget, so a top-level
  // `h.cleanup()` closes the database before any async body has run.
  h.cleanup()
})
