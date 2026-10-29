/**
 * Type-level proof that `db.namedTxn(name, params)` is typed by the registered
 * transactions. Checked by `pnpm typecheck` (nothing here runs): every
 * `@ts-expect-error` line must stay an error, so a regression that lets a wrong
 * name or wrong params through fails the build.
 *
 * Each `*Txns` impl object types its own names through a co-located `TxnRegistry`
 * augmentation; this file imports nothing but the runtime registry type, so it also
 * proves those augmentations arrive with the modules that define the txns.
 */
import type { SlayzoneDb, TxnName, TxnParams, TxnResult } from '@slayzone/platform'
import type { DomainTxnRegistry } from './index'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

declare const db: SlayzoneDb

export type Exact = [
  // Every txn the runtime registry dispatches is typed — domain and app-internal
  // (`export-import:*`, `db:reset-for-test`) — and no name is typed that isn't registered.
  Assert<Equal<TxnName, keyof DomainTxnRegistry>>,
  Assert<Equal<TxnParams<'tags:setForTask'>, { taskId: string; tagIds: string[] }>>,
  Assert<Equal<TxnResult<'tags:setForTask'>, null>>,
  Assert<Equal<TxnParams<'project-groups:delete'>, { id: string }>>,
  // A no-params txn takes `{}` or nothing.
  Assert<Equal<TxnParams<'db:reset-for-test'>, Record<string, never> | undefined>>
]

export async function accepted(): Promise<void> {
  const tagged: null = await db.namedTxn('tags:setForTask', { taskId: 't', tagIds: ['a'] })
  const deleted: { deletedIds: string[] } = await db.namedTxn('task:soft-delete-many', {
    ops: [{ id: 't', sql: 'UPDATE tasks SET deleted_at = ? WHERE id = ?', params: [], events: [] }]
  })
  await db.namedTxn('ai-config:marketplace:seed-builtin-entries', {})
  await db.namedTxn('db:reset-for-test', {})
  await db.namedTxn('export-import:set-task-parent', { taskId: 't', parentId: null })
  void [tagged, deleted]
}

export function rejected(): void {
  // @ts-expect-error an unregistered name
  void db.namedTxn('tags:setForTaskk', { taskId: 't', tagIds: [] })
  // @ts-expect-error a param of the wrong type
  void db.namedTxn('tags:setForTask', { taskId: 1, tagIds: [] })
  // @ts-expect-error a missing param
  void db.namedTxn('tags:setForTask', { taskId: 't' })
  // @ts-expect-error another txn's params
  void db.namedTxn('tags:setForTask', { id: 'g' })
  // @ts-expect-error params are required
  void db.namedTxn('tags:setForTask')
  // @ts-expect-error a no-params txn takes no params
  void db.namedTxn('db:reset-for-test', { force: true })
  // @ts-expect-error the result is not what the impl returns
  const wrongResult: Promise<string> = db.namedTxn('tags:setForTask', { taskId: 't', tagIds: [] })
  void wrongResult
}
