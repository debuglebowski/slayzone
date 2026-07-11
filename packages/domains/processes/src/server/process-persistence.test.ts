import type { SlayzoneDb } from '@slayzone/platform'
import {
  initProcessManagerWith,
  createProcess,
  updateProcess,
  killProcess,
  listAllProcesses
} from './process-manager'
import { createDbProcessPersistence } from './process-persistence'
import type { PersistedProcess, ProcessPersistence, ProcessRow } from './process-persistence'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// Fake persistence: records every call so the create→update→kill lifecycle
// can be asserted without a DB. loadAll seeds one pre-existing row to cover
// hydration on init.
const inserts: PersistedProcess[] = []
const updates: PersistedProcess[] = []
const removes: Array<{ id: string; stillListed: boolean }> = []
const seededRow: ProcessRow = {
  id: 'seed-1',
  task_id: 'task-9',
  project_id: 'proj-9',
  label: 'seeded',
  command: 'echo seeded',
  cwd: '/tmp',
  auto_restart: 1
}
const fake: ProcessPersistence = {
  loadAll: async () => [seededRow],
  insert: async (p) => {
    inserts.push(p)
  },
  update: async (p) => {
    updates.push(p)
  },
  remove: async (id) => {
    // Capture in-memory state at persistence time: `processes.delete` must
    // already have run (statement order inside killProcess is load-bearing —
    // the exit handler's auto-restart checks `processes.has`).
    removes.push({ id, stillListed: listAllProcesses().some((p) => p.id === id) })
  }
}

async function main(): Promise<void> {
  // --- loadAll hydration on init ---
  await initProcessManagerWith(fake)
  const seeded = listAllProcesses().find((p) => p.id === 'seed-1')
  assert(seeded !== undefined, 'init hydrates processes from loadAll')
  assert(seeded!.taskId === 'task-9', 'hydration maps task_id → taskId')
  assert(seeded!.projectId === 'proj-9', 'hydration maps project_id → projectId')
  assert(seeded!.label === 'seeded', 'hydration keeps label')
  assert(seeded!.command === 'echo seeded', 'hydration keeps command')
  assert(seeded!.cwd === '/tmp', 'hydration keeps cwd')
  assert(seeded!.autoRestart === true, 'hydration maps auto_restart=1 → true')
  assert(seeded!.status === 'stopped', 'hydrated processes start stopped')
  assert(seeded!.pid === null, 'hydrated processes have no pid')

  // --- create → insert ---
  const id = createProcess('proj-a', 'task-1', 'dev server', 'echo hi', '/tmp', false)
  assert(inserts.length === 1, 'createProcess persists exactly one insert')
  const ins = inserts[0]
  assert(
    ins.id === id &&
      ins.projectId === 'proj-a' &&
      ins.taskId === 'task-1' &&
      ins.label === 'dev server' &&
      ins.command === 'echo hi' &&
      ins.cwd === '/tmp' &&
      ins.autoRestart === false,
    'insert receives the full persisted process'
  )

  // --- update → update (merged in-memory state, not just the patch) ---
  assert(updateProcess(id, { label: 'renamed', autoRestart: true }), 'updateProcess returns true')
  assert(updates.length === 1, 'updateProcess persists exactly one update')
  const upd = updates[0]
  assert(
    upd.id === id &&
      upd.label === 'renamed' &&
      upd.autoRestart === true &&
      upd.command === 'echo hi' &&
      upd.cwd === '/tmp' &&
      upd.projectId === 'proj-a' &&
      upd.taskId === 'task-1',
    'update receives merged state (patched + untouched fields)'
  )
  assert(!updateProcess('nope', { label: 'x' }), 'updateProcess unknown id returns false')
  assert(updates.length === 1, 'unknown-id update persists nothing')

  // --- kill → remove (after in-memory delete) ---
  assert(killProcess(id), 'killProcess returns true')
  assert(removes.length === 1 && removes[0].id === id, 'killProcess persists exactly one remove')
  assert(!removes[0].stillListed, 'remove fires after processes.delete (order preserved)')
  assert(
    listAllProcesses().every((p) => p.id !== id),
    'killed process gone from memory'
  )

  // Hydrated (never-spawned) processes are removable too.
  assert(killProcess('seed-1'), 'killProcess works on hydrated process')
  assert(removes.length === 2 && removes[1].id === 'seed-1', 'hydrated kill persists remove')

  await testDbAdapter()

  console.log('process-persistence seam: all passed')
  process.exit(0)
}

// --- createDbProcessPersistence: SQL text + placeholder/param order ---
// The adapter is the piece that must stay byte-compatible with the pre-seam
// inline statements; a stub SlayzoneDb records what it would execute.
async function testDbAdapter(): Promise<void> {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const dbRows: ProcessRow[] = [
    { id: 'r1', task_id: null, project_id: 'p1', label: 'l', command: 'c', cwd: '/', auto_restart: 0 }
  ]
  const stubDb = {
    prepare(sql: string) {
      return {
        get: async () => undefined,
        all: async (...params: unknown[]) => {
          calls.push({ sql, params })
          return dbRows
        },
        run: async (...params: unknown[]) => {
          calls.push({ sql, params })
          return { changes: 1, lastInsertRowid: 1 }
        }
      }
    }
  } as unknown as SlayzoneDb
  const persistenceOverDb = createDbProcessPersistence(stubDb)

  const p: PersistedProcess = {
    id: 'the-id',
    taskId: 'the-task',
    projectId: 'the-project',
    label: 'the-label',
    command: 'the-cmd',
    cwd: '/the/cwd',
    autoRestart: true
  }

  assert((await persistenceOverDb.loadAll()) === dbRows, 'loadAll returns rows from SELECT')
  assert(
    calls[0].sql === 'SELECT * FROM processes ORDER BY created_at' && calls[0].params.length === 0,
    'loadAll runs the exact pre-seam SELECT'
  )

  await persistenceOverDb.insert(p)
  assert(
    calls[1].sql ===
      'INSERT INTO processes (id, project_id, task_id, label, command, cwd, auto_restart) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'insert runs the exact pre-seam INSERT'
  )
  assert(
    JSON.stringify(calls[1].params) ===
      JSON.stringify(['the-id', 'the-project', 'the-task', 'the-label', 'the-cmd', '/the/cwd', 1]),
    'insert binds params in column order (project_id before task_id, autoRestart→1)'
  )

  await persistenceOverDb.update({ ...p, autoRestart: false })
  assert(
    calls[2].sql.replace(/\s+/g, ' ').trim() ===
      'UPDATE processes SET project_id = ?, task_id = ?, label = ?, command = ?, cwd = ?, auto_restart = ? WHERE id = ?',
    'update runs the exact pre-seam UPDATE'
  )
  assert(
    JSON.stringify(calls[2].params) ===
      JSON.stringify(['the-project', 'the-task', 'the-label', 'the-cmd', '/the/cwd', 0, 'the-id']),
    'update binds set-list params then id last (autoRestart→0)'
  )

  await persistenceOverDb.remove('the-id')
  assert(
    calls[3].sql === 'DELETE FROM processes WHERE id = ?' &&
      JSON.stringify(calls[3].params) === JSON.stringify(['the-id']),
    'remove runs the exact pre-seam DELETE'
  )

  // Sync-throw parity: pre-seam code called db.prepare() synchronously, so a
  // sync prepare throw (sidecar SyncSlayzoneDb on a closed connection) reached
  // the caller synchronously. The adapter must not turn it into a floating
  // rejection.
  const throwingDb = {
    prepare(): never {
      throw new Error('prepare boom')
    }
  } as unknown as SlayzoneDb
  const throwing = createDbProcessPersistence(throwingDb)
  let syncThrew = false
  try {
    void throwing.insert(p)
  } catch {
    syncThrew = true
  }
  assert(syncThrew, 'prepare() throw propagates synchronously (pre-seam parity)')
}

void main()
