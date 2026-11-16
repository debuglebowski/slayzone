/**
 * A browser tab's `isolated` flag is fixed when the tab is created (review 4 part B):
 * a generic task update can never move an existing tab between the user's own browser
 * and the isolated one — so no write moves an agent's tab into the user's logins, or
 * the user's tab under an agent's control.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'
import { updateTask } from './shared.js'

const tabsOf = (h: Awaited<ReturnType<typeof createTestHarness>>, id: string) =>
  JSON.parse(
    (
      h.db.prepare('SELECT browser_tabs FROM tasks WHERE id = ?').get(id) as {
        browser_tabs: string
      }
    ).browser_tabs
  ).tabs as Array<{ id: string; isolated?: boolean }>

test('isolated is set at creation and never changes after', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))
  const task = await createTaskOp(h.slayDb, { projectId, title: 'A' }, {})
  const id = task!.id
  await updateTask(h.slayDb, {
    id,
    browserTabs: {
      tabs: [
        { id: 'own', url: 'https://bank.test/', title: 'Bank' },
        { id: 'iso', url: 'about:blank', title: 'New Tab', isolated: true }
      ],
      activeTabId: 'own'
    }
  })
  expect(tabsOf(h, id)).toMatchObject([{ id: 'own' }, { id: 'iso', isolated: true }])

  // A later write flips both: neither moves.
  await updateTask(h.slayDb, {
    id,
    browserTabs: {
      tabs: [
        { id: 'own', url: 'https://bank.test/', title: 'Bank', isolated: true },
        { id: 'iso', url: 'https://a.test/', title: 'A', isolated: false }
      ],
      activeTabId: 'own'
    }
  })
  const after = tabsOf(h, id)
  expect(after[0]?.isolated).toBeUndefined()
  expect(after[1]?.isolated).toBe(true)
  expect(after[1]).toMatchObject({ url: 'https://a.test/' })
  h.cleanup()
})
