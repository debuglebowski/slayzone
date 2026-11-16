import { afterEach, expect, test } from 'vitest'
import { setAuthGate } from '@slayzone/trpc-server'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness'
import { eraseContent } from './index'
import { hubErasureRouter, hubUsersRouter } from './router'
const fixtures: TestHarness[] = []
afterEach(() => {
  setAuthGate(() => false)
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
