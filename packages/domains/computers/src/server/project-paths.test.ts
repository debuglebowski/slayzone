/**
 * The hub's mirror of runner-reported project paths.
 *
 * Built on `project_placements` (v149), which modelled exactly this and had
 * never been wired to anything. The runner authors; the hub records. What matters
 * here is that recording is WHOLESALE (a project a runner dropped must vanish, not
 * linger for reverse lookup to trust) and that the legacy `projects.path` column
 * still answers during the upgrade window, when no runner has reported yet.
 *
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { createTestHarness, test, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { recordRunnerProjectPaths, resolveProjectByPath } from './project-paths.js'

const h = await createTestHarness()
const db = h.slayDb

/**
 * Mirror rows for one project, read directly. `listProjectLocations` was deleted
 * along with the dead checkout CRUD — it had no non-test consumer — but the
 * behavior it was used to observe here (wholesale replace, isolation between
 * runners) is the point of this file, so the read moves inline.
 */
async function locations(projectId: string): Promise<{ runnerId: string; path: string }[]> {
  const rows = await db.all<{ computer_id: string; root_path: string }>(
    `SELECT computer_id, root_path FROM project_placements WHERE project_id = ?`,
    [projectId]
  )
  return rows.map((r) => ({ runnerId: r.computer_id, path: r.root_path }))
}

async function makeProject(id: string, name: string, path: string | null): Promise<void> {
  await db.run(
    `INSERT INTO projects (id, name, color, path, sort_order) VALUES (?, ?, '#fff', ?, 0)`,
    [id, name, path]
  )
}

await makeProject('p-legacy', 'Legacy', '/legacy/root')
await makeProject('p-mirror', 'Mirrored', null)

test('records what a runner reports, and lists every machine holding a project', async () => {
  await recordRunnerProjectPaths(db, 'r1', [
    { projectId: 'p-mirror', path: '/srv/work/app' }
  ])
  await recordRunnerProjectPaths(db, 'r2', [
    { projectId: 'p-mirror', path: '/home/deploy/app' }
  ])

  const held = await locations('p-mirror')
  expect(held.length).toBe(2)
  // The case one hub-side column could never express: the same project at two
  // different absolute paths, both correct, on two different machines.
  expect(held.map((l) => l.path).sort()).toEqual(['/home/deploy/app', '/srv/work/app'])
})

// The report IS the runner's complete state. Merging would leave a row for a
// project it no longer holds, which reverse lookup would then treat as fact.
test('a later report replaces that runner’s rows wholesale', async () => {
  await recordRunnerProjectPaths(db, 'r1', [
    { projectId: 'p-mirror', path: '/srv/work/app' },
    { projectId: 'p-legacy', path: '/srv/work/other' }
  ])
  await recordRunnerProjectPaths(db, 'r1', [
    { projectId: 'p-mirror', path: '/srv/work/moved' }
  ])

  const forMirror = await locations('p-mirror')
  expect(forMirror.find((l) => l.runnerId === 'r1')!.path).toBe('/srv/work/moved')
  // The dropped project is gone from THIS runner, and untouched on the other.
  const forLegacy = await locations('p-legacy')
  expect(forLegacy.filter((l) => l.runnerId === 'r1').length).toBe(0)
})

test('one runner’s report never disturbs another’s rows', async () => {
  const forMirror = await locations('p-mirror')
  expect(forMirror.find((l) => l.runnerId === 'r2')!.path).toBe('/home/deploy/app')
})

test('reverse lookup finds a project through the mirror', async () => {
  const hit = await resolveProjectByPath(db, '/srv/work/moved/src/deep')
  expect(hit!.id).toBe('p-mirror')
  expect(hit!.path).toBe('/srv/work/moved')
})

// Without this the boot right after upgrade breaks `slay`: the mirror is empty
// until a runner connects and reports, and every project would 404 in between.
test('reverse lookup still answers from the legacy column', async () => {
  const hit = await resolveProjectByPath(db, '/legacy/root/pkg')
  expect(hit!.id).toBe('p-legacy')
})

test('reverse lookup picks the deepest match across both sources', async () => {
  await recordRunnerProjectPaths(db, 'r3', [
    { projectId: 'p-mirror', path: '/legacy/root/nested' }
  ])
  const hit = await resolveProjectByPath(db, '/legacy/root/nested/thing')
  expect(hit!.id).toBe('p-mirror')
})

test('reverse lookup returns null for an unrelated directory', async () => {
  expect(await resolveProjectByPath(db, '/tmp/nowhere')).toBeNull()
})

// A runner may still hold a checkout of a project the hub has since deleted. The
// row is stored (no FK on this table) but stays invisible: every reader JOINs
// `projects`. Rejecting instead would let one deleted project fail a whole
// runner's report.
test('a report naming an unknown project neither fails nor becomes visible', async () => {
  await recordRunnerProjectPaths(db, 'r4', [
    { projectId: 'p-mirror', path: '/srv/keep' },
    { projectId: 'does-not-exist', path: '/srv/ghost' }
  ])
  const kept = await locations('p-mirror')
  expect(kept.filter((l) => l.runnerId === 'r4').length).toBe(1)
  // The orphan is not reachable by reverse lookup either.
  expect(await resolveProjectByPath(db, '/srv/ghost/inside')).toBeNull()
  // Cleanup rides the LAST test: `test()` is fire-and-forget, so a top-level
  // `h.cleanup()` closes the database before any async body has run.
  h.cleanup()
})
