/**
 * Needs attention (P3): what a pass could not process, one item at a time.
 *
 * - The hub's own ledger (`item_faults`, origin 'hub') and quarantine
 *   (`<dataRoot>/quarantine`): backup pins, rotation, erasure fan-out, project sync…
 * - Each computer's own ledger + quarantine, pulled with the `faults.list` chat
 *   request. The pulled snapshot REPLACES the computer's mirror rows (origin
 *   'computer') — never merged, so the copy cannot drift; it only lets task badges
 *   show while the computer is offline. Retry/Discard always go to the computer.
 */
import { existsSync } from 'node:fs'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ItemFaultRow } from '@slayzone/platform/isolation'
import { discardQuarantine, listQuarantine, restoreQuarantine } from '@slayzone/platform/quarantine'
import type { ComputerFaultSnapshot, ItemFaultRef, ItemFaultView } from '@slayzone/computers/shared'

export interface ItemFaultServiceDeps {
  db: SlayzoneDb
  /** A `chatRequest` to the computer (`faults.list` / `faults.retry` / `faults.discard`). */
  requestComputer(computerId: string, value: Record<string, unknown>): Promise<unknown>
  isConnected(computerId: string): boolean
}

const fromRow = (row: ItemFaultRow, live: boolean): ItemFaultView => ({
  computerId: row.computer_id || null,
  origin: row.origin,
  source: row.item_key.startsWith('quarantine:') ? 'quarantine' : 'ledger',
  pass: row.pass,
  key: row.item_key.startsWith('quarantine:') ? row.item_key.slice(11) : row.item_key,
  taskId: row.task_id,
  kind: row.kind,
  message: row.message,
  attempts: row.attempts,
  firstAt: row.first_at,
  lastAt: row.last_at,
  retryable: live,
  discardable: false
})

export function createItemFaultService(deps: ItemFaultServiceDeps) {
  const { db } = deps

  /** Pulls a connected computer's faults and replaces its mirror rows. */
  async function refreshComputer(computerId: string): Promise<ItemFaultView[]> {
    const snapshot = (await deps.requestComputer(computerId, {
      kind: 'faults.list'
    })) as ComputerFaultSnapshot
    const faults = Array.isArray(snapshot?.faults) ? snapshot.faults : []
    await db.batchTxn([
      {
        type: 'run',
        sql: "DELETE FROM item_faults WHERE origin='computer' AND computer_id=?",
        params: [computerId]
      },
      // An erased task's fault is not mirrored (its erasure fence would abort the batch).
      ...faults.map((f) => ({
        type: 'run' as const,
        sql: `INSERT OR REPLACE INTO item_faults(origin,computer_id,pass,item_key,task_id,kind,fingerprint,message,attempts,first_at,last_at,next_retry_at)
          SELECT 'computer',?,?,?,?,?,NULL,?,?,?,?,NULL
          WHERE ? IS NULL OR NOT EXISTS(SELECT 1 FROM content_erasure_tasks WHERE task_id=?)`,
        params: [
          computerId,
          f.pass,
          f.source === 'quarantine' ? `quarantine:${f.key}` : f.key,
          f.taskId,
          f.kind,
          f.message.slice(0, 2_000),
          f.attempts,
          f.firstAt,
          f.lastAt,
          f.taskId,
          f.taskId
        ]
      }))
    ])
    return faults.map((f) => ({ ...f, computerId, origin: 'computer' as const }))
  }

  async function hubRows(computerId: string | null): Promise<ItemFaultView[]> {
    const rows = await db.all<ItemFaultRow>(
      "SELECT * FROM item_faults WHERE origin='hub' AND computer_id=? ORDER BY last_at DESC",
      [computerId ?? '']
    )
    return rows.map((row) => fromRow(row, true))
  }

  function hubQuarantine(dataRoot: string): ItemFaultView[] {
    return listQuarantine(dataRoot).map((entry) => ({
      computerId: null,
      origin: 'hub',
      source: 'quarantine',
      pass: entry.pass,
      key: entry.id,
      taskId: entry.meta?.taskId ?? null,
      kind: 'structural',
      message: entry.meta?.reason ?? 'Unreadable item set aside',
      attempts: 1,
      firstAt: entry.meta?.at ?? 0,
      lastAt: entry.meta?.at ?? 0,
      retryable: !!entry.meta && !existsSync(entry.meta.originalPath),
      discardable: true
    }))
  }

  return {
    refreshComputer,
    async list(scope: { computerId: string | null; dataRoot: string }): Promise<ItemFaultView[]> {
      if (scope.computerId === null)
        return [...hubQuarantine(scope.dataRoot), ...(await hubRows(null))]
      const own = await hubRows(scope.computerId)
      let computer: ItemFaultView[]
      if (deps.isConnected(scope.computerId)) {
        try {
          computer = await refreshComputer(scope.computerId)
        } catch {
          computer = []
        }
      } else {
        // Offline: the last snapshot, read-only (Retry/Discard need the computer).
        const rows = await db.all<ItemFaultRow>(
          "SELECT * FROM item_faults WHERE origin='computer' AND computer_id=? ORDER BY last_at DESC",
          [scope.computerId]
        )
        computer = rows.map((row) => fromRow(row, false))
      }
      return [...computer, ...own]
    },
    async byTask(): Promise<Array<{ taskId: string; computerId: string | null }>> {
      const rows = await db.all<{ task_id: string; computer_id: string }>(
        'SELECT DISTINCT task_id,computer_id FROM item_faults WHERE task_id IS NOT NULL'
      )
      return rows.map((r) => ({ taskId: r.task_id, computerId: r.computer_id || null }))
    },
    async retry(ref: ItemFaultRef, dataRoot: string): Promise<void> {
      if (ref.origin === 'computer' && ref.computerId) {
        await deps.requestComputer(ref.computerId, { kind: 'faults.retry', ref })
        await refreshComputer(ref.computerId)
        return
      }
      if (ref.source === 'quarantine') {
        if (ref.computerId !== null) throw new Error('No such quarantined item')
        if (!restoreQuarantine(dataRoot, ref.pass, ref.key))
          throw new Error('Something new already exists where this item came from')
        return
      }
      // The next pass runs it regardless of its backoff or quarantine.
      await db.run(
        `UPDATE item_faults SET kind='transient',fingerprint=NULL,next_retry_at=0
          WHERE origin='hub' AND computer_id=? AND pass=? AND item_key=?`,
        [ref.computerId ?? '', ref.pass, ref.key]
      )
    },
    async discard(ref: ItemFaultRef, dataRoot: string): Promise<void> {
      if (ref.origin === 'computer' && ref.computerId) {
        await deps.requestComputer(ref.computerId, { kind: 'faults.discard', ref })
        await refreshComputer(ref.computerId)
        return
      }
      if (ref.source !== 'quarantine' || ref.computerId !== null)
        throw new Error('This item cannot be discarded; use Retry')
      if (!discardQuarantine(dataRoot, ref.pass, ref.key))
        throw new Error('No such quarantined item')
    }
  }
}

export type ItemFaultService = ReturnType<typeof createItemFaultService>
