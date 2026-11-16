declare const __STORE_FIXTURE__: string
/** Static import fixtures, compiled into their worker; no callbacks cross the boundary. */
import { z } from 'zod'
import {
  type DataImportKinds,
  historyImports,
  sessionLedgerImports,
  taskPathImport
} from '@slayzone/chat-runtime/server'
import { serveChatStorageOwner } from '@slayzone/chat-runtime/storage-owner-worker'
/** The kind a later phase registers for real: keyed rows, the newer `at` wins. */
const probe: DataImportKinds = {
  probe: {
    value: z.object({ text: z.string(), at: z.number() }),
    apply(storage, item) {
      storage.compose((db) => {
        db.exec(
          'CREATE TABLE IF NOT EXISTS probe(key TEXT PRIMARY KEY, task_id TEXT, text TEXT, at INTEGER)'
        )
        db.prepare(
          `INSERT INTO probe VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text,at=excluded.at
           WHERE excluded.at > probe.at`
        ).run(item.key, item.taskId, item.value.text, item.value.at)
      })
      // A deterministic failure of the real kinds ("Conversation deleted", "of
      // another task", a malformed local row): the item's own data cannot apply.
      if (item.value.text === 'boom') throw new Error('Session of another task')
    }
  }
}
/** Same rows under the real kinds' names: the priority order is by kind. */
for (const kind of ['task-path', 'chat-settings', 'agent-session', 'agent-prompt', 'agent-turn'])
  (probe as Record<string, unknown>)[kind] = probe.probe

/** A computer-only data kind as later phases register them: keyed rows, newer `at` wins. */
const soakData: DataImportKinds = {
  soak: {
    value: z.object({ text: z.string(), at: z.number() }),
    apply(storage, item) {
      storage.compose((db) => {
        db.exec(
          'CREATE TABLE IF NOT EXISTS soak_data(key TEXT PRIMARY KEY, task_id TEXT, text TEXT, at INTEGER)'
        )
        db.prepare(
          `INSERT INTO soak_data VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text,at=excluded.at
           WHERE excluded.at > soak_data.at`
        ).run(item.key, item.taskId, item.value.text, item.value.at)
      })
    }
  }
}

serveChatStorageOwner({
  dataImports:
    __STORE_FIXTURE__ === 'soak'
      ? { ...sessionLedgerImports, ...historyImports, 'task-path': taskPathImport, ...soakData }
      : probe
})
