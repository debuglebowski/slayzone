/**
 * Every hub table that holds a project's or a task's rows is classified for a move
 * between hubs: carried (`TASK_MOVE_TABLES`, `PROJECT_MOVE_TABLES`) or left behind with
 * a reason (`MOVE_DROPPED_TABLES`). A table added later with a `project_id`, `task_id`
 * or `tab_id` column fails here by name until someone decides — so a move never
 * silently leaves data behind.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/move-tables-classified.test.ts
 */
import { expect, test } from 'vitest'
import {
  MOVE_DROPPED_TABLES,
  PROJECT_MOVE_TABLES,
  TASK_MOVE_TABLES
} from '@slayzone/task-contracts'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'

const OWNING_COLUMNS = ['project_id', 'task_id', 'tab_id']

test('every table holding project or task rows is carried or left behind on purpose', async () => {
  const H = await createTestHarness()
  const db = H.db
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((t) => t.name)
  const owning = tables.filter((name) => {
    if (name.startsWith('content_erasure_')) return false
    const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    return name === 'tasks' || name === 'projects' || cols.some((c) => OWNING_COLUMNS.includes(c))
  })
  const carried = new Set<string>([...TASK_MOVE_TABLES, ...PROJECT_MOVE_TABLES])
  const unclassified = owning.filter((t) => !carried.has(t) && !(t in MOVE_DROPPED_TABLES))
  expect(unclassified).toEqual([])
  // No table is both carried and dropped, and no entry names a table that is gone.
  expect(Object.keys(MOVE_DROPPED_TABLES).filter((t) => carried.has(t))).toEqual([])
  expect(Object.keys(MOVE_DROPPED_TABLES).filter((t) => !tables.includes(t))).toEqual([])
})
