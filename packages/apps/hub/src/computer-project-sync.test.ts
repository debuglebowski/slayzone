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
  /** The task folders it holds (the hub keeps no task path, §9 7e). */
  taskFolders = new Map<string, string>()
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
  },
  async listTaskFolders(id, taskIds) {
    const c = computers.get(id)!
    if (c.offline) throw new Error('computer is not connected')
    return taskIds.flatMap((t) => (c.taskFolders.has(t) ? [c.taskFolders.get(t)!] : []))
  }
}

/** A task with a worktree the local computer holds. */
function taskWithWorktree(id: string, path: string): void {
  raw
    .prepare(
      `INSERT INTO tasks (id, project_id, title, has_worktree, computer_id, worktree_computer_id) VALUES (?, 'p1', 't', 1, ?, ?)`
    )
    .run(id, LOCAL, LOCAL)
  computers.get(LOCAL)!.taskFolders.set(id, path)
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

// Final review M6: the desktop ran git and automations on its own disk with no jail.
// Moved to the local computer, a custom worktree base outside the project's parent
// (`/Volumes/wt/{project-folder-name}`) and an automation's own folder (`/opt/tools`)
// were refused — functionality lost. They are registered as the local computer's
// roots, like project folders: on connect, and again when they change. The jail
// itself is unchanged, and a remote computer's roots are never touched.
function automationWithCwd(cwd: string): void {
  raw
    .prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
       VALUES (?, 'p1', 'a', 1, '{"type":"manual","params":{}}', '[]', ?, 0)`
    )
    .run(
      crypto.randomUUID(),
      JSON.stringify([{ type: 'run_command', params: { command: 'x', cwd } }])
    )
}

test('M6: a custom worktree base and an automation folder become local roots', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] }))
  upgraded('p1', '/Users/k/app')
  raw
    .prepare(`INSERT INTO settings (key, value) VALUES ('worktree_base_path', ?)`)
    .run('/Volumes/wt/{project-folder-name}')
  automationWithCwd('/opt/tools')
  automationWithCwd('{{project.path}}/sub') // a template: already the project's folder
  const { sync } = makeSync()

  await sync.onConnect(LOCAL)

  const roots = computers.get(LOCAL)!.roots
  expect(isCoveredByRoots('/Volumes/wt/app/feature', roots)).toBe(true)
  expect(isCoveredByRoots('/opt/tools', roots)).toBe(true)
  expect(isCoveredByRoots('/Volumes/other', roots)).toBe(false)
  expect(roots.some((r) => r.includes('{{'))).toBe(false)
})

test('M6: a later change is registered too, and never on a remote computer', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] }))
  computers.set(remote, new FakeComputer({ roots: ['/srv'] }))
  upgraded('p1', '/Users/k/app')
  const { sync } = makeSync()
  await sync.onConnect(LOCAL)
  await sync.onConnect(remote)

  automationWithCwd('/opt/later')
  await sync.localWorkFoldersChanged()

  expect(isCoveredByRoots('/opt/later', computers.get(LOCAL)!.roots)).toBe(true)
  expect(computers.get(remote)!.roots).toEqual(['/srv'])
})

// Final review round 2 (low, M6): roots registered for a worktree base or an
// automation's folder stayed when the setting or the automation went away. They
// are unregistered — only roots this sync added for work folders, never one the
// user added, and a project still under a removed root keeps its own root.
test('M6: a work-folder root goes away with its setting or automation', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k', '/srv/mine'], disk: ['/opt/x/app'] }))
  upgraded('p1', '/opt/x/app')
  raw
    .prepare(`INSERT INTO settings (key, value) VALUES ('worktree_base_path', ?)`)
    .run('/Volumes/wt/{project-folder-name}')
  automationWithCwd('/opt')
  automationWithCwd('/srv/mine/tool') // under a root the user added: nothing registered
  const { sync } = makeSync()
  await sync.onConnect(LOCAL)
  expect(isCoveredByRoots('/Volumes/wt/app', computers.get(LOCAL)!.roots)).toBe(true)
  expect(isCoveredByRoots('/opt/other', computers.get(LOCAL)!.roots)).toBe(true)

  raw.prepare(`DELETE FROM settings WHERE key = 'worktree_base_path'`).run()
  raw.prepare(`DELETE FROM automations`).run()
  await sync.localWorkFoldersChanged()

  const roots = computers.get(LOCAL)!.roots
  expect(isCoveredByRoots('/Volumes/wt/app', roots)).toBe(false)
  expect(isCoveredByRoots('/opt/other', roots)).toBe(false)
  expect(isCoveredByRoots('/opt/x/app', roots)).toBe(true) // the project keeps its root
  expect(roots).toContain('/Users/k')
  expect(roots).toContain('/srv/mine')
})

// Final review round 3, R3-1: changing the worktree base dropped the old base's root
// while task worktrees still lived there — their terminal, git panel and processes
// were refused. A root a local task's worktree still needs is never stale.
test('R3-1: changing the worktree base keeps the old base while a worktree lives there', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/opt/x/app'] }))
  upgraded('p1', '/opt/x/app')
  raw
    .prepare(`INSERT INTO settings (key, value) VALUES ('worktree_base_path', ?)`)
    .run('/Volumes/wt/{project-folder-name}')
  const { sync } = makeSync()
  await sync.onConnect(LOCAL)
  taskWithWorktree('t-r31', '/Volumes/wt/app/task-1')
  expect(isCoveredByRoots('/Volumes/wt/app/task-1', computers.get(LOCAL)!.roots)).toBe(true)

  raw
    .prepare(`UPDATE settings SET value = ? WHERE key = 'worktree_base_path'`)
    .run('/Volumes/wt2/{project-folder-name}')
  await sync.localWorkFoldersChanged()

  const roots = computers.get(LOCAL)!.roots
  expect(isCoveredByRoots('/Volumes/wt/app/task-1', roots)).toBe(true)
  expect(isCoveredByRoots('/Volumes/wt2/app', roots)).toBe(true)

  // Once the task is gone, nothing needs the old base: it goes.
  raw.prepare(`DELETE FROM tasks WHERE id = 't-r31'`).run()
  await sync.localWorkFoldersChanged()
  expect(isCoveredByRoots('/Volumes/wt/app/task-1', computers.get(LOCAL)!.roots)).toBe(false)
})

// Final review round 4, R4-1: a soft delete keeps the worktree on disk, and a
// restore only clears `deleted_at`. A sync in between (the next launch) released the
// old base's root, so the restored task was refused. A deleted task's folder counts
// while its row exists; the root goes only when the task is purged.
test('R4-1: a soft-deleted task restored after a relaunch keeps its worktree root', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/opt/x/app'] }))
  upgraded('p1', '/opt/x/app')
  raw
    .prepare(`INSERT INTO settings (key, value) VALUES ('worktree_base_path', ?)`)
    .run('/Volumes/wt/{project-folder-name}')
  const { sync } = makeSync()
  await sync.onConnect(LOCAL)
  taskWithWorktree('t-r41', '/Volumes/wt/app/task-1')
  raw
    .prepare(`UPDATE settings SET value = ? WHERE key = 'worktree_base_path'`)
    .run('/Volumes/wt2/{project-folder-name}')
  await sync.localWorkFoldersChanged()

  // Soft delete, relaunch (a new sync on connect), restore.
  raw.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 't-r41'`).run()
  const relaunched = makeSync().sync
  await relaunched.onConnect(LOCAL)
  raw.prepare(`UPDATE tasks SET deleted_at = NULL WHERE id = 't-r41'`).run()
  expect(isCoveredByRoots('/Volumes/wt/app/task-1', computers.get(LOCAL)!.roots)).toBe(true)

  // Purged: nothing needs the old base any more.
  raw.prepare(`DELETE FROM tasks WHERE id = 't-r41'`).run()
  await relaunched.localWorkFoldersChanged()
  expect(isCoveredByRoots('/Volumes/wt/app/task-1', computers.get(LOCAL)!.roots)).toBe(false)
})

function processWithCwd(
  id: string,
  cwd: string,
  owner: { taskId?: string; projectId?: string } = {}
): void {
  raw
    .prepare(
      `INSERT INTO processes (id, task_id, project_id, label, command, cwd, auto_restart)
       VALUES (?, ?, ?, 'p', 'x', ?, 1)`
    )
    .run(id, owner.taskId ?? null, owner.projectId ?? null, cwd)
}

// v0.38.0 moved background processes onto the computer, whose jail refused a cwd
// outside its roots: a process the user had set up in `/tmp`, `/opt/x` or on an
// external drive — which ran in v0.38 — failed on every start. Its folder is a work
// folder of the local computer like an automation's, and goes with the process.
test('a background process folder becomes a local root, and goes with the process', async () => {
  computers.set(LOCAL, new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/app'] }))
  computers.set(remote, new FakeComputer({ roots: ['/srv'] }))
  upgraded('p1', '/Users/k/app')
  project('p-remote', null, remote)
  raw
    .prepare(`INSERT INTO tasks (id, project_id, title, computer_id) VALUES ('t-r', 'p1', 't', ?)`)
    .run(remote)
  raw.prepare(`INSERT INTO tasks (id, project_id, title) VALUES ('t-l', 'p1', 't')`).run()
  processWithCwd('plain', '/Volumes/X/svc')
  processWithCwd('task-local', '/opt/x', { taskId: 't-l', projectId: 'p1' })
  // A project process sends no cwd (its computer resolves the project's folder).
  processWithCwd('proj-local', '/opt/unused', { projectId: 'p1' })
  // Another computer's paths: never a root here.
  processWithCwd('task-remote', '/srv/elsewhere', { taskId: 't-r', projectId: 'p1' })
  // A task on no computer of its own, in a project another computer serves.
  raw.prepare(`INSERT INTO tasks (id, project_id, title) VALUES ('t-pr', 'p-remote', 't')`).run()
  processWithCwd('proj-remote', '/srv/remote-plain', { taskId: 't-pr', projectId: 'p-remote' })
  processWithCwd('relative', 'some/dir')
  const { sync } = makeSync()

  await sync.onConnect(LOCAL)

  let roots = computers.get(LOCAL)!.roots
  expect(isCoveredByRoots('/Volumes/X/svc', roots)).toBe(true)
  expect(isCoveredByRoots('/opt/x', roots)).toBe(true)
  expect(isCoveredByRoots('/srv/elsewhere', roots)).toBe(false)
  expect(isCoveredByRoots('/srv/remote-plain', roots)).toBe(false)
  expect(isCoveredByRoots('/opt/unused', roots)).toBe(false)
  expect(roots.some((r) => r.includes('some/dir'))).toBe(false)

  // Created later: registered on the next change, not only on connect.
  processWithCwd('later', '/opt/later')
  await sync.localWorkFoldersChanged()
  expect(isCoveredByRoots('/opt/later', computers.get(LOCAL)!.roots)).toBe(true)

  // Removed: its root goes; the user's own root stays.
  raw.prepare(`DELETE FROM processes`).run()
  await sync.localWorkFoldersChanged()
  roots = computers.get(LOCAL)!.roots
  expect(isCoveredByRoots('/Volumes/X/svc', roots)).toBe(false)
  expect(isCoveredByRoots('/opt/later', roots)).toBe(false)
  expect(roots).toContain('/Users/k')
  expect(computers.get(remote)!.roots).toEqual(['/srv'])
})

test('one project whose folder cannot be recorded does not stop delivery to the others', async () => {
  const local = new FakeComputer({ roots: ['/Users/k'], disk: ['/Users/k/a', '/Users/k/b'] })
  computers.set(LOCAL, local)
  project('p-bad', null)
  project('p-good', null)
  for (const [projectId, path] of [
    ['p-bad', '/Users/k/a'],
    ['p-good', '/Users/k/b']
  ])
    await setPlacement(db, { computerId: LOCAL, projectId, path, status: 'pending' })
  // A damaged row: recording its delivery fails.
  raw.exec(`CREATE TRIGGER broken BEFORE UPDATE ON project_placements
    WHEN NEW.project_id = 'p-bad' AND NEW.status = 'ready'
    BEGIN SELECT RAISE(ABORT, 'disk image row damaged'); END`)
  const errors = console.error
  console.error = () => undefined
  try {
    await makeSync().sync.onConnect(LOCAL)
  } finally {
    console.error = errors
  }
  expect((await row('p-good', LOCAL))!.status).toBe('ready')
  expect((await row('p-bad', LOCAL))!.status).toBe('pending')
  expect(raw.prepare("SELECT pass,item_key FROM item_faults WHERE origin='hub'").all()).toEqual([
    { pass: 'hub-project-sync', item_key: 'p-bad' }
  ])
})
