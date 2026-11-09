/** Startup cannot treat revoked/offline computers as a reason to erase content. */
import { afterEach, expect, test } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../../../shared/test-utils/ipc-harness'
import { purgeStaleAndOrphanedTasks } from './startup-purge'
const fixtures: TestHarness[] = []
afterEach(() => {
  for (const h of fixtures.splice(0)) h.cleanup()
})
test('startup leaves old content and worktree ownership alone', async () => {
  const h = await createTestHarness()
  fixtures.push(h)
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare(
      "INSERT INTO tasks(id,project_id,title,worktree_path,deleted_at) VALUES('t','p','Kept','/unreachable/worktree',datetime('now','-90 days'))"
    )
    .run()
  await purgeStaleAndOrphanedTasks(h.slayDb)
  expect(h.db.prepare("SELECT title,worktree_path FROM tasks WHERE id='t'").get()).toEqual({
    title: 'Kept',
    worktree_path: '/unreachable/worktree'
  })
})
