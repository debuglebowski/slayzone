/**
 * The connect sequence and user folder changes that keep the hub's copy of project
 * folders and each computer's own record in step.
 *
 * Against a real migrated DB and a fake computer that enforces allowed roots the
 * way a real one does (any path outside them is refused, existence checks included).
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { migrations, runMigrations } from '@slayzone/db-migrations'
import {
  deterministicLocalComputerId,
  getPlacement,
  listPlacements,
  registerComputer,
  registerOrReplaceComputer,
  setPlacement
} from '@slayzone/computers/server'
import { ComputerTransportErrorCodes, RpcError } from '@slayzone/computer-transport/shared'
import { createComputerProjectSync, type ComputerFolderOps } from './computer-project-sync'
import { isCoveredByRoots } from './local-computer-roots'

const LOCAL = deterministicLocalComputerId('local-computer')

let raw: Database.Database
let db: SlayzoneDb
let remote: string

beforeEach(async () => {
  raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  db = createSlayzoneDbAdapter(raw)
  await registerOrReplaceComputer(db, {
    id: LOCAL,
    name: 'local-computer',
    platform: 'darwin-arm64',
    version: '1'
  })
  remote = (await registerComputer(db, { name: 'laptop', platform: 'linux', version: '1' })).id
})

afterEach(() => raw.close())

function project(
  id: string,
  path: string | null = null,
  defaultComputer: string | null = null
): void {
  raw
    .prepare(
      `INSERT INTO projects (id, name, color, path, default_computer_id, sort_order) VALUES (?, ?, '#fff', ?, ?, 0)`
    )
    .run(id, id, path, defaultComputer)
}

/**
 * A project from before folders moved to computers: its `projects.path`, turned by
 * the real upgrade (migration v176) into a pending folder on the local computer.
 */
const v176 = migrations.find((m) => m.version === 176)!
function upgraded(id: string, path: string, defaultComputer: string | null = null): void {
  project(id, path, defaultComputer)
  v176.up(raw)
}

const refused = (path: string) =>
  new RpcError(ComputerTransportErrorCodes.refusedByComputer, `'${path}' is outside allowed roots`)

/** One computer: allowed roots, what is on its disk, and its own folder record. */
class FakeComputer {
  roots: string[]
  disk: Set<string>
  map = new Map<string, string>()
  /** Make every call fail like a dropped connection. */
  offline = false
  /** How long `listProjectPaths` takes to answer, to expose interleaving. */
  reportDelayMs = 0
  constructor(opts: { roots: string[]; disk?: string[] }) {
    this.roots = opts.roots
    this.disk = new Set(opts.disk ?? [])
  }
  /** Refuse like a real computer: offline, or a path outside its allowed roots. */
  check(path: string): void {
    if (this.offline) throw new Error('computer is not connected')
    if (!isCoveredByRoots(path, this.roots)) throw refused(path)
  }
}

const computers = new Map<string, FakeComputer>()

const ops: ComputerFolderOps = {
  async listRoots(id) {
    const c = computers.get(id)!
    if (c.offline) throw new Error('computer is not connected')
    return { roots: c.roots }
  },
  async setAllowedRoots(id, roots) {
    computers.get(id)!.roots = roots
  },
  async pathExists(id, path) {
    const c = computers.get(id)!
    c.check(path)
    return c.disk.has(path)
  },
  async setProjectPath(id, projectId, path) {
    const c = computers.get(id)!
    c.check(path)
    c.map.set(projectId, path)
    return { path }
  },
  async forgetProjectPath(id, projectId) {
    const c = computers.get(id)!
    if (c.offline) throw new Error('computer is not connected')
    c.map.delete(projectId)
  },
  async listProjectPaths(id) {
    const c = computers.get(id)!
    if (c.offline) throw new Error('computer is not connected')
    const snapshot = [...c.map].map(([projectId, path]) => ({ projectId, path }))
    if (c.reportDelayMs) await new Promise((r) => setTimeout(r, c.reportDelayMs))
    return snapshot
  }
}

function makeSync(served: (computerId: string, projectId: string) => boolean = () => true) {
  let changes = 0
  const sync = createComputerProjectSync({
    db,
    ops,
    localComputerId: LOCAL,
    servedProjects: async (computerId, ids) => ids.filter((id) => served(computerId, id)),
    onChanged: () => {
      changes++
    },
    record: () => undefined
  })
  return { sync, changes: () => changes }
}

const row = (projectId: string, computerId: string) => getPlacement(db, projectId, computerId)
const defaultOf = (projectId: string) =>
  (
    raw.prepare(`SELECT default_computer_id AS d FROM projects WHERE id = ?`).get(projectId) as {
      d: string | null
    }
  ).d

beforeEach(() => {
  computers.clear()
})

test('local computer: an upgraded project’s folder becomes ready on connect, and the computer its default', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] }))
  upgraded('p1', '/Users/k/app')
  const { sync, changes } = makeSync()

  await sync.onConnect(LOCAL)

  expect(await row('p1', LOCAL)).toMatchObject({ path: '/Users/k/app', status: 'ready' })
  expect(computers.get(LOCAL)!.map.get('p1')).toBe('/Users/k/app')
  expect(defaultOf('p1')).toBe(LOCAL)
  expect(changes()).toBe(1)
})

// The desktop app had no jail before folders went through the local computer. A
// folder outside $HOME must be allowed BEFORE delivery, or it is refused for good.
test('local computer: roots are widened before delivery, so a folder outside home works', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/Volumes/ext/app'] }))
  upgraded('p1', '/Volumes/ext/app')
  const { sync } = makeSync()

  await sync.onConnect(LOCAL)

  expect(computers.get(LOCAL)!.roots).toContain('/Volumes/ext')
  expect((await row('p1', LOCAL))!.status).toBe('ready')
})

test('a folder that is not on the computer is recorded as missing, and heals once it appears', async () => {
  const local = new FakeComputer({ roots: ['/Users/k'] })
  computers.set(LOCAL, local)
  upgraded('p1', '/Users/k/gone')
  const { sync } = makeSync()

  await sync.onConnect(LOCAL)
  expect((await row('p1', LOCAL))!.status).toBe('missing')

  local.disk.add('/Users/k/gone')
  await sync.onConnect(LOCAL)
  expect((await row('p1', LOCAL))!.status).toBe('ready')
})

// A computer that cannot answer has not said no. Marking the folder broken would
// strand it until the user re-picks a folder that was fine all along.
test('a failed delivery leaves the row pending for the next connect', async () => {
  const local = new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] })
  computers.set(LOCAL, local)
  project('p1', null)
  await setPlacement(db, {
    computerId: LOCAL,
    projectId: 'p1',
    path: '/Users/k/app',
    status: 'pending'
  })
  const { sync } = makeSync()

  local.offline = true
  await sync.onConnect(LOCAL)
  expect((await row('p1', LOCAL))!.status).toBe('pending')

  local.offline = false
  await sync.onConnect(LOCAL)
  expect((await row('p1', LOCAL))!.status).toBe('ready')
})

test('remote computer: a pending folder outside its roots is refused, and its roots are never touched', async () => {
  computers.set(remote, new FakeComputer({ roots: ['/home/u'], disk: ['/srv/app'] }))
  project('p1')
  await setPlacement(db, {
    computerId: remote,
    projectId: 'p1',
    path: '/srv/app',
    status: 'pending'
  })
  const { sync } = makeSync()

  await sync.onConnect(remote)

  expect((await row('p1', remote))!.status).toBe('refused')
  expect(computers.get(remote)!.roots).toEqual(['/home/u'])
})

test('remote computer: upgraded hub paths are never handed to it', async () => {
  computers.set(remote, new FakeComputer({ roots: ['/'], disk: ['/Users/k/app'] }))
  upgraded('p1', '/Users/k/app')
  const { sync } = makeSync()

  await sync.onConnect(remote)

  expect(await row('p1', remote)).toBeNull()
  expect(computers.get(remote)!.map.size).toBe(0)
})

// T-19: a computer only ever learns its owner's projects.
test('a project the computer does not serve is neither delivered nor recorded from its report', async () => {
  const local = new FakeComputer({
    roots: ['/Users/k'],
    disk: ['/Users/k/mine', '/Users/k/theirs', '/Users/k/reported']
  })
  local.map.set('reported', '/Users/k/reported')
  computers.set(LOCAL, local)
  upgraded('mine', '/Users/k/mine')
  upgraded('theirs', '/Users/k/theirs')
  project('reported')
  const { sync } = makeSync((_c, id) => id === 'mine')

  await sync.onConnect(LOCAL)

  expect((await row('mine', LOCAL))!.status).toBe('ready')
  // The migration could not know owners; delivery does.
  expect(local.map.has('theirs')).toBe(false)
  expect((await row('theirs', LOCAL))!.status).toBe('pending')
  expect(await row('reported', LOCAL)).toBeNull()
})

test('an explicit default computer is never overwritten by the backfill', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] }))
  upgraded('p1', '/Users/k/app', remote)
  const { sync } = makeSync()

  await sync.onConnect(LOCAL)

  expect(defaultOf('p1')).toBe(remote)
})

test('a connect that changes nothing does not notify', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] }))
  upgraded('p1', '/Users/k/app')
  const { sync, changes } = makeSync()

  await sync.onConnect(LOCAL)
  await sync.onConnect(LOCAL)

  expect(changes()).toBe(1)
})

// The race the lock removes: a refresh whose report was taken BEFORE a folder was
// set must not land AFTER it and delete the folder again.
test('a folder set while a connect is in flight survives it', async () => {
  const local = new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] })
  local.reportDelayMs = 30
  computers.set(LOCAL, local)
  project('p1')
  const { sync } = makeSync()

  await Promise.all([sync.onConnect(LOCAL), sync.setFolder(LOCAL, 'p1', '/Users/k/app')])

  expect(await row('p1', LOCAL)).toMatchObject({ path: '/Users/k/app', status: 'ready' })
})

test('setFolder: recorded on the computer → ready', async () => {
  computers.set(remote, new FakeComputer({ roots: ['/home/u'], disk: ['/home/u/app'] }))
  project('p1')
  const { sync } = makeSync()

  expect(await sync.setFolder(remote, 'p1', '/home/u/app')).toEqual({
    path: '/home/u/app',
    status: 'ready'
  })
  expect(computers.get(remote)!.map.get('p1')).toBe('/home/u/app')
})

test('setFolder: a folder that does not exist is kept as missing, like before', async () => {
  computers.set(remote, new FakeComputer({ roots: ['/home/u'] }))
  project('p1')
  const { sync } = makeSync()

  expect((await sync.setFolder(remote, 'p1', '/home/u/nope')).status).toBe('missing')
})

test('setFolder: an offline computer gets the folder as pending', async () => {
  const c = new FakeComputer({ roots: ['/home/u'], disk: ['/home/u/app'] })
  c.offline = true
  computers.set(remote, c)
  project('p1')
  const { sync } = makeSync()

  expect((await sync.setFolder(remote, 'p1', '/home/u/app')).status).toBe('pending')
})

test('setFolder: a refused folder throws and leaves the current folder alone', async () => {
  computers.set(remote, new FakeComputer({ roots: ['/home/u'], disk: ['/home/u/app', '/etc/x'] }))
  project('p1')
  const { sync } = makeSync()
  await sync.setFolder(remote, 'p1', '/home/u/app')

  await expect(sync.setFolder(remote, 'p1', '/etc/x')).rejects.toThrow(/outside/)
  expect(await row('p1', remote)).toMatchObject({ path: '/home/u/app', status: 'ready' })
})

test('forgetFolder drops the folder on the computer and in the copy', async () => {
  computers.set(remote, new FakeComputer({ roots: ['/home/u'], disk: ['/home/u/app'] }))
  project('p1')
  const { sync } = makeSync()
  await sync.setFolder(remote, 'p1', '/home/u/app')

  await sync.forgetFolder(remote, 'p1')

  expect(computers.get(remote)!.map.size).toBe(0)
  expect(await listPlacements(db, ['p1'])).toEqual([])
})

// A folder chosen while the computer was offline is the user's latest choice: the
// computer's report of its old folder must not replace it before it is delivered.
test('a folder chosen while the computer was offline survives the reconnect and is delivered', async () => {
  const c = new FakeComputer({ roots: ['/home/u'], disk: ['/home/u/old', '/home/u/new'] })
  c.map.set('p1', '/home/u/old')
  computers.set(remote, c)
  project('p1')
  const { sync } = makeSync()

  c.offline = true
  expect((await sync.setFolder(remote, 'p1', '/home/u/new')).status).toBe('pending')
  c.offline = false
  await sync.onConnect(remote)

  expect(await row('p1', remote)).toMatchObject({ path: '/home/u/new', status: 'ready' })
  expect(c.map.get('p1')).toBe('/home/u/new')
})

// Recorded as missing, the computer must not keep starting agents in its old folder.
test('choosing a folder that is not there also drops the computer’s old one', async () => {
  const c = new FakeComputer({ roots: ['/home/u'], disk: ['/home/u/old'] })
  c.map.set('p1', '/home/u/old')
  computers.set(remote, c)
  project('p1')
  const { sync } = makeSync()

  expect((await sync.setFolder(remote, 'p1', '/home/u/nope')).status).toBe('missing')
  expect(c.map.has('p1')).toBe(false)
})

// Clearing a folder must not depend on its computer being reachable — and must
// not fail the rest of a settings save.
test('a folder cleared while its computer is offline is forgotten there on reconnect', async () => {
  const c = new FakeComputer({ roots: ['/home/u'], disk: ['/home/u/app'] })
  computers.set(remote, c)
  project('p1')
  const { sync } = makeSync()
  await sync.setFolder(remote, 'p1', '/home/u/app')

  c.offline = true
  await sync.forgetFolder(remote, 'p1')
  expect((await row('p1', remote))!.status).toBe('forgotten')

  c.offline = false
  await sync.onConnect(remote)
  expect(c.map.has('p1')).toBe(false)
  expect(await row('p1', remote)).toBeNull()
})
