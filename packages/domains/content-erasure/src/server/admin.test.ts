import { afterEach, expect, test } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createAdminContentErasure, type ErasureAccount } from './admin'

const fixtures: TestHarness[] = []
afterEach(() => {
  for (const h of fixtures.splice(0)) h.cleanup()
})
async function fixture() {
  const h = await createTestHarness()
  fixtures.push(h)
  for (const id of ['alice', 'bob']) {
    h.db
      .prepare('INSERT INTO projects(id,name,color,owner_user_id) VALUES(?,?,?,?)')
      .run(`p-${id}`, `${id} secret project`, '#000000', id)
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,description) VALUES(?,?,?,?)')
      .run(`t-${id}`, `p-${id}`, `${id} secret title`, `${id} secret description`)
  }
  const users: ErasureAccount[] = [
    { id: 'alice', email: 'alice@example.com', name: 'Alice', disabledAt: '2026-11-09T12:00:00Z' },
    { id: 'bob', email: 'bob@example.com', name: 'Bob', disabledAt: null as string | null }
  ]
  const service = createAdminContentErasure({
    db: h.slayDb,
    dataRoot: h.tmpDir(),
    findUser: async (id: string) => users.find((u) => u.id === id) ?? null
  })
  return { h, users, service }
}
const admin = { userId: 'operator', role: 'admin' as const, scopes: ['full'] }

test('only a full-session hub admin may erase another user', async () => {
  const { h, service } = await fixture()
  for (const actor of [
    { ...admin, role: 'user' as const },
    { ...admin, scopes: ['tasks'] }
  ]) {
    await expect(
      service.erase({ actor, userId: 'alice', confirmation: 'alice@example.com' })
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY' })
  }
  expect(h.db.prepare('SELECT id FROM tasks').all()).toHaveLength(2)
  expect(h.db.prepare('SELECT id FROM content_erasure_jobs').all()).toEqual([])
})

test('an active user cannot be erased, including when re-enabled after the preview', async () => {
  const { h, users, service } = await fixture()
  await expect(
    service.erase({ actor: admin, userId: 'bob', confirmation: 'bob@example.com' })
  ).rejects.toMatchObject({ code: 'USER_NOT_DISABLED' })
  await service.preview({ actor: admin, userId: 'alice' })
  users[0].disabledAt = null
  await expect(
    service.erase({ actor: admin, userId: 'alice', confirmation: 'alice@example.com' })
  ).rejects.toMatchObject({ code: 'USER_NOT_DISABLED' })
  expect(h.db.prepare('SELECT id FROM tasks').all()).toHaveLength(2)
})

test('confirmation must identify the disabled target; preview/report never expose content', async () => {
  const { h, users, service } = await fixture()
  const preview = await service.preview({ actor: admin, userId: 'alice' })
  expect(preview.counts).toMatchObject({ projects: 1, tasks: 1 })
  expect(JSON.stringify(preview)).not.toContain('secret')
  await expect(
    service.erase({ actor: admin, userId: 'alice', confirmation: 'bob@example.com' })
  ).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  const report = await service.erase({
    actor: admin,
    userId: 'alice',
    confirmation: 'alice@example.com'
  })
  expect(report.state).toBe('complete')
  expect(JSON.stringify(report)).not.toContain('secret')
  expect(users[0].disabledAt).toBe('2026-11-09T12:00:00Z')
  expect(h.db.prepare("SELECT title FROM tasks WHERE id='t-bob'").get()).toEqual({
    title: 'bob secret title'
  })
})

test('offline receipts must match the issued computer, scope and current deletion fence', async () => {
  const { h, service } = await fixture()
  h.db
    .prepare(
      "INSERT INTO computers(id,name,platform,version,capabilities_json,created_at,owner_user_id) VALUES('pc','Alice laptop','linux','fixture','[]',1,'alice')"
    )
    .run()
  h.db.prepare("INSERT INTO chat_task_computers VALUES('t-alice','pc')").run()
  const report = await service.erase({
    actor: admin,
    userId: 'alice',
    confirmation: 'alice@example.com'
  })
  expect(report.state).toBe('incomplete')
  const request = await service.computerRequest({
    actor: admin,
    jobId: report.id,
    computerId: 'pc',
    hubUrl: 'wss://fixture.example/computers'
  })
  const receipt = {
    request,
    verifiedAt: new Date().toISOString(),
    managedContentErased: true,
    worktreesVerified: true
  }
  await expect(
    service.confirmComputer({
      actor: admin,
      receipt: { ...receipt, request: { ...request, computerId: 'wrong' } }
    })
  ).rejects.toMatchObject({ code: 'INVALID_COMPUTER_RECEIPT' })
  const done = await service.confirmComputer({ actor: admin, receipt })
  expect(done.state).toBe('complete')
  expect(done.computers).toContainEqual({
    id: 'pc',
    name: 'Alice laptop',
    deleted: true,
    verifiedBy: 'operator'
  })
  expect(h.db.prepare("SELECT 1 FROM tasks WHERE id='t-bob'").get()).toBeDefined()
})
