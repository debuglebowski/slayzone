/**
 * The artifacts panel's sidebar (visibility + width) is saved per task in
 * `tasks.artifacts_sidebar` (v186) and read back on the task.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'
import { updateTask } from './shared.js'

test('artifacts sidebar state round-trips per task; null clears it', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))
  const a = await createTaskOp(h.slayDb, { projectId, title: 'A' }, {})
  const b = await createTaskOp(h.slayDb, { projectId, title: 'B' }, {})
  expect(a?.artifacts_sidebar).toBeNull()

  const saved = await updateTask(h.slayDb, {
    id: a!.id,
    artifactsSidebar: { visible: false, width: 220 }
  })
  expect(saved?.artifacts_sidebar).toEqual({ visible: false, width: 220 })
  const other = h.db.prepare('SELECT artifacts_sidebar FROM tasks WHERE id = ?').get(b!.id) as {
    artifacts_sidebar: string | null
  }
  expect(other.artifacts_sidebar).toBeNull()

  const cleared = await updateTask(h.slayDb, { id: a!.id, artifactsSidebar: null })
  expect(cleared?.artifacts_sidebar).toBeNull()
  h.cleanup()
})
