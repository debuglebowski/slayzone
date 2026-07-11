import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunnerRecord } from '../shared/types'
import {
  getRunner,
  getRunnerCheckout,
  listCheckoutsForProject,
  listCheckoutsForRunner,
  listRunners,
  registerRunner,
  resolveTaskRunnerId,
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
