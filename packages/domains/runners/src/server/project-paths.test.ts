/**
 * The hub's mirror of runner-reported project paths.
 *
 * Built on `runner_project_checkouts` (v149), which modelled exactly this and had
 * never been wired to anything. The runner authors; the hub records. What matters
 * here is that recording is WHOLESALE (a project a runner dropped must vanish, not
 * linger for reverse lookup to trust) and that the legacy `projects.path` column
 * still answers during the upgrade window, when no runner has reported yet.
 *
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import { createTestHarness, test, expect } from '../../../../shared/test-utils/ipc-harness.js'
import {
  listProjectLocations,
  recordRunnerProjectPaths,
  resolveProjectByPath
} from './project-paths.js'

const h = await createTestHarness()
const db = h.slayDb

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
    { projectId: 'p-mirror', path: '/srv/work/app', source: 'provisioned' }
  ])
  await recordRunnerProjectPaths(db, 'r2', [
    { projectId: 'p-mirror', path: '/home/deploy/app', source: 'adopted' }
  ])

  const locations = await listProjectLocations(db, 'p-mirror')
  expect(locations.length).toBe(2)
  // The case one hub-side column could never express: the same project at two
  // different absolute paths, both correct, on two different machines.
  expect(locations.map((l) => l.path).sort()).toEqual(['/home/deploy/app', '/srv/work/app'])
  expect(locations.find((l) => l.runnerId === 'r1')!.source).toBe('provisioned')
  expect(locations.find((l) => l.runnerId === 'r2')!.source).toBe('adopted')
})

// The report IS the runner's complete state. Merging would leave a row for a
// project it no longer holds, which reverse lookup would then treat as fact.
test('a later report replaces that runner’s rows wholesale', async () => {
  await recordRunnerProjectPaths(db, 'r1', [
    { projectId: 'p-mirror', path: '/srv/work/app', source: 'provisioned' },
    { projectId: 'p-legacy', path: '/srv/work/other', source: 'adopted' }
  ])
  await recordRunnerProjectPaths(db, 'r1', [
    { projectId: 'p-mirror', path: '/srv/work/moved', source: 'provisioned' }
  ])

  const forMirror = await listProjectLocations(db, 'p-mirror')
  expect(forMirror.find((l) => l.runnerId === 'r1')!.path).toBe('/srv/work/moved')
  // The dropped project is gone from THIS runner, and untouched on the other.
  const forLegacy = await listProjectLocations(db, 'p-legacy')
  expect(forLegacy.filter((l) => l.runnerId === 'r1').length).toBe(0)
})

test('one runner’s report never disturbs another’s rows', async () => {
  const forMirror = await listProjectLocations(db, 'p-mirror')
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
    { projectId: 'p-mirror', path: '/legacy/root/nested', source: 'adopted' }
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
    { projectId: 'p-mirror', path: '/srv/keep', source: 'adopted' },
    { projectId: 'does-not-exist', path: '/srv/ghost', source: 'adopted' }
  ])
  const kept = await listProjectLocations(db, 'p-mirror')
  expect(kept.filter((l) => l.runnerId === 'r4').length).toBe(1)
  // The orphan is not reachable by reverse lookup either.
  expect(await resolveProjectByPath(db, '/srv/ghost/inside')).toBeNull()
  // Cleanup rides the LAST test: `test()` is fire-and-forget, so a top-level
  // `h.cleanup()` closes the database before any async body has run.
  h.cleanup()
})
