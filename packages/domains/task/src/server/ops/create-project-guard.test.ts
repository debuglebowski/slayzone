/**
 * `createTaskOp` refuses a projectId this hub does not have.
 *
 * Under multi-hub federation a project lives in exactly ONE hub's DB, so a
 * create aimed at the wrong hub used to fall straight through to the INSERT and
 * surface as a bare `FOREIGN KEY constraint failed` — a SQLite string with no
 * project id, no hub, and nothing to act on. The REST create path already
 * resolves the project up front (and 404s); this closes the tRPC + MCP paths,
 * which share this op.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'

const NOOP_DEPS = { ipcMain: undefined, onMutation: undefined } as never

test('createTaskOp: unknown project is named in the error, not a bare FK failure', async () => {
  const h = await createTestHarness()
  let message = ''
  try {
    await createTaskOp(h.slayDb, { projectId: 'p-lives-on-another-hub', title: 'T' }, NOOP_DEPS)
  } catch (e) {
    message = (e as Error).message
  }
  expect(message.includes('p-lives-on-another-hub')).toBe(true)
  expect(message.includes('FOREIGN KEY')).toBe(false)
  // Nothing was written.
  expect((h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(0)
  h.cleanup()
})

test('createTaskOp: an existing project still creates', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))

  const task = await createTaskOp(h.slayDb, { projectId, title: 'Real task' }, NOOP_DEPS)
  expect(task?.title).toBe('Real task')
  expect(task?.project_id).toBe(projectId)
  h.cleanup()
})
