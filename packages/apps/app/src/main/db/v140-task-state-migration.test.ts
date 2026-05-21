/**
 * v140 task-intrinsic-state migration tests.
 * Moves viewState.treePinnedTaskIds / treeCollapsedTaskIds and the
 * commit_graph:task:<id> settings keys into tasks columns.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/v140-task-state-migration.test.ts
 */
import Database from 'better-sqlite3'
import { migrations } from './migrations.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (error) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : String(error)}`)
    failed++
  }
}

function expectEqual(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`)
}

/** Build a DB migrated to exactly v139 (pre-v140 schema). */
function dbAtV139(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > 139) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

function applyV140(db: Database.Database): void {
  const v140 = migrations.find((m) => m.version === 140)
  if (!v140) throw new Error('v140 migration not found')
  db.transaction(() => {
    v140.up(db)
    db.pragma('user_version = 140')
  })()
}

function seedTask(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority) VALUES (?, 'p1', ?, 'todo', 3)`
  ).run(id, `Task ${id}`)
}

console.log('\nv140 task-intrinsic-state migration')

test('backfills pinned + pin_order from treePinnedTaskIds array order', () => {
  const db = dbAtV139()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')
    seedTask(db, 't2')
    seedTask(db, 't3')
    db.prepare("INSERT INTO settings (key, value) VALUES ('viewState', ?)").run(
      JSON.stringify({ tabs: [{ type: 'home' }], treePinnedTaskIds: ['t3', 't1'] })
    )

    applyV140(db)

    const rows = db
      .prepare('SELECT id, pinned, pin_order FROM tasks ORDER BY id')
      .all() as Array<{ id: string; pinned: number; pin_order: number }>
    expectEqual(rows, [
      { id: 't1', pinned: 1, pin_order: 1 },
      { id: 't2', pinned: 0, pin_order: 0 },
      { id: 't3', pinned: 1, pin_order: 0 }
    ])
  } finally {
    db.close()
  }
})

test('backfills tree_collapsed from treeCollapsedTaskIds', () => {
  const db = dbAtV139()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')
    seedTask(db, 't2')
    db.prepare("INSERT INTO settings (key, value) VALUES ('viewState', ?)").run(
      JSON.stringify({ treeCollapsedTaskIds: ['t2'] })
    )

    applyV140(db)

    const rows = db
      .prepare('SELECT id, tree_collapsed FROM tasks ORDER BY id')
      .all() as Array<{ id: string; tree_collapsed: number }>
    expectEqual(rows, [
      { id: 't1', tree_collapsed: 0 },
      { id: 't2', tree_collapsed: 1 }
    ])
  } finally {
    db.close()
  }
})

test('backfills commit_graph_config and deletes the per-task settings keys', () => {
  const db = dbAtV139()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')
    const cfg = JSON.stringify({ collapsed: true, showBranches: false })
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('commit_graph:task:t1', cfg)
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      'commit_graph:project:p1',
      JSON.stringify({ collapsed: false })
    )

    applyV140(db)

    const task = db.prepare('SELECT commit_graph_config FROM tasks WHERE id = ?').get('t1') as {
      commit_graph_config: string | null
    }
    expectEqual(task.commit_graph_config, cfg)
    // Per-task key gone; per-project key untouched (separate follow-up).
    const taskKey = db
      .prepare("SELECT 1 FROM settings WHERE key = 'commit_graph:task:t1'")
      .get()
    expectEqual(taskKey, undefined)
    const projKey = db
      .prepare("SELECT value FROM settings WHERE key = 'commit_graph:project:p1'")
      .get() as { value: string } | undefined
    expectEqual(projKey?.value, JSON.stringify({ collapsed: false }))
  } finally {
    db.close()
  }
})

test('strips moved fields from the viewState blob, keeps the rest', () => {
  const db = dbAtV139()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')
    db.prepare("INSERT INTO settings (key, value) VALUES ('viewState', ?)").run(
      JSON.stringify({
        tabs: [{ type: 'home' }],
        activeTabIndex: 0,
        treePinnedTaskIds: ['t1'],
        treeCollapsedTaskIds: ['t1']
      })
    )

    applyV140(db)

    const row = db.prepare("SELECT value FROM settings WHERE key = 'viewState'").get() as {
      value: string
    }
    const parsed = JSON.parse(row.value)
    expectEqual(parsed.treePinnedTaskIds, undefined)
    expectEqual(parsed.treeCollapsedTaskIds, undefined)
    expectEqual(parsed.tabs, [{ type: 'home' }])
    expectEqual(parsed.activeTabIndex, 0)
  } finally {
    db.close()
  }
})

test('no viewState row → columns stay at defaults', () => {
  const db = dbAtV139()
  try {
    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
    seedTask(db, 't1')

    applyV140(db)

    const row = db
      .prepare('SELECT pinned, pin_order, tree_collapsed, commit_graph_config FROM tasks WHERE id = ?')
      .get('t1') as {
      pinned: number
      pin_order: number
      tree_collapsed: number
      commit_graph_config: string | null
    }
    expectEqual(row, { pinned: 0, pin_order: 0, tree_collapsed: 0, commit_graph_config: null })
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
