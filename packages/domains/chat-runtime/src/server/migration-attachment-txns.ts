import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import { ensureArtifactBlobPins } from '@slayzone/task-artifacts/storage'

export const LEGACY_CHAT_BLOB_PIN_SCOPE = 'legacy-chat-migration'
export interface MigrationAttachmentScope {
  id: string
  taskId: string
  tabId: string
  mode: string
  epoch: number
  migrationId: string
}
export interface MigrationAttachmentPinParams {
  scope: MigrationAttachmentScope
  refs: ChatAttachment[]
  expected?: Array<{ contentHash: string; size: number }>
}
export interface MigrationAttachmentReadParams {
  scope: MigrationAttachmentScope
  ref: ChatAttachment
}

function assertSource(db: Database, scope: MigrationAttachmentScope): void {
  if (
    !scope.migrationId ||
    !db
      .prepare(`SELECT 1 FROM chat_ownership o
    JOIN tasks t ON t.id=o.task_id WHERE o.id=? AND o.task_id=? AND o.tab_id=? AND o.mode=?
    AND o.epoch=? AND o.migration_id=? AND o.computer_id IS NULL AND o.state IN ('copying','verified')
    AND NOT EXISTS(SELECT 1 FROM chat_task_lifecycle WHERE task_id=o.task_id AND state='deleted')`)
      .get(scope.id, scope.taskId, scope.tabId, scope.mode, scope.epoch, scope.migrationId)
  )
    throw new Error('Migration attachment source ownership changed or was deleted')
}

export const chatMigrationAttachmentTxns = {
  /**
   * Seals and pins each reference for this frozen source. An unfrozen reference
   * whose artifact version no longer exists in this task (artifact deleted or
   * moved to another task) yields `null`: the migration carries an unavailable
   * placeholder instead, so one dangling reference cannot strand the whole
   * conversation. Frozen references (`expected`) must still resolve exactly.
   */
  'chat-migration:pin-attachments': (
    db: Database,
    { scope, refs, expected }: MigrationAttachmentPinParams
  ): Array<ChatAttachment | null> =>
    db
      .transaction(() => {
        assertSource(db, scope)
        ensureArtifactBlobPins(db)
        if (expected && expected.length !== refs.length)
          throw new Error('Invalid frozen attachment map')
        return refs.map((ref, index) => {
          const frozen = expected?.[index]
          if (
            frozen &&
            ((ref.contentHash && ref.contentHash !== frozen.contentHash) ||
              !/^[a-f0-9]{64}$/.test(frozen.contentHash))
          )
            throw new Error('Frozen attachment reference changed')
          const key = `${ref.artifactId}:${ref.contentHash ?? ''}`
          const previous = db
            .prepare(`SELECT task_id,artifact_id,owner_epoch,content_hash,size FROM artifact_blob_pins
        WHERE scope=? AND owner_id=? AND token=? AND (reference_key=? OR (artifact_id=? AND content_hash=?))
        ORDER BY reference_key=? DESC LIMIT 1`)
            .get(
              LEGACY_CHAT_BLOB_PIN_SCOPE,
              scope.id,
              scope.migrationId,
              key,
              ref.artifactId,
              ref.contentHash ?? null,
              key
            ) as
            | {
                task_id: string
                artifact_id: string
                owner_epoch: number
                content_hash: string
                size: number
              }
            | undefined
          if (
            previous &&
            (previous.task_id !== scope.taskId ||
              previous.artifact_id !== ref.artifactId ||
              previous.owner_epoch !== scope.epoch)
          )
            throw new Error('Migration attachment pin scope mismatch')
          const version =
            previous ??
            (db
              .prepare(
                ref.contentHash || frozen
                  ? `SELECT v.content_hash,v.size FROM artifact_versions v JOIN task_artifacts a ON a.id=v.artifact_id
           WHERE a.id=? AND a.task_id=? AND v.content_hash=? LIMIT 1`
                  : `SELECT v.content_hash,v.size FROM task_artifacts a JOIN artifact_versions v ON v.id=a.current_version_id
           WHERE a.id=? AND a.task_id=?`
              )
              .get(
                ref.artifactId,
                scope.taskId,
                ...(ref.contentHash || frozen ? [ref.contentHash ?? frozen!.contentHash] : [])
              ) as { content_hash: string; size: number } | undefined)
          if (!version && !frozen) return null
          if (
            !version ||
            !/^[a-f0-9]{64}$/.test(version.content_hash) ||
            !Number.isSafeInteger(version.size) ||
            version.size < 0
          )
            throw new Error('Migration attachment version is missing or outside this task')
          if (
            frozen &&
            (version.content_hash !== frozen.contentHash || version.size !== frozen.size)
          )
            throw new Error('Frozen attachment version is unavailable or changed')
          if (!previous)
            db.prepare('INSERT INTO artifact_blob_pins VALUES(?,?,?,?,?,?,?,?,?)').run(
              LEGACY_CHAT_BLOB_PIN_SCOPE,
              scope.id,
              scope.migrationId,
              key,
              scope.taskId,
              ref.artifactId,
              scope.epoch,
              version.content_hash,
              version.size
            )
          return { ...ref, contentHash: version.content_hash, size: version.size }
        })
      })
      .immediate(),
  'chat-migration:read-attachment-pin': (
    db: Database,
    { scope, ref }: MigrationAttachmentReadParams
  ): { hash: string; size: number } =>
    db
      .transaction(() => {
        assertSource(db, scope)
        if (!ref.contentHash || !/^[a-f0-9]{64}$/.test(ref.contentHash))
          throw new Error('Migration attachment must be sealed')
        const pin = db
          .prepare(`SELECT content_hash AS hash,size FROM artifact_blob_pins
      WHERE scope=? AND owner_id=? AND token=? AND task_id=? AND owner_epoch=? AND artifact_id=? AND content_hash=? LIMIT 1`)
          .get(
            LEGACY_CHAT_BLOB_PIN_SCOPE,
            scope.id,
            scope.migrationId,
            scope.taskId,
            scope.epoch,
            ref.artifactId,
            ref.contentHash
          ) as { hash: string; size: number } | undefined
        if (!pin || pin.size !== ref.size)
          throw new Error('Migration attachment does not belong to this frozen source')
        return pin
      })
      .immediate()
}

declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof chatMigrationAttachmentTxns> {}
}
