/** Private worker registries must not augment the unrelated application DB registry. */
import type { SlayzoneDb } from './db'
import { openSqliteWorker, type SqliteWorkerHandle } from './sqlite-worker'

type LocalRegistry = { 'local:write': (params: { value: string }) => number }
declare const db: SlayzoneDb<LocalRegistry>

export async function scopedWorkerRegistry(): Promise<void> {
  const value: number = await db.namedTxn('local:write', { value: 'x' })
  // @ts-expect-error a name from another database is not registered here
  await db.namedTxn('another:write', { value: 'x' })
  // @ts-expect-error private transaction params stay precise
  await db.namedTxn('local:write', { value: 1 })
  // @ts-expect-error a private result is inferred, not widened
  const wrong: string = await db.namedTxn('local:write', { value: 'x' })
  void [value, wrong]
}

export async function openingScopedWorker(): Promise<SqliteWorkerHandle<LocalRegistry>> {
  return openSqliteWorker<LocalRegistry>({ label: 'private', workerPath: '', workerData: {} })
}
