import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunnerRecord } from '../shared/types'
import {
  deterministicLocalRunnerId,
  getRunner,
  getRunnerCheckout,
  listCheckoutsForProject,
  listCheckoutsForRunner,
  listRunners,
  registerOrReplaceRunner,
  registerRunner,
  resolveTaskRunnerId,
  retireStaleLocalRunners,
  revokeRunner,
  setProjectDefaultRunner,
  setTaskRunner,
  touchRunnerLastSeen,
  upsertRunnerCheckout
} from './store'
import { createMigratedDb, seedProjectAndTask, type TestDb } from './test-db'

let t: TestDb

beforeEach(() => {
  t = createMigratedDb()
})

afterEach(() => {
  t.close()
})

function mkRunner(over: { name?: string; now?: number } = {}) {
  return registerRunner(t.db, {
    name: over.name ?? 'mac-studio',
    platform: 'darwin-arm64',
    version: '0.35.0',
    capabilities: { modes: ['claude-code'] },
    now: over.now ?? 1000
  })
}

describe('runner CRUD', () => {
  it('registerRunner persists and getRunner round-trips', async () => {
    const r = await mkRunner()
    const row = await getRunner(t.db, r.id)
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

  it('getRunner returns null for unknown id', async () => {
    expect(await getRunner(t.db, 'nope')).toBeNull()
  })

  it('listRunners excludes revoked by default, includes with flag', async () => {
    const a = await mkRunner({ name: 'a', now: 1 })
    const b = await mkRunner({ name: 'b', now: 2 })
    await revokeRunner(t.db, a.id, 50)

    const active = await listRunners(t.db)
    expect(active.map((r: RunnerRecord) => r.id)).toEqual([b.id])

    const all = await listRunners(t.db, { includeRevoked: true })
    expect(all.map((r: RunnerRecord) => r.id)).toEqual([a.id, b.id])
  })

  it('touchRunnerLastSeen advances but never rewinds', async () => {
    const r = await mkRunner({ now: 1000 })
    await touchRunnerLastSeen(t.db, r.id, 2000)
    expect((await getRunner(t.db, r.id))!.last_seen_at).toBe(2000)
    await touchRunnerLastSeen(t.db, r.id, 1500)
    expect((await getRunner(t.db, r.id))!.last_seen_at).toBe(2000)
  })

  it('revokeRunner is idempotent — first revocation time wins', async () => {
    const r = await mkRunner()
    await revokeRunner(t.db, r.id, 5000)
    await revokeRunner(t.db, r.id, 9000)
    expect((await getRunner(t.db, r.id))!.revoked_at).toBe(5000)
  })
})

describe('local-runner dedup (Wave3.5-D5)', () => {
  it('deterministicLocalRunnerId is stable for a name and uuid-shaped', () => {
    const a = deterministicLocalRunnerId('local-runner')
    const b = deterministicLocalRunnerId('local-runner')
    expect(a).toBe(b) // same name ⇒ same id (idempotent enroll key)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // A different name ⇒ a different id (no accidental collision).
    expect(deterministicLocalRunnerId('other-runner')).not.toBe(a)
  })

  it('registerOrReplaceRunner UPSERTs onto one row (no orphan per enroll)', async () => {
    const id = deterministicLocalRunnerId('local-runner')
    await registerOrReplaceRunner(t.db, {
      id,
      name: 'local-runner',
      platform: 'darwin-arm64',
      version: '0.35.0',
      capabilities: { modes: ['claude-code'] },
      authKeyId: 'key-1',
      now: 1000
    })
    // Second enroll (a relaunch) with the SAME deterministic id: refresh identity
    // + auth, preserve created_at, stay a single row.
    await registerOrReplaceRunner(t.db, {
      id,
      name: 'local-runner',
      platform: 'darwin-arm64',
      version: '0.36.0',
      capabilities: { modes: ['codex'] },
      authKeyId: 'key-2',
      now: 2000
    })

    const rows = await listRunners(t.db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].version).toBe('0.36.0') // refreshed
    expect(rows[0].auth_key_id).toBe('key-2') // refreshed
    expect(rows[0].created_at).toBe(1000) // original birth preserved
    expect(rows[0].last_seen_at).toBe(2000) // heartbeat advanced
  })

  it('registerOrReplaceRunner un-revokes on re-enroll (operator asked it back)', async () => {
    const id = deterministicLocalRunnerId('local-runner')
    await registerOrReplaceRunner(t.db, {
      id,
      name: 'local-runner',
      platform: 'p',
      version: 'v',
      now: 1000
    })
    await revokeRunner(t.db, id, 1500)
    expect((await getRunner(t.db, id))!.revoked_at).toBe(1500)
    await registerOrReplaceRunner(t.db, {
      id,
      name: 'local-runner',
      platform: 'p',
      version: 'v',
      now: 2000
    })
    expect((await getRunner(t.db, id))!.revoked_at).toBeNull()
  })

  it('retireStaleLocalRunners collapses historical duplicate local rows to one', async () => {
    // Simulate the pre-fix state: three random-id rows all named 'local-runner'
    // (one accumulated per relaunch) plus a legitimate REMOTE runner.
    const keep = deterministicLocalRunnerId('local-runner')
    await registerOrReplaceRunner(t.db, { id: keep, name: 'local-runner', platform: 'p', version: 'v', now: 3 })
    await registerRunner(t.db, { name: 'local-runner', platform: 'p', version: 'v', now: 1 })
    await registerRunner(t.db, { name: 'local-runner', platform: 'p', version: 'v', now: 2 })
    const remote = await registerRunner(t.db, { name: 'mac-studio-remote', platform: 'p', version: 'v', now: 4 })

    const removed = await retireStaleLocalRunners(t.db, { name: 'local-runner', keepRunnerId: keep })
    expect(removed).toBe(2) // the two orphaned random-id local rows

    const rows = await listRunners(t.db)
    const localRows = rows.filter((r) => r.name === 'local-runner')
    expect(localRows).toHaveLength(1)
    expect(localRows[0].id).toBe(keep)
    // The remote runner is UNTOUCHED — dedup is scoped to the local name only.
    expect(rows.find((r) => r.id === remote.id)).toBeTruthy()
  })

  it('retireStaleLocalRunners NEVER touches a disconnected remote runner (identity-only)', async () => {
    const keep = deterministicLocalRunnerId('local-runner')
    await registerOrReplaceRunner(t.db, { id: keep, name: 'local-runner', platform: 'p', version: 'v', now: 1 })
    // A remote runner (different name) — represents a sleeping laptop, no live
    // connection. It must survive: dedup matches by name, never by status.
    const sleeping = await registerRunner(t.db, { name: 'colleague-laptop', platform: 'p', version: 'v', now: 2 })

    const removed = await retireStaleLocalRunners(t.db, { name: 'local-runner', keepRunnerId: keep })
    expect(removed).toBe(0) // nothing else shares the local name
    expect(await getRunner(t.db, sleeping.id)).not.toBeNull()
  })

  it('retireStaleLocalRunners is idempotent — a second call is a no-op', async () => {
    const keep = deterministicLocalRunnerId('local-runner')
    await registerOrReplaceRunner(t.db, { id: keep, name: 'local-runner', platform: 'p', version: 'v', now: 1 })
    await registerRunner(t.db, { name: 'local-runner', platform: 'p', version: 'v', now: 2 })
    expect(await retireStaleLocalRunners(t.db, { name: 'local-runner', keepRunnerId: keep })).toBe(1)
    expect(await retireStaleLocalRunners(t.db, { name: 'local-runner', keepRunnerId: keep })).toBe(0)
    expect(await listRunners(t.db)).toHaveLength(1)
  })

  it('RE-POINTS task + project bindings off the collapsed local ids', async () => {
    // A task + project bound to an OLD (orphan) local id must follow the collapse
    // to the survivor — otherwise resolveTaskRunnerId returns a dead id and the
    // routing backend forwards the spawn to a nonexistent runner with no fallback.
    seedProjectAndTask(t.raw, 'proj-b', 'task-b')
    const keep = deterministicLocalRunnerId('local-runner')
    await registerOrReplaceRunner(t.db, { id: keep, name: 'local-runner', platform: 'p', version: 'v', now: 3 })
    const orphan = await registerRunner(t.db, { name: 'local-runner', platform: 'p', version: 'v', now: 1 })
    await setTaskRunner(t.db, 'task-b', orphan.id)
    await setProjectDefaultRunner(t.db, 'proj-b', orphan.id)

    await retireStaleLocalRunners(t.db, { name: 'local-runner', keepRunnerId: keep })

    // Bindings now resolve to the SURVIVING local runner, not a dead id.
    expect(await resolveTaskRunnerId(t.db, 'task-b')).toBe(keep)
    const proj = await t.db.get<{ default_runner_id: string | null }>(
      `SELECT default_runner_id FROM projects WHERE id = ?`,
      ['proj-b']
    )
    expect(proj!.default_runner_id).toBe(keep)
  })

  it('leaves bindings to UNRELATED (remote) runners untouched during a local collapse', async () => {
    seedProjectAndTask(t.raw, 'proj-c', 'task-c')
    const keep = deterministicLocalRunnerId('local-runner')
    await registerOrReplaceRunner(t.db, { id: keep, name: 'local-runner', platform: 'p', version: 'v', now: 2 })
    await registerRunner(t.db, { name: 'local-runner', platform: 'p', version: 'v', now: 1 })
    const remote = await registerRunner(t.db, { name: 'remote-x', platform: 'p', version: 'v', now: 3 })
    await setTaskRunner(t.db, 'task-c', remote.id)

    await retireStaleLocalRunners(t.db, { name: 'local-runner', keepRunnerId: keep })

    expect(await resolveTaskRunnerId(t.db, 'task-c')).toBe(remote.id) // unchanged
  })
})

describe('runner project checkouts', () => {
  it('upsert inserts then updates in place', async () => {
    await upsertRunnerCheckout(t.db, {
      runnerId: 'r-1',
      projectId: 'p-1',
      rootPath: '/work/slayzone',
      status: 'cloning',
      now: 10
    })
    await upsertRunnerCheckout(t.db, {
      runnerId: 'r-1',
      projectId: 'p-1',
      rootPath: '/work/slayzone',
      status: 'ready',
      now: 20
    })

    const row = await getRunnerCheckout(t.db, 'r-1', 'p-1')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('ready')
    expect(row!.updated_at).toBe(20)

    const rows = await listCheckoutsForRunner(t.db, 'r-1')
    expect(rows).toHaveLength(1)
  })

  it('lists by runner and by project', async () => {
    await upsertRunnerCheckout(t.db, {
      runnerId: 'r-1',
      projectId: 'p-1',
      rootPath: '/a',
      status: 'ready',
      now: 1
    })
    await upsertRunnerCheckout(t.db, {
      runnerId: 'r-1',
      projectId: 'p-2',
      rootPath: '/b',
      status: 'pending',
      now: 2
    })
    await upsertRunnerCheckout(t.db, {
      runnerId: 'r-2',
      projectId: 'p-1',
      rootPath: '/c',
      status: 'error',
      now: 3
    })

    expect((await listCheckoutsForRunner(t.db, 'r-1')).map((c) => c.project_id)).toEqual([
      'p-1',
      'p-2'
    ])
    expect((await listCheckoutsForProject(t.db, 'p-1')).map((c) => c.runner_id)).toEqual([
      'r-1',
      'r-2'
    ])
  })
})

describe('task/project runner binding', () => {
  const projectId = 'proj-1'
  const taskId = 'task-1'

  beforeEach(() => {
    seedProjectAndTask(t.raw, projectId, taskId)
  })

  it('both NULL resolves to null (local/first runner)', async () => {
    expect(await resolveTaskRunnerId(t.db, taskId)).toBeNull()
  })

  it('task NULL inherits the project default', async () => {
    await setProjectDefaultRunner(t.db, projectId, 'runner-default')
    expect(await resolveTaskRunnerId(t.db, taskId)).toBe('runner-default')
  })

  it('explicit task runner overrides the project default', async () => {
    await setProjectDefaultRunner(t.db, projectId, 'runner-default')
    await setTaskRunner(t.db, taskId, 'runner-pinned')
    expect(await resolveTaskRunnerId(t.db, taskId)).toBe('runner-pinned')
  })

  it('clearing the task binding falls back to inherit', async () => {
    await setProjectDefaultRunner(t.db, projectId, 'runner-default')
    await setTaskRunner(t.db, taskId, 'runner-pinned')
    await setTaskRunner(t.db, taskId, null)
    expect(await resolveTaskRunnerId(t.db, taskId)).toBe('runner-default')
  })

  it('unknown task resolves to null', async () => {
    expect(await resolveTaskRunnerId(t.db, 'nope')).toBeNull()
  })
})
