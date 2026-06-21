/**
 * Project-group ordering txn tests — pure better-sqlite3, no electron.
 * Exercises the shared top-level sort_order space (ungrouped projects + groups)
 * and within-group ordering directly against the worker-safe named txns.
 *
 * Run with: npx tsx packages/domains/projects/src/main/project-groups-txns.test.ts
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { projectsTxns } from './projects-txns.js'

// projectsTxns entries are typed with `params: never` (satisfies guard) — cast
// to a plain callable map for direct invocation in tests.
const txn = projectsTxns as unknown as Record<
  string,
  (db: Database.Database, p: unknown) => { projects: Record<string, unknown>[]; groups: Record<string, unknown>[] }
>

async function freshDb(): Promise<Database.Database> {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const migrationsPath = path.resolve(
    import.meta.dirname,
    // Canonical schema moved out of apps/app/src/main/db in the Wave C2 split.
    '../../../../shared/transport/src/db-bootstrap/migrations.ts'
  )
  const mod = await import(migrationsPath)
  mod.runMigrations(db)
  return db
}

function addProject(db: Database.Database, id: string, sortOrder: number): void {
  db.prepare(
    'INSERT INTO projects (id, name, color, sort_order, group_id) VALUES (?, ?, ?, ?, NULL)'
  ).run(id, id.toUpperCase(), '#112233', sortOrder)
}

const order = (db: Database.Database, id: string): number =>
  (db.prepare('SELECT sort_order FROM projects WHERE id = ?').get(id) as { sort_order: number })
    .sort_order
const groupOf = (db: Database.Database, id: string): string | null =>
  (db.prepare('SELECT group_id FROM projects WHERE id = ?').get(id) as { group_id: string | null })
    .group_id
const gOrder = (db: Database.Database, id: string): number =>
  (db.prepare('SELECT sort_order FROM project_groups WHERE id = ?').get(id) as {
    sort_order: number
  }).sort_order

await describe('project-groups: create', async () => {
  const db = await freshDb()
  addProject(db, 'a', 0)
  addProject(db, 'b', 1)
  addProject(db, 'c', 2)

  test('appends group after the last top-level slot', () => {
    txn['project-groups:create'](db, { id: 'g1', name: 'Work', createdAt: 'now', updatedAt: 'now' })
    expect(gOrder(db, 'g1')).toBe(3)
  })
})

await describe('project-groups: moveProject in/out + within', async () => {
  const db = await freshDb()
  addProject(db, 'a', 0)
  addProject(db, 'b', 1)
  addProject(db, 'c', 2)
  txn['project-groups:create'](db, { id: 'g1', name: '', createdAt: 'now', updatedAt: 'now' }) // g1 @ 3

  test('move A into G1 → A grouped @0; top-level re-packs (B,C,G1 → 0,1,2)', () => {
    txn['project-groups:moveProject'](db, { projectId: 'a', groupId: 'g1', targetIndex: 0 })
    expect(groupOf(db, 'a')).toBe('g1')
    expect(order(db, 'a')).toBe(0)
    expect(order(db, 'b')).toBe(0)
    expect(order(db, 'c')).toBe(1)
    expect(gOrder(db, 'g1')).toBe(2)
  })

  test('move B into G1 @1 → members A,B = 0,1; top-level C,G1 = 0,1', () => {
    txn['project-groups:moveProject'](db, { projectId: 'b', groupId: 'g1', targetIndex: 1 })
    expect(order(db, 'a')).toBe(0)
    expect(order(db, 'b')).toBe(1)
    expect(order(db, 'c')).toBe(0)
    expect(gOrder(db, 'g1')).toBe(1)
  })

  test('reorderWithin G1 [b,a] → b=0, a=1', () => {
    txn['project-groups:reorderWithin'](db, { groupId: 'g1', projectIds: ['b', 'a'] })
    expect(order(db, 'b')).toBe(0)
    expect(order(db, 'a')).toBe(1)
  })

  test('move A out to top-level @0 → A ungrouped @0; G1 repacks to [b]@0', () => {
    txn['project-groups:moveProject'](db, { projectId: 'a', groupId: null, targetIndex: 0 })
    expect(groupOf(db, 'a')).toBeNull()
    expect(order(db, 'a')).toBe(0)
    expect(order(db, 'c')).toBe(1)
    expect(gOrder(db, 'g1')).toBe(2)
    expect(groupOf(db, 'b')).toBe('g1')
    expect(order(db, 'b')).toBe(0)
  })

  test('delete G1 → member B drops to group former slot, order preserved', () => {
    txn['project-groups:delete'](db, { id: 'g1' })
    expect(groupOf(db, 'b')).toBeNull()
    // top-level was [A@0, C@1, G1@2] with G1→[B] → [A,C,B] = 0,1,2
    expect(order(db, 'a')).toBe(0)
    expect(order(db, 'c')).toBe(1)
    expect(order(db, 'b')).toBe(2)
    const groups = db.prepare('SELECT COUNT(*) AS n FROM project_groups').get() as { n: number }
    expect(groups.n).toBe(0)
  })
})

await describe('project-groups: createWith (Discord drag-onto)', async () => {
  const db = await freshDb()
  addProject(db, 'a', 0)
  addProject(db, 'b', 1)
  addProject(db, 'c', 2)

  test('folder takes target slot; members [b,a]; c re-packs', () => {
    // drop A onto B → folder [B, A] at B's slot
    txn['project-groups:createWith'](db, {
      id: 'g1',
      name: '',
      createdAt: 'now',
      updatedAt: 'now',
      projectIds: ['b', 'a']
    })
    expect(groupOf(db, 'a')).toBe('g1')
    expect(groupOf(db, 'b')).toBe('g1')
    expect(order(db, 'b')).toBe(0)
    expect(order(db, 'a')).toBe(1)
    // top level was [a@0, b@1, c@2]; members removed, group at first member (a) slot
    // → [g1, c] = 0,1
    expect(gOrder(db, 'g1')).toBe(0)
    expect(order(db, 'c')).toBe(1)
  })
})

await describe('project-groups: reorderTopLevel interleaves projects + groups', async () => {
  const db = await freshDb()
  addProject(db, 'a', 0)
  addProject(db, 'b', 1)
  txn['project-groups:create'](db, { id: 'g1', name: '', createdAt: 'now', updatedAt: 'now' }) // @2

  test('explicit interleaved order is written verbatim', () => {
    txn['project-groups:reorderTopLevel'](db, {
      entries: [
        { kind: 'group', id: 'g1' },
        { kind: 'project', id: 'b' },
        { kind: 'project', id: 'a' }
      ]
    })
    expect(gOrder(db, 'g1')).toBe(0)
    expect(order(db, 'b')).toBe(1)
    expect(order(db, 'a')).toBe(2)
  })
})
