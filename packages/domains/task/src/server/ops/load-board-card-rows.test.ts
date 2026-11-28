/**
 * A board of card rows (`rows: 'card'`) leaves out the page-only fields
 * (`TASK_CARD_OMITTED_FIELDS`): a fraction of the full board's bytes. Without it
 * (older clients) the board is full rows, as before.
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts).
 */
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { TASK_CARD_OMITTED_FIELDS, isFullTaskRow } from '@slayzone/task-contracts'
import { createTaskOp } from './create.js'
import { loadBoardDataOp, loadBoardRowsOp } from './load-board-data.js'

async function setup() {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))
  const id = (await createTaskOp(h.slayDb, { projectId, title: 'a', description: 'body' }, {}))!.id
  return { h, id }
}

test('card rows leave out the page-only fields; full rows stay the default', async () => {
  const { h, id } = await setup()
  const full = (await loadBoardDataOp(h.slayDb)).tasks.find((t) => t.id === id)!
  expect(isFullTaskRow(full)).toBe(true)
  const card = (await loadBoardDataOp(h.slayDb, { rows: 'card' })).tasks.find((t) => t.id === id)!
  for (const f of TASK_CARD_OMITTED_FIELDS) expect(f in card, f).toBe(false)
  expect(card).toMatchObject({ id, title: 'a', status: full.status })
  h.cleanup()
})

test('patch rows follow the same choice', async () => {
  const { h, id } = await setup()
  expect(isFullTaskRow((await loadBoardRowsOp(h.slayDb, [id])).tasks[0]!)).toBe(true)
  const card = (await loadBoardRowsOp(h.slayDb, [id], { rows: 'card' })).tasks[0]!
  expect('description' in card).toBe(false)
  h.cleanup()
})

test('a columnar board carries the same rows as columns', async () => {
  const { h, id } = await setup()
  const { boardAsColumns } = await import('./load-board-data.js')
  const { decodeTaskColumns } = await import('@slayzone/task-contracts')
  const board = await loadBoardDataOp(h.slayDb, { rows: 'card' })
  const cols = boardAsColumns(board)
  expect(cols.tasks).toEqual([])
  expect(decodeTaskColumns(cols.taskColumns!)).toEqual(board.tasks)
  expect(decodeTaskColumns(cols.taskColumns!).find((t) => t.id === id)).toBeTruthy()
  h.cleanup()
})
