/**
 * Machines — the physical boxes computers sit on.
 *
 * A computer is one OS user's environment; a machine is the hardware several of
 * them can share. The only thing a machine does is GROUP, so everything here is
 * shaped by that: it is cosmetic, it must never be able to break execution, and
 * nothing outside it may hold a reference to a machine.
 *
 * `computers.host_id` is a mutable attribute reported by the computer itself (see
 * `computer/host-id.ts`), so it CHANGES: a computer that adopts a peer's id while
 * offline reports the new value on its next connect. Three cases follow, and the
 * difference between them is only ever "does the old machine still have anyone on
 * it, and is anybody already at the new id":
 *
 *   MOVE       — it was the machine's only computer and nothing sits at the new id.
 *                Move the machine row itself, so a name the user typed follows its
 *                computer rather than being stranded on an empty box.
 *   MERGE      — it was the only one AND a machine already exists at the new id.
 *                Two rows are one box; collapse them, keeping the named one.
 *   RE-PARENT  — siblings remain on the old machine. Leave it alone and attach to
 *                (or create) the machine at the new id.
 *
 * The steady state — a computer reporting the id it already had — writes NOTHING.
 * This runs on every connect, so the common path stays a read, the same discipline
 * `retireStaleLocalComputers` uses.
 *
 * @module computers/server/machines
 */

import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'

export interface MachineRecord {
  id: string
  host_id: string
  name: string | null
  created_at: number
  updated_at: number
}

/**
 * Which of two machine rows survives a merge.
 *
 * A NAME is the only thing on a machine a user authored, so a named row always
 * beats an unnamed one — losing the name is the only outcome here anyone would
 * notice. With both named (or neither) the older row wins: it is the one whose id
 * has been around longer, so keeping it invalidates less.
 *
 * Pure and total, so the rule can be tested without a database.
 */
export function pickMachineWinner<
  T extends { name: string | null; created_at: number; id: string }
>(a: T, b: T): { winner: T; loser: T } {
  const aNamed = a.name !== null && a.name !== ''
  const bNamed = b.name !== null && b.name !== ''
  if (aNamed !== bNamed) return aNamed ? { winner: a, loser: b } : { winner: b, loser: a }
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? { winner: a, loser: b } : { winner: b, loser: a }
  }
  // Same instant: fall back to id order so the choice is deterministic rather
  // than dependent on row order.
  return a.id < b.id ? { winner: a, loser: b } : { winner: b, loser: a }
}

async function machineByHostId(db: SlayzoneDb, hostId: string): Promise<MachineRecord | null> {
  return (await db.get<MachineRecord>(`SELECT * FROM machines WHERE host_id = ?`, [hostId])) ?? null
}

/**
 * Record which machine a computer is on, moving/merging/re-parenting as needed.
 *
 * Called on enroll AND on hello — hello is not optional. A computer that adopted a
 * peer's host id while it was offline reports the new value on reconnect, and that
 * reconnect is the only moment the hub can learn it. Deliberately NOT on heartbeat:
 * the id changes at most hourly and a per-heartbeat check would be a write-probe
 * per computer every 15s for cosmetic data.
 *
 * Returns the machine this computer now belongs to.
 */
export async function reconcileMachineForComputer(
  db: SlayzoneDb,
  opts: { computerId: string; hostId: string; now?: number }
): Promise<{ machineId: string }> {
  const now = opts.now ?? Date.now()
  const prevRow = await db.get<{ host_id: string | null }>(
    `SELECT host_id FROM computers WHERE id = ?`,
    [opts.computerId]
  )
  const prev = prevRow?.host_id ?? null

  // ── Steady state: no writes at all. ───────────────────────────────────────
  if (prev === opts.hostId) {
    const existing = await machineByHostId(db, opts.hostId)
    if (existing) return { machineId: existing.id }
    // The column agrees but the machine row is missing (a hand-edited DB, or a
    // row deleted out from under us). Fall through and create it.
  }

  const target = await machineByHostId(db, opts.hostId)
  const siblings = prev
    ? ((
        await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM computers WHERE host_id = ? AND id <> ?`,
          [prev, opts.computerId]
        )
      )?.n ?? 0)
    : 0

  // MOVE — sole occupant, nobody at the destination. The machine (and its name)
  // travels with the computer instead of being abandoned.
  if (prev && prev !== opts.hostId && siblings === 0 && !target) {
    await db.batchTxn([
      {
        type: 'run',
        sql: `UPDATE computers SET host_id = ? WHERE id = ?`,
        params: [opts.hostId, opts.computerId]
      },
      {
        type: 'run',
        sql: `UPDATE machines SET host_id = ?, updated_at = ? WHERE host_id = ?`,
        params: [opts.hostId, now, prev]
      }
    ])
    const moved = await machineByHostId(db, opts.hostId)
    if (moved) return { machineId: moved.id }
  }

  // MERGE — the computer was the last one on its old machine and something already
  // occupies the new id, so those two rows describe one box. The survivor must end
  // up holding the NEW host id, because that is what every computer now reports.
  if (prev && prev !== opts.hostId && siblings === 0 && target) {
    const old = await machineByHostId(db, prev)
    if (old) {
      const { winner, loser } = pickMachineWinner(old, target)
      const ops: Parameters<SlayzoneDb['batchTxn']>[0] = [
        {
          type: 'run',
          sql: `UPDATE computers SET host_id = ? WHERE id = ?`,
          params: [opts.hostId, opts.computerId]
        },
        // Delete first: `host_id` is UNIQUE, so the survivor cannot take the new
        // id while the loser still holds it.
        { type: 'run', sql: `DELETE FROM machines WHERE id = ?`, params: [loser.id] }
      ]
      if (winner.id === old.id) {
        // The old row won, so it moves to the new host id and keeps its name.
        ops.push({
          type: 'run',
          sql: `UPDATE machines SET host_id = ?, updated_at = ? WHERE id = ?`,
          params: [opts.hostId, now, winner.id]
        })
      } else if (old.name) {
        // The target won but is unnamed — carry the name across rather than lose
        // the one thing on either row a user authored.
        ops.push({
          type: 'run',
          sql: `UPDATE machines SET name = COALESCE(name, ?), updated_at = ? WHERE id = ?`,
          params: [old.name, now, winner.id]
        })
      }
      await db.batchTxn(ops)
      return { machineId: winner.id }
    }
  }

  // RE-PARENT (or first sighting): attach to the machine at the new id, creating
  // it when nobody has been there yet. The old machine keeps its siblings.
  const machineId = target?.id ?? randomUUID()
  const ops: Parameters<SlayzoneDb['batchTxn']>[0] = [
    {
      type: 'run',
      sql: `UPDATE computers SET host_id = ? WHERE id = ?`,
      params: [opts.hostId, opts.computerId]
    }
  ]
  if (!target) {
    ops.push({
      type: 'run',
      sql: `INSERT OR IGNORE INTO machines (id, host_id, name, created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?)`,
      params: [machineId, opts.hostId, now, now]
    })
  }
  await db.batchTxn(ops)
  const settled = await machineByHostId(db, opts.hostId)
  return { machineId: settled?.id ?? machineId }
}

/**
 * Drop a machine that has no computers left AND no name.
 *
 * A NAMED empty machine is kept on purpose: the user typed that name, and a box
 * whose computer was deleted is exactly the one they are most likely to re-enroll.
 * The no-empty-machines rule is about MERGES — two rows for one box — not about a
 * machine that is simply unoccupied right now.
 */
export async function pruneAnonymousEmptyMachines(db: SlayzoneDb): Promise<number> {
  const res = await db.run(
    `DELETE FROM machines
      WHERE name IS NULL
        AND NOT EXISTS (SELECT 1 FROM computers c WHERE c.host_id = machines.host_id)`
  )
  return (res as { changes?: number })?.changes ?? 0
}

/** Rename a machine, keyed by HOST ID — never by machine id. A merge between the
 *  render and the click would destroy the id the client was holding; the host id
 *  survives on the winner. `null` clears the name. */
export async function renameMachine(
  db: SlayzoneDb,
  hostId: string,
  name: string | null
): Promise<void> {
  await db.run(`UPDATE machines SET name = ?, updated_at = ? WHERE host_id = ?`, [
    name,
    Date.now(),
    hostId
  ])
}

/** Every machine, keyed by host id — one query to decorate a whole computer list. */
export async function machinesByHostId(db: SlayzoneDb): Promise<Map<string, MachineRecord>> {
  const rows = await db.all<MachineRecord>(`SELECT * FROM machines`)
  return new Map(rows.map((m) => [m.host_id, m]))
}
