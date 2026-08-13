import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  pickMachineWinner,
  pruneAnonymousEmptyMachines,
  reconcileMachineForComputer,
  renameMachine,
  type MachineRecord
} from './machines'
import { registerComputer } from './store'
import { createMigratedDb, type TestDb } from './test-db'

let t: TestDb
beforeEach(() => {
  t = createMigratedDb()
})
afterEach(() => t.close())

const mk = (over: Partial<MachineRecord> = {}): MachineRecord => ({
  id: 'm',
  host_id: 'h',
  name: null,
  created_at: 100,
  updated_at: 100,
  ...over
})

describe('pickMachineWinner', () => {
  // The name is the only thing on a machine a user authored — losing it is the
  // only merge outcome anyone would actually notice.
  it('prefers the named row regardless of age', () => {
    const named = mk({ id: 'a', name: 'Home mini', created_at: 999 })
    const anon = mk({ id: 'b', name: null, created_at: 1 })
    expect(pickMachineWinner(named, anon).winner.id).toBe('a')
    expect(pickMachineWinner(anon, named).winner.id).toBe('a')
  })

  it('falls back to the older row when both are named', () => {
    const older = mk({ id: 'a', name: 'A', created_at: 1 })
    const newer = mk({ id: 'b', name: 'B', created_at: 2 })
    expect(pickMachineWinner(newer, older).winner.id).toBe('a')
  })

  it('is deterministic when both are anonymous and same-aged', () => {
    const a = mk({ id: 'a' })
    const b = mk({ id: 'b' })
    expect(pickMachineWinner(a, b).winner.id).toBe(pickMachineWinner(b, a).winner.id)
  })
})

async function addComputer(name: string): Promise<string> {
  const r = await registerComputer(t.db, { name, platform: 'darwin-arm64', version: '0.36.0' })
  return r.id
}

describe('reconcileMachineForComputer', () => {
  it('creates a machine on first sighting', async () => {
    const c = await addComputer('one')
    const { machineId } = await reconcileMachineForComputer(t.db, { computerId: c, hostId: 'h1' })
    const row = await t.db.get<MachineRecord>(`SELECT * FROM machines WHERE id = ?`, [machineId])
    expect(row?.host_id).toBe('h1')
    expect(row?.name).toBeNull()
  })

  it('groups a second computer onto the same machine', async () => {
    const a = await addComputer('a')
    const b = await addComputer('b')
    const first = await reconcileMachineForComputer(t.db, { computerId: a, hostId: 'h1' })
    const second = await reconcileMachineForComputer(t.db, { computerId: b, hostId: 'h1' })
    expect(second.machineId).toBe(first.machineId)
    const count = await t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM machines`)
    expect(count?.n).toBe(1)
  })

  // The common path runs on every connect, so it must not write.
  it('is a no-op when the reported id is unchanged', async () => {
    const c = await addComputer('one')
    await reconcileMachineForComputer(t.db, { computerId: c, hostId: 'h1', now: 100 })
    await reconcileMachineForComputer(t.db, { computerId: c, hostId: 'h1', now: 999 })
    const row = await t.db.get<MachineRecord>(`SELECT * FROM machines WHERE host_id = 'h1'`)
    expect(row?.updated_at).toBe(100)
  })

  // MOVE: a name the user typed follows its only computer instead of being
  // stranded on a box nothing is on any more.
  it('moves the machine — and its name — when its only computer changes id', async () => {
    const c = await addComputer('one')
    await reconcileMachineForComputer(t.db, { computerId: c, hostId: 'h1' })
    await renameMachine(t.db, 'h1', 'Home mini')

    const { machineId } = await reconcileMachineForComputer(t.db, { computerId: c, hostId: 'h2' })
    const row = await t.db.get<MachineRecord>(`SELECT * FROM machines WHERE id = ?`, [machineId])
    expect(row?.host_id).toBe('h2')
    expect(row?.name).toBe('Home mini')
    const count = await t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM machines`)
    expect(count?.n).toBe(1)
  })

  // RE-PARENT: siblings remain, so the old machine stays and a new one appears.
  it('re-parents without disturbing the old machine when siblings remain', async () => {
    const a = await addComputer('a')
    const b = await addComputer('b')
    await reconcileMachineForComputer(t.db, { computerId: a, hostId: 'h1' })
    await reconcileMachineForComputer(t.db, { computerId: b, hostId: 'h1' })

    await reconcileMachineForComputer(t.db, { computerId: b, hostId: 'h2' })
    const hosts = (
      await t.db.all<{ host_id: string }>(`SELECT host_id FROM machines ORDER BY host_id`)
    ).map((r) => r.host_id)
    expect(hosts).toEqual(['h1', 'h2'])
  })

  // MERGE: the convergence case. Two rows turn out to be one box; the named row
  // survives and ends up holding the id everyone now reports.
  it('merges two machines into the named one, at the new host id', async () => {
    const a = await addComputer('a')
    const b = await addComputer('b')
    await reconcileMachineForComputer(t.db, { computerId: a, hostId: 'h1' })
    await renameMachine(t.db, 'h1', 'The box')
    await reconcileMachineForComputer(t.db, { computerId: b, hostId: 'h2' })

    // `a` adopts h2 — it was alone on h1, and h2 already exists.
    const { machineId } = await reconcileMachineForComputer(t.db, { computerId: a, hostId: 'h2' })
    const rows = await t.db.all<MachineRecord>(`SELECT * FROM machines`)
    expect(rows.length).toBe(1)
    expect(rows[0].host_id).toBe('h2')
    expect(rows[0].name).toBe('The box')
    expect(rows[0].id).toBe(machineId)
  })

  it('carries a name onto the surviving row when the winner is unnamed', async () => {
    const a = await addComputer('a')
    const b = await addComputer('b')
    // b's machine is OLDER, so it wins on age — but a's carries the name.
    await reconcileMachineForComputer(t.db, { computerId: b, hostId: 'h2', now: 1 })
    await reconcileMachineForComputer(t.db, { computerId: a, hostId: 'h1', now: 5 })
    await renameMachine(t.db, 'h1', 'Named')

    await reconcileMachineForComputer(t.db, { computerId: a, hostId: 'h2' })
    const rows = await t.db.all<MachineRecord>(`SELECT * FROM machines`)
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Named')
  })
})

describe('pruneAnonymousEmptyMachines', () => {
  // A named empty machine is kept: the user typed that name, and an emptied box is
  // exactly the one they are most likely to re-enroll.
  it('drops anonymous empties and keeps named ones', async () => {
    const c = await addComputer('one')
    await reconcileMachineForComputer(t.db, { computerId: c, hostId: 'h1' })
    await reconcileMachineForComputer(t.db, { computerId: c, hostId: 'h2' })
    await renameMachine(t.db, 'h2', 'Kept')
    // Strand both: h1 was vacated by the move, h2 loses its computer.
    await t.db.run(`UPDATE computers SET host_id = NULL WHERE id = ?`, [c])
    await t.db.run(
      `INSERT INTO machines (id, host_id, name, created_at, updated_at) VALUES ('anon','h9',NULL,1,1)`
    )

    await pruneAnonymousEmptyMachines(t.db)
    const hosts = (
      await t.db.all<{ host_id: string }>(`SELECT host_id FROM machines ORDER BY host_id`)
    ).map((r) => r.host_id)
    expect(hosts).toEqual(['h2'])
  })
})
