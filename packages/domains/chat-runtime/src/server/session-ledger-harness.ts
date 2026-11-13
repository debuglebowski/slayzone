/**
 * TESTS ONLY: a hub's session ledger client wired to an in-process "computer" — a
 * real chat store holding the real ledger (robustness plan §9). Lets hub-side
 * suites (task router, REST, hub flows) exercise sessions end to end: intents
 * delivered, offline computers, handoff before use.
 *
 * @module chat-runtime/server/session-ledger-harness
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import { createComputerSessionLedger } from './hub-session-ledger'
import { createSessionLedgerService } from './session-ledger-service'
import { sessionLedgerImports } from './session-ledger-imports'
import { openChatStorage } from './storage'
import { createComputerTaskData } from './task-data'

export function createSessionLedgerHarness(opts: {
  /** The hub's database (session intents, chat_task_computers). */
  db: SlayzoneDb
  computerId?: string
  /** Hub rows still to hand over first (computer-data-handoff's flushTask). */
  flushTask?(taskId: string, computerId: string): Promise<void>
}) {
  const computerId = opts.computerId ?? 'computer-1'
  const dir = mkdtempSync(join(tmpdir(), 'slz-ledger-harness-'))
  const storage = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  const service = createSessionLedgerService(storage)
  const taskData = createComputerTaskData({
    storage,
    computerId,
    imports: sessionLedgerImports,
    providerConfig: () => ({})
  })
  let online = true
  const requests: unknown[] = []
  const ledger = createComputerSessionLedger({
    db: opts.db,
    request: async (id, request) => {
      if (!online || id !== computerId) throw new Error('Computer is offline')
      requests.push(request)
      const r = request as { kind: string; value: unknown }
      if (r.kind === 'ledger') return service.handle(r.value)
      if (r.kind === 'data.import') return taskData.importBatch(r.value)
      throw new Error(`Unexpected request ${r.kind}`)
    },
    target: async () => computerId,
    usable: () => online,
    flushTask: opts.flushTask ?? (async () => undefined),
    track: async (taskId, id) => {
      await opts.db.run(
        'INSERT OR IGNORE INTO chat_task_computers(task_id,computer_id) VALUES(?,?)',
        [taskId, id]
      )
    }
  })
  return {
    computerId,
    ledger,
    service,
    storage,
    requests,
    setOnline(next: boolean) {
      online = next
    },
    close() {
      storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
