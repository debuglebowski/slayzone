import { afterEach, expect, test } from 'vitest'
import { setAuthGate } from '@slayzone/trpc-server'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness'
import { eraseContent } from './index'
import { hubErasureRouter, hubUsersRouter, setHubAdminDeps, type HubAdminDeps } from './router'
const fixtures: TestHarness[] = []
afterEach(() => {
  setAuthGate(() => false)
  setHubAdminDeps(null)
  for (const h of fixtures.splice(0)) h.cleanup()
})
test('owners see only their erasure metadata; an admin has no cross-owner content path', async () => {
  const h = await createTestHarness()
  fixtures.push(h)
  h.db
    .prepare(
      "INSERT INTO projects(id,name,color,owner_user_id) VALUES('p','Private','#000','alice')"
    )
    .run()
  h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('t','p','private title')").run()
  const report = await eraseContent(
    h.slayDb,
    h.tmpDir(),
    { kind: 'tasks', ids: ['t'] },
    {
      removePath() {
        throw new Error('private filesystem error')
      }
    }
  )
  const caller = (userId: string, role: 'admin' | 'user' = 'user', scopes: string[] = ['full']) =>
    hubErasureRouter.createCaller({ db: h.slayDb, principal: { userId, role, scopes } } as never)
  expect((await caller('alice').reports()).map((r) => r.id)).toEqual([report.id])
  expect(await caller('bob', 'admin').reports()).toEqual([])
  await expect(caller('bob', 'admin').receipt({ jobId: report.id })).rejects.toMatchObject({
    code: 'NOT_FOUND'
  })
  await expect(caller('alice', 'user', ['read']).reports()).rejects.toMatchObject({
    code: 'FORBIDDEN'
  })
  expect(JSON.stringify(await caller('alice').receipt({ jobId: report.id }))).not.toContain(
    'private'
  )
})
test('user management refuses a non-admin even with the outer auth gate off', async () => {
  const h = await createTestHarness()
  fixtures.push(h)
  const caller = hubUsersRouter.createCaller({
    db: h.slayDb,
    principal: { userId: 'alice', role: 'user', scopes: ['full'] }
  } as never)
  await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

function fakeUsers(overrides: Partial<HubAdminDeps['users']> = {}) {
  const calls: unknown[][] = []
  const users: HubAdminDeps['users'] = {
    ready: () => true,
    describe: () => ({ roleAuthority: 'hub', passwordEnabled: true }),
    list: async () => [],
    create: async (input) => {
      calls.push(['create', input])
      return {
        ok: true,
        user: { id: 'n', email: input.email, name: 'n', role: 'user', password: 'pw' }
      }
    },
    disable: async () => 'ok',
    enable: async (email) => {
      calls.push(['enable', email])
      return 'ok'
    },
    setRole: async (email, role) => {
      calls.push(['setRole', email, role])
      return 'ok'
    },
    ...overrides
  }
  setHubAdminDeps({ dataRoot: '/unused', users, erasure: {} as never })
  return calls
}
async function usersCaller(role: 'admin' | 'user' = 'admin', scopes = ['full']) {
  const h = await createTestHarness()
  fixtures.push(h)
  return hubUsersRouter.createCaller({
    db: h.slayDb,
    principal: { userId: 'me', role, scopes }
  } as never)
}

test('access tells an admin what the hub allows and which row is theirs; a user nothing', async () => {
  fakeUsers({ describe: () => ({ roleAuthority: 'idp', passwordEnabled: false }) })
  expect(await (await usersCaller()).access()).toMatchObject({
    canManage: true,
    management: { roleAuthority: 'idp', passwordEnabled: false },
    selfUserId: 'me'
  })
  expect(await (await usersCaller('user')).access()).toMatchObject({
    canManage: false,
    management: null,
    selfUserId: null
  })
})

test('create, enable and setRole are admin-only and reach the account service', async () => {
  const calls = fakeUsers()
  const user = await usersCaller('user')
  await expect(user.create({ email: 'x@example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(user.enable({ email: 'x@example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(user.setRole({ email: 'x@example.com', role: 'admin' })).rejects.toMatchObject({
    code: 'FORBIDDEN'
  })
  const scoped = await usersCaller('admin', ['read'])
  await expect(scoped.create({ email: 'x@example.com' })).rejects.toMatchObject({
    code: 'FORBIDDEN'
  })
  expect(calls).toEqual([])
  const admin = await usersCaller()
  expect(await admin.create({ email: 'new@example.com', name: '', role: 'admin' })).toMatchObject({
    email: 'new@example.com',
    password: 'pw'
  })
  await admin.enable({ email: 'old@example.com' })
  await admin.setRole({ email: 'old@example.com', role: 'user' })
  expect(calls).toEqual([
    ['create', { email: 'new@example.com', role: 'admin' }],
    ['enable', 'old@example.com'],
    ['setRole', 'old@example.com', 'user']
  ])
})

test('refusals surface as CONFLICT / NOT_FOUND with a reason the UI can show', async () => {
  fakeUsers({
    create: async () => ({ ok: false, reason: 'exists' }),
    enable: async () => 'erasure-in-progress',
    setRole: async (email) => (email === 'gone@example.com' ? 'not-found' : 'last-admin')
  })
  const admin = await usersCaller()
  await expect(admin.create({ email: 'a@example.com' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'An account with that email already exists.'
  })
  await expect(admin.enable({ email: 'a@example.com' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: expect.stringContaining('being erased')
  })
  await expect(admin.setRole({ email: 'a@example.com', role: 'user' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: expect.stringContaining('last enabled admin')
  })
  await expect(admin.setRole({ email: 'gone@example.com', role: 'user' })).rejects.toMatchObject({
    code: 'NOT_FOUND'
  })
  await expect(admin.create({ email: 'computers@slayzone.internal' })).rejects.toMatchObject({
    code: 'BAD_REQUEST'
  })
})
