import type { SlayzoneDb } from '@slayzone/platform'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  initProcessManagerWith,
  createProcess,
  updateProcess,
  killProcess,
  restartProcess,
  listAllProcesses
} from './process-manager'
import { createDbProcessPersistence } from './process-persistence'
import type { PersistedProcess, ProcessPersistence, ProcessRow } from './process-persistence'
import { setProcessBackend } from './process-backend'
import type { ProcessBackend, ProcHandle } from './process-backend'

// One sequential scenario against the process manager's module state; vitest runs
// tests in declaration order, so later tests read the state earlier ones produced.

// Fake persistence: records every call so the create→update→kill lifecycle
// can be asserted without a DB. loadAll seeds one pre-existing row to cover
// hydration on init.
const inserts: PersistedProcess[] = []
const updates: PersistedProcess[] = []
const removes: Array<{ id: string; stillListed: boolean }> = []
const pidUpdates: Array<{ id: string; pid: number | null }> = []
const seededRow: ProcessRow = {
  id: 'seed-1',
  task_id: 'task-9',
  project_id: 'proj-9',
  label: 'seeded',
  command: 'echo seeded',
  cwd: '/tmp',
  auto_restart: 1,
  pid: null
}
// Three shapes of "leftover pid from an uncontrolled previous exit" that
// reapStaleIfNeeded (wired into restartProcess) must tell apart:
const seedMatching: ProcessRow = {
  id: 'seed-match',
  task_id: 'task-9',
  project_id: 'proj-9',
  label: 'still running',
  command: 'echo seeded2',
  cwd: '/tmp',
  auto_restart: 0,
  pid: 4242
}
const seedMismatched: ProcessRow = {
  id: 'seed-mismatch',
  task_id: 'task-9',
  project_id: 'proj-9',
  label: 'pid reused',
  command: 'echo seeded3',
  cwd: '/tmp',
  auto_restart: 0,
  pid: 5555
}
const seedDead: ProcessRow = {
  id: 'seed-dead',
  task_id: 'task-9',
  project_id: 'proj-9',
  label: 'already gone',
  command: 'echo seeded4',
  cwd: '/tmp',
  auto_restart: 0,
  pid: 6666
}
// Set to make insert/update reject, as the database does for a NOT NULL column or a
// project/task that does not exist.
let refuseWrites: Error | null = null
const fake: ProcessPersistence = {
  loadAll: async () => [seededRow, seedMatching, seedMismatched, seedDead],
  insert: async (p) => {
    if (refuseWrites) throw refuseWrites
    inserts.push(p)
  },
  update: async (p) => {
    if (refuseWrites) throw refuseWrites
    updates.push(p)
  },
  remove: async (id) => {
    // Capture in-memory state at persistence time: `processes.delete` must
    // already have run (statement order inside killProcess is load-bearing —
    // the exit handler's auto-restart checks `processes.has`).
    removes.push({ id, stillListed: listAllProcesses().some((p) => p.id === id) })
  },
  updatePid: async (id, pid) => {
    pidUpdates.push({ id, pid })
  },
  recordPid: async () => {},
  listPidHistory: async () => [],
  removePidHistory: async () => {}
}

// Controllable fake backend for the reap scenarios: getCommandLine is driven
// by a mutable map (pid → live command, absent = not alive); killByPid records
// calls and simulates the kill taking effect (clears the map entry).
const reapKillCalls: Array<{ pid: number; sig?: string }> = []
let liveCommandByPid: Record<number, string> = {}
const noopHandle: ProcHandle = {
  pid: undefined,
  onData: () => ({ dispose() {} }),
  onExit: () => ({ dispose() {} }),
  kill: () => {}
}
const reapTestBackend: ProcessBackend = {
  spawn: () => noopHandle,
  getCommandLine: async (pid) => liveCommandByPid[pid] ?? null,
  killByPid: (pid, sig) => {
    reapKillCalls.push({ pid, sig })
    delete liveCommandByPid[pid]
  }
}

describe('process manager lifecycle over the persistence seam', () => {
  // --- loadAll hydration on init ---
  describe('loadAll hydration on init', () => {
    const seeded = (): ReturnType<typeof listAllProcesses>[number] | undefined =>
      listAllProcesses().find((p) => p.id === 'seed-1')

    beforeAll(async () => {
      await initProcessManagerWith(fake)
    })

    test('init hydrates processes from loadAll', () => {
      expect(seeded()).not.toBeUndefined()
    })
    test('hydration maps task_id → taskId', () => {
      expect(seeded()!.taskId).toBe('task-9')
    })
    test('hydration maps project_id → projectId', () => {
      expect(seeded()!.projectId).toBe('proj-9')
    })
    test('hydration keeps label', () => {
      expect(seeded()!.label).toBe('seeded')
    })
    test('hydration keeps command', () => {
      expect(seeded()!.command).toBe('echo seeded')
    })
    test('hydration keeps cwd', () => {
      expect(seeded()!.cwd).toBe('/tmp')
    })
    test('hydration maps auto_restart=1 → true', () => {
      expect(seeded()!.autoRestart).toBe(true)
    })
    test('hydrated processes start stopped', () => {
      expect(seeded()!.status).toBe('stopped')
    })
    test('hydrated processes have no pid', () => {
      expect(seeded()!.pid).toBe(null)
    })
    test('hydration carries a leftover pid through from a previous, uncleanly-terminated run', () => {
      expect(listAllProcesses().find((p) => p.id === 'seed-match')?.pid).toBe(4242)
    })
  })

  // --- reap-on-restart: restartProcess is the real entry point a "start this
  //     again" click hits for a row reloaded at boot (see ProcessDialog.tsx —
  //     an existing process always restarts, only a brand-new one spawns) ---
  describe('reap-on-restart', () => {
    beforeAll(() => {
      setProcessBackend(reapTestBackend)
    })

    test('restartProcess succeeds for a hydrated row', async () => {
      liveCommandByPid = { 4242: 'echo seeded2' } // matches seedMatching.command
      expect(await restartProcess('seed-match')).toBe(true)
    })
    test('a leftover pid whose command line still matches is reaped', () => {
      expect(reapKillCalls.map((c) => c.pid)).toContain(4242)
    })
    test('reaped pid is cleared from the in-memory row', () => {
      expect(listAllProcesses().find((p) => p.id === 'seed-match')?.pid ?? null).toBe(null)
    })
    test('reaped pid is cleared in persistence too', () => {
      expect(pidUpdates).toContainEqual({ id: 'seed-match', pid: null })
    })

    test('a live pid that no longer matches the stored command is left running, not killed', async () => {
      reapKillCalls.length = 0
      liveCommandByPid = { 5555: 'totally-unrelated-process --flag' } // does NOT match seedMismatched.command
      await restartProcess('seed-mismatch')
      expect(reapKillCalls.map((c) => c.pid)).not.toContain(5555)
    })
    test('a mismatched pid is still cleared from our own bookkeeping (it is not ours to track anymore)', () => {
      expect(listAllProcesses().find((p) => p.id === 'seed-mismatch')?.pid ?? null).toBe(null)
    })

    test('a pid that is no longer alive is never sent a kill', async () => {
      liveCommandByPid = {} // 6666 absent → getCommandLine resolves null → "not alive"
      await restartProcess('seed-dead')
      expect(reapKillCalls).toEqual([])
    })
    test('a dead pid is cleared from the in-memory row', () => {
      expect(listAllProcesses().find((p) => p.id === 'seed-dead')?.pid ?? null).toBe(null)
      setProcessBackend(null) // restore localProcessBackend for the rest of the suite
    })
  })

  describe('create / update / kill', () => {
    let id = ''

    // --- create → insert ---
    test('createProcess persists exactly one insert', async () => {
      id = await createProcess('proj-a', 'task-1', 'dev server', 'echo hi', '/tmp', false)
      expect(inserts).toHaveLength(1)
    })
    test('insert receives the full persisted process', () => {
      expect(inserts[0]).toEqual({
        id,
        projectId: 'proj-a',
        taskId: 'task-1',
        label: 'dev server',
        command: 'echo hi',
        cwd: '/tmp',
        autoRestart: false
      })
    })

    // --- update → update (merged in-memory state, not just the patch) ---
    test('updateProcess returns true', async () => {
      expect(await updateProcess(id, { label: 'renamed', autoRestart: true })).toBe(true)
    })
    test('updateProcess persists exactly one update', () => {
      expect(updates).toHaveLength(1)
    })
    test('update receives merged state (patched + untouched fields)', () => {
      expect(updates[0]).toMatchObject({
        id,
        label: 'renamed',
        autoRestart: true,
        command: 'echo hi',
        cwd: '/tmp',
        projectId: 'proj-a',
        taskId: 'task-1'
      })
    })
    test('updateProcess unknown id returns false', async () => {
      expect(await updateProcess('nope', { label: 'x' })).toBe(false)
    })
    test('unknown-id update persists nothing', () => {
      expect(updates).toHaveLength(1)
    })

    // --- a write the database refuses fails the call, never floats (T-102) ---
    describe('a write the database refuses fails the call, never floats (T-102)', () => {
      let listed = 0
      beforeAll(() => {
        refuseWrites = new Error('FOREIGN KEY constraint failed')
        listed = listAllProcesses().length
      })

      test('refused insert: createProcess rejects with the DB error', async () => {
        const createErr = await createProcess('proj-a', 'gone', 'x', 'echo x', '/tmp', false).then(
          () => null,
          (e: unknown) => e
        )
        expect(createErr).toBe(refuseWrites)
      })
      test('refused insert: nothing registered', () => {
        expect(listAllProcesses().length).toBe(listed)
      })
      test('refused update: updateProcess rejects with the DB error', async () => {
        const updateErr = await updateProcess(id, { taskId: 'gone' }).then(
          () => null,
          (e: unknown) => e
        )
        expect(updateErr).toBe(refuseWrites)
      })
      test('refused update: the live record is unchanged', () => {
        expect(listAllProcesses().find((p) => p.id === id)?.taskId).toBe('task-1')
        refuseWrites = null
      })
    })

    // --- a patch sets only the editable fields; undefined leaves one as it is ---
    test('update with non-editable keys answers true', async () => {
      expect(await updateProcess(id, { pid: 1, logBuffer: 'x', label: undefined } as never)).toBe(
        true
      )
    })
    test('pid and logBuffer untouched, undefined label kept', () => {
      const patched = listAllProcesses().find((p) => p.id === id)
      expect(patched?.pid).toBe(null)
      expect(Array.isArray(patched?.logBuffer)).toBe(true)
      expect(patched?.label).toBe('renamed')
    })

    // --- kill → remove (after in-memory delete) ---
    test('killProcess returns true', () => {
      expect(killProcess(id)).toBe(true)
    })
    test('killProcess persists exactly one remove', () => {
      expect(removes.map((r) => r.id)).toEqual([id])
    })
    test('remove fires after processes.delete (order preserved)', () => {
      expect(removes[0].stillListed).toBe(false)
    })
    test('killed process gone from memory', () => {
      expect(listAllProcesses().map((p) => p.id)).not.toContain(id)
    })

    // Hydrated (never-spawned) processes are removable too.
    test('killProcess works on hydrated process', () => {
      expect(killProcess('seed-1')).toBe(true)
    })
    test('hydrated kill persists remove', () => {
      expect(removes.map((r) => r.id)).toEqual([id, 'seed-1'])
    })
  })
})

// --- createDbProcessPersistence: SQL text + placeholder/param order ---
// The adapter is the piece that must stay byte-compatible with the pre-seam
// inline statements; a stub SlayzoneDb records what it would execute.
describe('createDbProcessPersistence', () => {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const dbRows: ProcessRow[] = [
    {
      id: 'r1',
      task_id: null,
      project_id: 'p1',
      label: 'l',
      command: 'c',
      cwd: '/',
      auto_restart: 0,
      pid: null
    }
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
  const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

  test('loadAll returns rows from SELECT', async () => {
    expect(await persistenceOverDb.loadAll()).toBe(dbRows)
  })
  test('loadAll runs the exact pre-seam SELECT', () => {
    expect(calls[0]).toEqual({ sql: 'SELECT * FROM processes ORDER BY created_at', params: [] })
  })

  test('insert runs the exact pre-seam INSERT', async () => {
    await persistenceOverDb.insert(p)
    expect(calls[1].sql).toBe(
      'INSERT INTO processes (id, project_id, task_id, label, command, cwd, auto_restart) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
  })
  test('insert binds params in column order (project_id before task_id, autoRestart→1)', () => {
    expect(calls[1].params).toEqual([
      'the-id',
      'the-project',
      'the-task',
      'the-label',
      'the-cmd',
      '/the/cwd',
      1
    ])
  })

  test('update runs the exact pre-seam UPDATE', async () => {
    await persistenceOverDb.update({ ...p, autoRestart: false })
    expect(squash(calls[2].sql)).toBe(
      'UPDATE processes SET project_id = ?, task_id = ?, label = ?, command = ?, cwd = ?, auto_restart = ? WHERE id = ?'
    )
  })
  test('update binds set-list params then id last (autoRestart→0)', () => {
    expect(calls[2].params).toEqual([
      'the-project',
      'the-task',
      'the-label',
      'the-cmd',
      '/the/cwd',
      0,
      'the-id'
    ])
  })

  test('remove deletes pid history first (no FK cascade to rely on)', async () => {
    await persistenceOverDb.remove('the-id')
    expect(calls[3]).toEqual({
      sql: 'DELETE FROM process_pids WHERE process_id = ?',
      params: ['the-id']
    })
  })
  test('remove then runs the exact pre-seam DELETE on processes', () => {
    expect(calls[4]).toEqual({ sql: 'DELETE FROM processes WHERE id = ?', params: ['the-id'] })
  })

  test('updatePid runs a minimal UPDATE, pid then id', async () => {
    await persistenceOverDb.updatePid('the-id', 4242)
    expect(squash(calls[5].sql)).toBe('UPDATE processes SET pid = ? WHERE id = ?')
    expect(calls[5].params).toEqual([4242, 'the-id'])
  })
  test('updatePid accepts null to clear the pid', async () => {
    await persistenceOverDb.updatePid('the-id', null)
    expect(calls[6].params).toEqual([null, 'the-id'])
  })

  test('recordPid inserts-or-replaces a history row, never overwriting a different pid', async () => {
    await persistenceOverDb.recordPid('the-id', 7777)
    expect(calls[7]).toEqual({
      sql: 'INSERT OR REPLACE INTO process_pids (process_id, pid) VALUES (?, ?)',
      params: ['the-id', 7777]
    })
  })

  test('listPidHistory selects every recorded pid for this row, oldest first', async () => {
    await persistenceOverDb.listPidHistory('the-id')
    expect(calls[8]).toEqual({
      sql: 'SELECT pid, spawned_at as spawnedAt FROM process_pids WHERE process_id = ? ORDER BY spawned_at',
      params: ['the-id']
    })
  })

  test('removePidHistory deletes exactly the one entry, not the whole row', async () => {
    await persistenceOverDb.removePidHistory('the-id', 7777)
    expect(calls[9]).toEqual({
      sql: 'DELETE FROM process_pids WHERE process_id = ? AND pid = ?',
      params: ['the-id', 7777]
    })
  })

  // Sync-throw parity: pre-seam code called db.prepare() synchronously, so a
  // sync prepare throw (sidecar SyncSlayzoneDb on a closed connection) reached
  // the caller synchronously. The adapter must not turn it into a floating
  // rejection.
  test('prepare() throw propagates synchronously (pre-seam parity)', () => {
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
    expect(syncThrew).toBe(true)
  })
})
