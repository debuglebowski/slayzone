/**
 * The hub's copy of where each computer keeps each project (`project_placements`).
 *
 * What matters here:
 *  - a computer's report is its complete state and wins over the hub's own rows;
 *  - the hub's own rows (`pending` / `missing` / `refused`) survive a report that
 *    does not mention them;
 *  - every write is an upsert, so no combination of report + hub write can hit
 *    the (computer_id, project_id) primary key;
 *  - nothing is written for a project or computer that no longer exists;
 *  - reverse lookup trusts only folders an agent could use, and still answers from
 *    the legacy `projects.path` column during the upgrade window.
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { deterministicLocalComputerId, registerComputer, registerOrReplaceComputer } from './store'
import {
  deletePlacement,
  deleteProjectPlacements,
  getPlacement,
  listPlacements,
  localProjectRoot,
  recordedProjectRoot,
  recordComputerProjectPaths,
  resolveProjectByPath,
  setPlacement
} from './project-paths'
import { createMigratedDb, type TestDb } from './test-db'

let t: TestDb
let r1: string
let r2: string

beforeEach(async () => {
  t = createMigratedDb()
  const mk = (name: string) =>
    registerComputer(t.db, { name, platform: 'darwin-arm64', version: '1', capabilities: {} })
  r1 = (await mk('mac')).id
  r2 = (await mk('linux')).id
  makeProject('p-legacy', 'Legacy', '/legacy/root')
  makeProject('p-mirror', 'Mirrored', null)
})

afterEach(() => t.close())

function makeProject(id: string, name: string, path: string | null): void {
  t.raw
    .prepare(`INSERT INTO projects (id, name, color, path, sort_order) VALUES (?, ?, '#fff', ?, 0)`)
    .run(id, name, path)
}

const rows = (projectId: string) => listPlacements(t.db, [projectId])

test('records what a computer reports, one row per machine', async () => {
  await recordComputerProjectPaths(t.db, r1, [{ projectId: 'p-mirror', path: '/srv/work/app' }])
  await recordComputerProjectPaths(t.db, r2, [{ projectId: 'p-mirror', path: '/home/deploy/app' }])
  // The case one hub-side column could never express: the same project at two
  // different absolute paths, both correct, on two different machines.
  expect((await rows('p-mirror')).map((r) => [r.path, r.status]).sort()).toEqual([
    ['/home/deploy/app', 'ready'],
    ['/srv/work/app', 'ready']
  ])
})

test('a later report drops ready rows the computer no longer holds, and only that computer’s', async () => {
  await recordComputerProjectPaths(t.db, r1, [
    { projectId: 'p-mirror', path: '/srv/work/app' },
    { projectId: 'p-legacy', path: '/srv/work/other' }
  ])
  await recordComputerProjectPaths(t.db, r2, [{ projectId: 'p-legacy', path: '/home/x' }])
  await recordComputerProjectPaths(t.db, r1, [{ projectId: 'p-mirror', path: '/srv/work/moved' }])

  expect((await getPlacement(t.db, 'p-mirror', r1))!.path).toBe('/srv/work/moved')
  expect(await getPlacement(t.db, 'p-legacy', r1)).toBeNull()
  expect((await getPlacement(t.db, 'p-legacy', r2))!.path).toBe('/home/x')
})

test('an empty report drops every ready row of that computer', async () => {
  await recordComputerProjectPaths(t.db, r1, [{ projectId: 'p-mirror', path: '/a' }])
  await recordComputerProjectPaths(t.db, r1, [])
  expect(await rows('p-mirror')).toEqual([])
})

// The hub's own rows are not part of what a computer reports. A pending folder
// waiting for delivery must survive the refresh that runs on every connect.
test('a report keeps the hub’s pending, missing and refused rows', async () => {
  await setPlacement(t.db, { computerId: r1, projectId: 'p-mirror', path: '/p', status: 'pending' })
  await setPlacement(t.db, { computerId: r1, projectId: 'p-legacy', path: '/m', status: 'missing' })
  await setPlacement(t.db, { computerId: r2, projectId: 'p-legacy', path: '/r', status: 'refused' })
  await recordComputerProjectPaths(t.db, r1, [])
  await recordComputerProjectPaths(t.db, r2, [])
  expect((await getPlacement(t.db, 'p-mirror', r1))!.status).toBe('pending')
  expect((await getPlacement(t.db, 'p-legacy', r1))!.status).toBe('missing')
  expect((await getPlacement(t.db, 'p-legacy', r2))!.status).toBe('refused')
})

// The report is the computer's own state, so it wins — and an upsert means the
// primary key can never fail the whole report.
test('a report overrides a missing or refused row for the same project without a key conflict', async () => {
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-mirror',
    path: '/old',
    status: 'refused'
  })
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-legacy',
    path: '/gone',
    status: 'missing'
  })
  await recordComputerProjectPaths(t.db, r1, [
    { projectId: 'p-mirror', path: '/confirmed' },
    { projectId: 'p-legacy', path: '/repointed' }
  ])
  expect(await getPlacement(t.db, 'p-mirror', r1)).toMatchObject({
    path: '/confirmed',
    status: 'ready'
  })
  expect(await getPlacement(t.db, 'p-legacy', r1)).toMatchObject({
    path: '/repointed',
    status: 'ready'
  })
})

test('setPlacement replaces the row for the same pair', async () => {
  await setPlacement(t.db, { computerId: r1, projectId: 'p-mirror', path: '/a', status: 'pending' })
  await setPlacement(t.db, { computerId: r1, projectId: 'p-mirror', path: '/b', status: 'ready' })
  expect(await rows('p-mirror')).toEqual([
    { computer_id: r1, project_id: 'p-mirror', path: '/b', status: 'ready' }
  ])
})

// No foreign keys on this table: without the existence guard, a write racing a
// project or computer delete would resurrect a row for something that is gone.
test('nothing is written for an unknown project or computer', async () => {
  expect(
    await setPlacement(t.db, { computerId: r1, projectId: 'nope', path: '/x', status: 'ready' })
  ).toBe(false)
  expect(
    await setPlacement(t.db, {
      computerId: 'gone',
      projectId: 'p-mirror',
      path: '/x',
      status: 'ready'
    })
  ).toBe(false)
  await recordComputerProjectPaths(t.db, r1, [
    { projectId: 'p-mirror', path: '/keep' },
    { projectId: 'does-not-exist', path: '/ghost' }
  ])
  await recordComputerProjectPaths(t.db, 'gone', [{ projectId: 'p-mirror', path: '/ghost' }])
  expect(await listPlacements(t.db)).toEqual([
    { computer_id: r1, project_id: 'p-mirror', path: '/keep', status: 'ready' }
  ])
})

test('recordedProjectRoot returns only a folder an agent could use', async () => {
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-mirror',
    path: '/ready',
    status: 'ready'
  })
  await setPlacement(t.db, {
    computerId: r2,
    projectId: 'p-mirror',
    path: '/pend',
    status: 'pending'
  })
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-legacy',
    path: '/miss',
    status: 'missing'
  })
  await setPlacement(t.db, {
    computerId: r2,
    projectId: 'p-legacy',
    path: '/ref',
    status: 'refused'
  })
  expect(await recordedProjectRoot(t.db, 'p-mirror', r1)).toBe('/ready')
  expect(await recordedProjectRoot(t.db, 'p-mirror', r2)).toBe('/pend')
  expect(await recordedProjectRoot(t.db, 'p-legacy', r1)).toBeNull()
  expect(await recordedProjectRoot(t.db, 'p-legacy', r2)).toBeNull()
  expect(await recordedProjectRoot(t.db, 'p-mirror', 'unknown')).toBeNull()
})

test('deletePlacement and deleteProjectPlacements remove exactly their rows', async () => {
  await setPlacement(t.db, { computerId: r1, projectId: 'p-mirror', path: '/a', status: 'ready' })
  await setPlacement(t.db, { computerId: r2, projectId: 'p-mirror', path: '/b', status: 'ready' })
  await setPlacement(t.db, { computerId: r1, projectId: 'p-legacy', path: '/c', status: 'ready' })
  await deletePlacement(t.db, r1, 'p-mirror')
  expect((await rows('p-mirror')).map((r) => r.computer_id)).toEqual([r2])
  await deleteProjectPlacements(t.db, 'p-mirror')
  expect(await rows('p-mirror')).toEqual([])
  expect(await rows('p-legacy')).toHaveLength(1)
})

test('reverse lookup finds a project through the hub copy', async () => {
  await recordComputerProjectPaths(t.db, r1, [{ projectId: 'p-mirror', path: '/srv/work/moved' }])
  const hit = await resolveProjectByPath(t.db, '/srv/work/moved/src/deep')
  expect(hit).toMatchObject({ id: 'p-mirror', path: '/srv/work/moved' })
})

test('reverse lookup trusts a pending folder but not a missing or refused one', async () => {
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-mirror',
    path: '/pend',
    status: 'pending'
  })
  await setPlacement(t.db, {
    computerId: r2,
    projectId: 'p-mirror',
    path: '/gone',
    status: 'missing'
  })
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-legacy',
    path: '/ref',
    status: 'refused'
  })
  expect((await resolveProjectByPath(t.db, '/pend/x'))!.id).toBe('p-mirror')
  expect(await resolveProjectByPath(t.db, '/gone/x')).toBeNull()
  expect(await resolveProjectByPath(t.db, '/ref/x')).toBeNull()
})

// Without this the boot right after upgrade breaks `slay`: the copy is empty
// until the local computer connects, and every project would 404 in between.
test('reverse lookup still answers from the legacy column', async () => {
  expect((await resolveProjectByPath(t.db, '/legacy/root/pkg'))!.id).toBe('p-legacy')
})

test('reverse lookup picks the deepest match across both sources', async () => {
  await recordComputerProjectPaths(t.db, r2, [
    { projectId: 'p-mirror', path: '/legacy/root/nested' }
  ])
  expect((await resolveProjectByPath(t.db, '/legacy/root/nested/thing'))!.id).toBe('p-mirror')
})

test('reverse lookup returns null for an unrelated directory', async () => {
  expect(await resolveProjectByPath(t.db, '/tmp/nowhere')).toBeNull()
})

test('localProjectRoot reads only the local computer’s folder', async () => {
  const local = deterministicLocalComputerId('local-computer')
  await registerOrReplaceComputer(t.db, {
    id: local,
    name: 'local-computer',
    platform: 'p',
    version: 'v'
  })
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-mirror',
    path: '/remote',
    status: 'ready'
  })
  expect(await localProjectRoot(t.db, 'p-mirror')).toBeNull()
  await setPlacement(t.db, {
    computerId: local,
    projectId: 'p-mirror',
    path: '/here',
    status: 'pending'
  })
  expect(await localProjectRoot(t.db, 'p-mirror')).toBe('/here')
})

// An empty legacy path is a prefix of every absolute directory: it must never match.
test('an empty legacy path matches nothing', async () => {
  makeProject('p-empty', 'Empty', '')
  expect(await resolveProjectByPath(t.db, '/some/unrelated/dir')).toBeNull()
})

// Not yet delivered, so newer than anything the computer can report.
test('a report never overrides a pending or forgotten row', async () => {
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-mirror',
    path: '/new',
    status: 'pending'
  })
  await setPlacement(t.db, {
    computerId: r1,
    projectId: 'p-legacy',
    path: '/x',
    status: 'forgotten'
  })
  await recordComputerProjectPaths(t.db, r1, [
    { projectId: 'p-mirror', path: '/old' },
    { projectId: 'p-legacy', path: '/x' }
  ])
  expect(await getPlacement(t.db, 'p-mirror', r1)).toMatchObject({
    path: '/new',
    status: 'pending'
  })
  expect(await getPlacement(t.db, 'p-legacy', r1)).toMatchObject({ status: 'forgotten' })
})
