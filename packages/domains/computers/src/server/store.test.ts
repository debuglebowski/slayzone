import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComputerRecord } from '../shared/types'
import {
  deterministicLocalComputerId,
  getComputer,
  listComputers,
  registerOrReplaceComputer,
  registerComputer,
  resolveTaskComputerId,
  resolveTaskComputerIdOrDefault,
  retireStaleLocalComputers,
  revokeComputer,
  setProjectDefaultComputer,
  setTaskComputer,
  touchComputerLastSeen,
  unrevokeComputer,
  deleteComputer,
  replaceComputer,
  setComputerDisabled,
  listDisabledComputerIds,
  setComputerRemovedListener,
  assertTaskMovable,
  TaskFoldersElsewhereError,
  computerStanding
} from './store'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '../shared'
import { listPlacements, setPlacement } from './project-paths'
import { createMigratedDb, seedProjectAndTask, type TestDb } from './test-db'

let t: TestDb

beforeEach(() => {
  t = createMigratedDb()
})

afterEach(() => {
  t.close()
})

function mkComputer(over: { name?: string; now?: number } = {}) {
  return registerComputer(t.db, {
    name: over.name ?? 'mac-studio',
    platform: 'darwin-arm64',
    version: '0.35.0',
    capabilities: { modes: ['claude-code'] },
    now: over.now ?? 1000
  })
}

describe('computer CRUD', () => {
  it('registerComputer persists and getComputer round-trips', async () => {
    const r = await mkComputer()
    const row = await getComputer(t.db, r.id)
    expect(row).not.toBeNull()
    expect(row!.name).toBe('mac-studio')
    expect(row!.platform).toBe('darwin-arm64')
    expect(row!.version).toBe('0.35.0')
    expect(JSON.parse(row!.capabilities_json)).toEqual({ modes: ['claude-code'] })
    expect(row!.auth_key_id).toBeNull()
    expect(row!.created_at).toBe(1000)
    expect(row!.last_seen_at).toBe(1000)
    expect(row!.revoked_at).toBeNull()
  })

  it('getComputer returns null for unknown id', async () => {
    expect(await getComputer(t.db, 'nope')).toBeNull()
  })

  it('listComputers excludes revoked by default, includes with flag', async () => {
    const a = await mkComputer({ name: 'a', now: 1 })
    const b = await mkComputer({ name: 'b', now: 2 })
    await revokeComputer(t.db, a.id, 50)

    const active = await listComputers(t.db)
    expect(active.map((r: ComputerRecord) => r.id)).toEqual([b.id])

    const all = await listComputers(t.db, { includeRevoked: true })
    expect(all.map((r: ComputerRecord) => r.id)).toEqual([a.id, b.id])
  })

  it('touchComputerLastSeen advances but never rewinds', async () => {
    const r = await mkComputer({ now: 1000 })
    await touchComputerLastSeen(t.db, r.id, 2000)
    expect((await getComputer(t.db, r.id))!.last_seen_at).toBe(2000)
    await touchComputerLastSeen(t.db, r.id, 1500)
    expect((await getComputer(t.db, r.id))!.last_seen_at).toBe(2000)
  })

  it('revokeComputer is idempotent — first revocation time wins', async () => {
    const r = await mkComputer()
    await revokeComputer(t.db, r.id, 5000)
    await revokeComputer(t.db, r.id, 9000)
    expect((await getComputer(t.db, r.id))!.revoked_at).toBe(5000)
  })
})

describe('local-computer dedup (Wave3.5-D5)', () => {
  it('deterministicLocalComputerId is stable for a name and uuid-shaped', () => {
    const a = deterministicLocalComputerId('local-computer')
    const b = deterministicLocalComputerId('local-computer')
    expect(a).toBe(b) // same name ⇒ same id (idempotent enroll key)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // A different name ⇒ a different id (no accidental collision).
    expect(deterministicLocalComputerId('other-computer')).not.toBe(a)
  })

  it('registerOrReplaceComputer UPSERTs onto one row (no orphan per enroll)', async () => {
    const id = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id,
      name: 'local-computer',
      platform: 'darwin-arm64',
      version: '0.35.0',
      capabilities: { modes: ['claude-code'] },
      authKeyId: 'key-1',
      now: 1000
    })
    // Second enroll (a relaunch) with the SAME deterministic id: refresh identity
    // + auth, preserve created_at, stay a single row.
    await registerOrReplaceComputer(t.db, {
      id,
      name: 'local-computer',
      platform: 'darwin-arm64',
      version: '0.36.0',
      capabilities: { modes: ['codex'] },
      authKeyId: 'key-2',
      now: 2000
    })

    const rows = await listComputers(t.db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].version).toBe('0.36.0') // refreshed
    expect(rows[0].auth_key_id).toBe('key-2') // refreshed
    expect(rows[0].created_at).toBe(1000) // original birth preserved
    expect(rows[0].last_seen_at).toBe(2000) // heartbeat advanced
  })

  it('registerOrReplaceComputer un-revokes on re-enroll (operator asked it back)', async () => {
    const id = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 1000
    })
    await revokeComputer(t.db, id, 1500)
    expect((await getComputer(t.db, id))!.revoked_at).toBe(1500)
    await registerOrReplaceComputer(t.db, {
      id,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 2000
    })
    expect((await getComputer(t.db, id))!.revoked_at).toBeNull()
  })

  it('retireStaleLocalComputers collapses historical duplicate local rows to one', async () => {
    // Simulate the pre-fix state: three random-id rows all named 'local-computer'
    // (one accumulated per relaunch) plus a legitimate REMOTE computer.
    const keep = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id: keep,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 3
    })
    await registerComputer(t.db, { name: 'local-computer', platform: 'p', version: 'v', now: 1 })
    await registerComputer(t.db, { name: 'local-computer', platform: 'p', version: 'v', now: 2 })
    const remote = await registerComputer(t.db, {
      name: 'mac-studio-remote',
      platform: 'p',
      version: 'v',
      now: 4
    })

    const removed = await retireStaleLocalComputers(t.db, {
      name: 'local-computer',
      keepComputerId: keep
    })
    expect(removed).toBe(2) // the two orphaned random-id local rows

    const rows = await listComputers(t.db)
    const localRows = rows.filter((r) => r.name === 'local-computer')
    expect(localRows).toHaveLength(1)
    expect(localRows[0].id).toBe(keep)
    // The remote computer is UNTOUCHED — dedup is scoped to the local name only.
    expect(rows.find((r) => r.id === remote.id)).toBeTruthy()
  })

  it('retireStaleLocalComputers NEVER touches a disconnected remote computer (identity-only)', async () => {
    const keep = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id: keep,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 1
    })
    // A remote computer (different name) — represents a sleeping laptop, no live
    // connection. It must survive: dedup matches by name, never by status.
    const sleeping = await registerComputer(t.db, {
      name: 'colleague-laptop',
      platform: 'p',
      version: 'v',
      now: 2
    })

    const removed = await retireStaleLocalComputers(t.db, {
      name: 'local-computer',
      keepComputerId: keep
    })
    expect(removed).toBe(0) // nothing else shares the local name
    expect(await getComputer(t.db, sleeping.id)).not.toBeNull()
  })

  it('retireStaleLocalComputers is idempotent — a second call is a no-op', async () => {
    const keep = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id: keep,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 1
    })
    await registerComputer(t.db, { name: 'local-computer', platform: 'p', version: 'v', now: 2 })
    expect(
      await retireStaleLocalComputers(t.db, { name: 'local-computer', keepComputerId: keep })
    ).toBe(1)
    expect(
      await retireStaleLocalComputers(t.db, { name: 'local-computer', keepComputerId: keep })
    ).toBe(0)
    expect(await listComputers(t.db)).toHaveLength(1)
  })

  it('RE-POINTS task + project bindings off the collapsed local ids', async () => {
    // A task + project bound to an OLD (orphan) local id must follow the collapse
    // to the survivor — otherwise resolveTaskComputerId returns a dead id and the
    // routing backend forwards the spawn to a nonexistent computer with no fallback.
    seedProjectAndTask(t.raw, 'proj-b', 'task-b')
    const keep = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id: keep,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 3
    })
    const orphan = await registerComputer(t.db, {
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 1
    })
    await setTaskComputer(t.db, 'task-b', orphan.id)
    await setProjectDefaultComputer(t.db, 'proj-b', orphan.id)

    await retireStaleLocalComputers(t.db, { name: 'local-computer', keepComputerId: keep })

    // Bindings now resolve to the SURVIVING local computer, not a dead id.
    expect(await resolveTaskComputerId(t.db, 'task-b')).toBe(keep)
    const proj = await t.db.get<{ default_computer_id: string | null }>(
      `SELECT default_computer_id FROM projects WHERE id = ?`,
      ['proj-b']
    )
    expect(proj!.default_computer_id).toBe(keep)
  })

  // Placements follow the collapse too. Left keyed to a deleted id they are never
  // delivered, and the survivor has no folder for the project.
  it('moves placements off the collapsed local ids, keeping the survivor’s own row', async () => {
    seedProjectAndTask(t.raw, 'proj-d', 'task-d')
    seedProjectAndTask(t.raw, 'proj-e', 'task-e')
    const keep = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id: keep,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 3
    })
    const orphan = await registerComputer(t.db, {
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 1
    })
    await setPlacement(t.db, {
      computerId: orphan.id,
      projectId: 'proj-d',
      path: '/d',
      status: 'pending'
    })
    // Both hold proj-e: the survivor's own row wins over the orphan's.
    await setPlacement(t.db, {
      computerId: keep,
      projectId: 'proj-e',
      path: '/e-keep',
      status: 'ready'
    })
    await setPlacement(t.db, {
      computerId: orphan.id,
      projectId: 'proj-e',
      path: '/e-old',
      status: 'ready'
    })

    await retireStaleLocalComputers(t.db, { name: 'local-computer', keepComputerId: keep })

    expect(await listPlacements(t.db)).toEqual([
      { computer_id: keep, project_id: 'proj-d', path: '/d', status: 'pending' },
      { computer_id: keep, project_id: 'proj-e', path: '/e-keep', status: 'ready' }
    ])
  })

  it('deleteComputer drops that computer’s placements', async () => {
    seedProjectAndTask(t.raw, 'proj-f', 'task-f')
    const c = await mkComputer()
    await setPlacement(t.db, { computerId: c.id, projectId: 'proj-f', path: '/f', status: 'ready' })
    await deleteComputer(t.db, c.id)
    expect(await listPlacements(t.db)).toEqual([])
  })

  it('leaves bindings to UNRELATED (remote) computers untouched during a local collapse', async () => {
    seedProjectAndTask(t.raw, 'proj-c', 'task-c')
    const keep = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id: keep,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 2
    })
    await registerComputer(t.db, { name: 'local-computer', platform: 'p', version: 'v', now: 1 })
    const remote = await registerComputer(t.db, {
      name: 'remote-x',
      platform: 'p',
      version: 'v',
      now: 3
    })
    await setTaskComputer(t.db, 'task-c', remote.id)

    await retireStaleLocalComputers(t.db, { name: 'local-computer', keepComputerId: keep })

    expect(await resolveTaskComputerId(t.db, 'task-c')).toBe(remote.id) // unchanged
  })
})

describe('task/project computer binding', () => {
  const projectId = 'proj-1'
  const taskId = 'task-1'

  beforeEach(() => {
    seedProjectAndTask(t.raw, projectId, taskId)
  })

  it('both NULL resolves to null (no EXPLICIT binding)', async () => {
    // null here means "nothing bound" — NOT "run on the hub". There is no
    // in-process exec path; resolveTaskComputerIdOrDefault supplies the fallback.
    expect(await resolveTaskComputerId(t.db, taskId)).toBeNull()
  })

  describe('resolveTaskComputerIdOrDefault', () => {
    // Both binding columns are nullable TEXT with no default, so an install that
    // never opened project settings has NOTHING bound. Since removing the
    // in-process fallback, such a task must still resolve to a real computer or no
    // agent could ever start on an existing install.
    it('falls back to the sole connected computer when nothing is bound', async () => {
      expect(
        await resolveTaskComputerIdOrDefault(t.db, taskId, () => [{ computerId: 'r-only' }])
      ).toBe('r-only')
    })

    it('prefers the local computer by name when several are connected', async () => {
      expect(
        await resolveTaskComputerIdOrDefault(t.db, taskId, () => [
          { computerId: 'r-remote', name: 'build-box' },
          { computerId: 'r-local', name: DEFAULT_LOCAL_COMPUTER_NAME }
        ])
      ).toBe('r-local')
    })

    it('refuses to guess when several are connected and none is the local one', async () => {
      // Silently picking one would run the agent on an arbitrary machine.
      expect(
        await resolveTaskComputerIdOrDefault(t.db, taskId, () => [
          { computerId: 'r-a', name: 'box-a' },
          { computerId: 'r-b', name: 'box-b' }
        ])
      ).toBeNull()
    })

    it('an EXPLICIT binding always wins over the connected default', async () => {
      await setTaskComputer(t.db, taskId, 'computer-pinned')
      expect(
        await resolveTaskComputerIdOrDefault(t.db, taskId, () => [
          { computerId: 'r-local', name: DEFAULT_LOCAL_COMPUTER_NAME }
        ])
      ).toBe('computer-pinned')
    })

    it('null when nothing is bound and nothing is connected', async () => {
      expect(await resolveTaskComputerIdOrDefault(t.db, taskId, () => [])).toBeNull()
    })
  })

  it('task NULL inherits the project default', async () => {
    await setProjectDefaultComputer(t.db, projectId, 'computer-default')
    expect(await resolveTaskComputerId(t.db, taskId)).toBe('computer-default')
  })

  it('explicit task computer overrides the project default', async () => {
    await setProjectDefaultComputer(t.db, projectId, 'computer-default')
    await setTaskComputer(t.db, taskId, 'computer-pinned')
    expect(await resolveTaskComputerId(t.db, taskId)).toBe('computer-pinned')
  })

  it('clearing the task binding falls back to inherit', async () => {
    await setProjectDefaultComputer(t.db, projectId, 'computer-default')
    await setTaskComputer(t.db, taskId, 'computer-pinned')
    await setTaskComputer(t.db, taskId, null)
    expect(await resolveTaskComputerId(t.db, taskId)).toBe('computer-default')
  })

  it('unknown task resolves to null', async () => {
    expect(await resolveTaskComputerId(t.db, 'nope')).toBeNull()
  })

  // §9 Phase 7e: a task's folder exists only on the computer holding it.
  describe('the folder computer', () => {
    const folderOn = (computerId: string, flags = 'has_worktree = 1') =>
      t.raw
        .prepare(`UPDATE tasks SET ${flags}, worktree_computer_id = ? WHERE id = ?`)
        .run(computerId, taskId)

    it('a task with a folder runs on the computer holding it, over its pin', async () => {
      await setTaskComputer(t.db, taskId, 'computer-pinned')
      folderOn('computer-folders')
      expect(await resolveTaskComputerId(t.db, taskId)).toBe('computer-folders')
      folderOn('computer-folders', 'has_worktree = 0, has_base_dir = 1')
      expect(await resolveTaskComputerId(t.db, taskId)).toBe('computer-folders')
    })

    it('without a folder the recorded holder decides nothing', async () => {
      await setTaskComputer(t.db, taskId, 'computer-pinned')
      folderOn('computer-folders', 'has_worktree = 0, has_base_dir = 0')
      expect(await resolveTaskComputerId(t.db, taskId)).toBe('computer-pinned')
    })

    it('a holder removed for good (no successor) decides nothing', async () => {
      await setProjectDefaultComputer(t.db, projectId, 'computer-default')
      folderOn('computer-gone')
      t.raw
        .prepare(
          "INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at) VALUES('computer-gone',NULL,'deleted',0)"
        )
        .run()
      expect(await resolveTaskComputerId(t.db, taskId)).toBe('computer-default')
    })

    it('re-pinning a task whose folder is on another computer is refused', async () => {
      folderOn('computer-folders')
      await expect(assertTaskMovable(t.db, taskId, 'computer-other')).rejects.toThrow(
        TaskFoldersElsewhereError
      )
      // Its own holder, or unpinning (the holder still decides): fine.
      await assertTaskMovable(t.db, taskId, 'computer-folders')
      await assertTaskMovable(t.db, taskId, null)
      // No folder: any computer.
      folderOn('computer-folders', 'has_worktree = 0')
      await assertTaskMovable(t.db, taskId, 'computer-other')
    })
  })
})

describe('deleteComputer', () => {
  // These columns are plain TEXT with no FK, so nothing nulls them for us — a
  // dangling computer_id resolves to a dead machine at exec time.
  it('nulls every binding and removes placements and grants', async () => {
    const c = await registerComputer(t.db, {
      name: 'doomed',
      platform: 'darwin-arm64',
      version: '0.36.0'
    })
    seedProjectAndTask(t.raw, 'proj-d', 'task-d')
    await setProjectDefaultComputer(t.db, 'proj-d', c.id)
    await setTaskComputer(t.db, 'task-d', c.id)
    await t.db.run(
      `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       VALUES (?, 'proj-d', '/srv/app', 'ready', 1)`,
      [c.id]
    )
    await t.db.run(
      `INSERT INTO computer_grants (computer_id, user_id, role, created_at) VALUES (?, 'bob', 'use', 1)`,
      [c.id]
    )

    await deleteComputer(t.db, c.id)

    expect(await getComputer(t.db, c.id)).toBeNull()
    expect(
      (
        await t.db.get<{ computer_id: string | null }>(
          `SELECT computer_id FROM tasks WHERE id = 'task-d'`
        )
      )?.computer_id
    ).toBeNull()
    expect(
      (
        await t.db.get<{ default_computer_id: string | null }>(
          `SELECT default_computer_id FROM projects WHERE id = 'proj-d'`
        )
      )?.default_computer_id
    ).toBeNull()
    expect((await t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM project_placements`))?.n).toBe(
      0
    )
    expect((await t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM computer_grants`))?.n).toBe(0)
  })
})

describe('replaceComputer', () => {
  // A remote computer enrolled again (its credential gone) gets a new id. Once the user
  // confirms it is the same machine, the old row's work moves to it and the old row goes.
  it('moves every binding, placement and worktree to the successor and records it', async () => {
    const old = await mkComputer({ name: 'ci-box', now: 1 })
    const next = await mkComputer({ name: 'ci-box', now: 2 })
    seedProjectAndTask(t.raw, 'proj-r', 'task-r')
    await setProjectDefaultComputer(t.db, 'proj-r', old.id)
    await setTaskComputer(t.db, 'task-r', old.id)
    await t.db.run(
      `UPDATE tasks SET worktree_computer_id = ?, has_worktree = 1 WHERE id = 'task-r'`,
      [old.id]
    )
    await setPlacement(t.db, {
      computerId: old.id,
      projectId: 'proj-r',
      path: '/r',
      status: 'ready'
    })
    await t.db.run(
      `INSERT INTO computer_grants (computer_id, user_id, role, created_at) VALUES (?, 'bob', 'use', 1)`,
      [old.id]
    )
    const removed: string[] = []
    setComputerRemovedListener((id) => removed.push(id))
    try {
      await replaceComputer(t.db, { computerId: old.id, successorId: next.id })
    } finally {
      setComputerRemovedListener(null)
    }

    expect(await getComputer(t.db, old.id)).toBeNull()
    expect(await getComputer(t.db, next.id)).not.toBeNull()
    expect(await resolveTaskComputerId(t.db, 'task-r')).toBe(next.id)
    expect(
      await t.db.get(`SELECT computer_id, worktree_computer_id FROM tasks WHERE id = 'task-r'`)
    ).toEqual({ computer_id: next.id, worktree_computer_id: next.id })
    expect(
      (
        await t.db.get<{ d: string }>(
          `SELECT default_computer_id AS d FROM projects WHERE id = 'proj-r'`
        )
      )?.d
    ).toBe(next.id)
    expect(await listPlacements(t.db)).toEqual([
      { computer_id: next.id, project_id: 'proj-r', path: '/r', status: 'ready' }
    ])
    // Grants described who could use the old row; the successor keeps its own.
    expect((await t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM computer_grants`))?.n).toBe(0)
    // The chat domain repoints its work from this record (applyComputerRetirements).
    expect(
      await t.db.get(
        `SELECT successor_id, reason FROM computer_retirements WHERE computer_id = ?`,
        [old.id]
      )
    ).toEqual({ successor_id: next.id, reason: 're-enrolled' })
    expect(removed).toEqual([old.id])
  })

  it('refuses replacing a computer with itself or with one that does not exist', async () => {
    const old = await mkComputer()
    await expect(
      replaceComputer(t.db, { computerId: old.id, successorId: old.id })
    ).rejects.toThrow(/itself/)
    await expect(
      replaceComputer(t.db, { computerId: old.id, successorId: 'nope' })
    ).rejects.toThrow(/no such computer/)
    await expect(
      replaceComputer(t.db, { computerId: 'nope', successorId: old.id })
    ).rejects.toThrow(/no such computer/)
    expect(await getComputer(t.db, old.id)).not.toBeNull()
  })

  it('refuses a revoked successor', async () => {
    const old = await mkComputer({ now: 1 })
    const next = await mkComputer({ now: 2 })
    await revokeComputer(t.db, next.id)
    await expect(
      replaceComputer(t.db, { computerId: old.id, successorId: next.id })
    ).rejects.toThrow(/revoked/)
  })
})

describe('unrevokeComputer', () => {
  it('clears the flag and returns the computer to the active list', async () => {
    const c = await registerComputer(t.db, {
      name: 'back',
      platform: 'darwin-arm64',
      version: '0.36.0'
    })
    await revokeComputer(t.db, c.id)
    expect((await listComputers(t.db)).some((r) => r.id === c.id)).toBe(false)
    await unrevokeComputer(t.db, c.id)
    expect((await listComputers(t.db)).some((r) => r.id === c.id)).toBe(true)
  })
})

describe('setComputerDisabled', () => {
  it('sets and clears disabled_at; a disabled computer stays listed', async () => {
    const c = await mkComputer()
    expect((await getComputer(t.db, c.id))?.disabled_at ?? null).toBeNull()
    await setComputerDisabled(t.db, c.id, true, 5000)
    expect((await getComputer(t.db, c.id))?.disabled_at).toBe(5000)
    expect((await listComputers(t.db)).some((r) => r.id === c.id)).toBe(true)
    expect([...(await listDisabledComputerIds(t.db))]).toEqual([c.id])
    await setComputerDisabled(t.db, c.id, false)
    expect((await getComputer(t.db, c.id))?.disabled_at ?? null).toBeNull()
    expect((await listDisabledComputerIds(t.db)).size).toBe(0)
  })

  it('keeps the first disable time when disabled again', async () => {
    const c = await mkComputer()
    await setComputerDisabled(t.db, c.id, true, 5000)
    await setComputerDisabled(t.db, c.id, true, 9000)
    expect((await getComputer(t.db, c.id))?.disabled_at).toBe(5000)
  })

  it('survives a re-enroll of the local computer (only revoked_at is cleared)', async () => {
    const id = deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME)
    const input = {
      id,
      name: DEFAULT_LOCAL_COMPUTER_NAME,
      platform: 'darwin-arm64',
      version: '0.37.0'
    }
    await registerOrReplaceComputer(t.db, input)
    await setComputerDisabled(t.db, id, true, 5000)
    await registerOrReplaceComputer(t.db, { ...input, version: '0.38.0' })
    expect((await getComputer(t.db, id))?.disabled_at).toBe(5000)
  })
})

// Round-5 K9: a revoke from REST, or from a departing user's cleanup, never told the
// hub the computer was gone (only the tRPC router did), so a process run it kept
// stayed "waiting for its computer" forever. The store itself tells — every path.
describe('onComputerRemoved: every delete and revoke is heard', () => {
  it('fires for revokeComputer and deleteComputer, from any caller', async () => {
    const heard: string[] = []
    setComputerRemovedListener((id) => heard.push(id))
    try {
      const a = await mkComputer({ name: 'one' })
      const b = await mkComputer({ name: 'two' })
      await revokeComputer(t.db, a.id)
      await deleteComputer(t.db, b.id)
      expect(heard).toEqual([a.id, b.id])
    } finally {
      setComputerRemovedListener(null)
    }
    await revokeComputer(t.db, (await mkComputer({ name: 'three' })).id)
    expect(heard, 'cleared').toHaveLength(2)
  })
})

describe('computer retirements (chat work repoints or retires with them)', () => {
  const retirements = () =>
    t.db.all(
      'SELECT computer_id,successor_id,reason FROM computer_retirements ORDER BY computer_id'
    )

  it('re-enrolling the local computer records each stale id with its successor', async () => {
    const keep = deterministicLocalComputerId('local-computer')
    await registerOrReplaceComputer(t.db, {
      id: keep,
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 3
    })
    const stale = await registerComputer(t.db, {
      name: 'local-computer',
      platform: 'p',
      version: 'v',
      now: 1
    })
    await retireStaleLocalComputers(t.db, { name: 'local-computer', keepComputerId: keep })
    expect(await retirements()).toEqual([
      { computer_id: stale.id, successor_id: keep, reason: 're-enrolled' }
    ])
  })

  it('a retirement names its final successor or none: re-enrolled again, or then deleted', async () => {
    const a = await mkComputer({ name: 'a' })
    const b = await mkComputer({ name: 'b' })
    const c = await mkComputer({ name: 'c' })
    // a re-enrolled as b, b re-enrolled as c: a names c.
    await replaceComputer(t.db, { computerId: a.id, successorId: b.id })
    await replaceComputer(t.db, { computerId: b.id, successorId: c.id })
    const of = async (id: string) =>
      t.db.get('SELECT successor_id,reason FROM computer_retirements WHERE computer_id=?', [id])
    expect(await of(a.id)).toEqual({ successor_id: c.id, reason: 're-enrolled' })
    expect(await computerStanding(t.db, a.id)).toEqual({
      kind: 'successor',
      id: c.id,
      formerId: a.id
    })
    // c deleted: a and b are removed for good, with c's reason.
    await deleteComputer(t.db, c.id)
    for (const id of [a.id, b.id, c.id]) {
      expect(await of(id)).toEqual({ successor_id: null, reason: 'deleted' })
      expect(await computerStanding(t.db, id)).toEqual({ kind: 'removed', id, reason: 'deleted' })
    }
  })

  it('computerStanding: live for an unretired id (revoked or unknown too); a chain read as it ends', async () => {
    const revoked = await mkComputer({ name: 'revoked' })
    await revokeComputer(t.db, revoked.id, 5)
    expect(await computerStanding(t.db, revoked.id)).toEqual({ kind: 'live', id: revoked.id })
    expect(await computerStanding(t.db, 'never-seen')).toEqual({ kind: 'live', id: 'never-seen' })
    // A chain left by a build before retirements were kept collapsed (v215 collapses
    // stored ones): still read to its end; a cycle names no live computer.
    await t.db.run(
      `INSERT INTO computer_retirements(computer_id,successor_id,reason,retired_at) VALUES
        ('x','y','re-enrolled',1),('y','z','re-enrolled',2),
        ('p','q','re-enrolled',1),('q',NULL,'missing',2),
        ('k','l','re-enrolled',1),('l','k','re-enrolled',2)`
    )
    expect(await computerStanding(t.db, 'x')).toEqual({ kind: 'successor', id: 'z', formerId: 'x' })
    expect(await computerStanding(t.db, 'p')).toEqual({
      kind: 'removed',
      id: 'p',
      reason: 'missing'
    })
    expect(await computerStanding(t.db, 'k')).toEqual({
      kind: 'removed',
      id: 'k',
      reason: 'missing'
    })
  })

  it('a deleted local computer enrolling again under its own id is live again', async () => {
    const id = deterministicLocalComputerId('local-computer')
    const enroll = () =>
      registerOrReplaceComputer(t.db, {
        id,
        name: 'local-computer',
        platform: 'p',
        version: 'v',
        now: 3
      })
    await enroll()
    await deleteComputer(t.db, id)
    expect(await computerStanding(t.db, id)).toEqual({ kind: 'removed', id, reason: 'deleted' })
    // The same machine (its id is derived from it): its retirement goes, its work is
    // its own again — recovery takes back the chats it still holds when it connects.
    await enroll()
    expect(await computerStanding(t.db, id)).toEqual({ kind: 'live', id })
    expect(await retirements()).toEqual([])
  })

  it('deleting a computer records it with no successor; revoking records nothing', async () => {
    const gone = await mkComputer({ name: 'gone' })
    const revoked = await mkComputer({ name: 'revoked' })
    await deleteComputer(t.db, gone.id)
    await revokeComputer(t.db, revoked.id, 5)
    expect(await retirements()).toEqual([
      { computer_id: gone.id, successor_id: null, reason: 'deleted' }
    ])
  })
})
