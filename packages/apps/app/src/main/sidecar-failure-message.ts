import { join } from 'node:path'

/**
 * The native dialog's text when the local hub cannot start (index.ts
 * onPermanentFailure). Outside a restore, "not modified" is literally true: every
 * migration is atomic with its own user_version bump, so a failure leaves the DB at
 * the last fully-applied version, with a pre-migration backup beside it.
 *
 * During a backup restore it is NOT (the restored file was swapped in), so the text
 * says what happened and where the previous data is: kept as `<db>.pre-restore`
 * (apps/hub restore-swap.ts), put back automatically at the next start.
 */
export function sidecarFailureMessage(input: {
  message: string
  storageDir: string
  dbPath: string
  attempts: number
  exists: (path: string) => boolean
}): string {
  const backups = join(input.storageDir, 'backups')
  const log = join(input.storageDir, 'logs', 'sidecar.log')
  const preRestore = `${input.dbPath}.pre-restore`
  const tail = `Log:\n${log}\n\nAttempts: ${input.attempts}`
  if (input.exists(preRestore)) {
    return (
      `${input.message}\n\n` +
      `A backup restore was being applied when the server failed to start. Your previous ` +
      `data is kept in:\n${preRestore}\n\nIt is put back automatically the next time the ` +
      `app starts. The backup you restored stays in:\n${backups}\n\n${tail}`
    )
  }
  if (input.exists(join(input.storageDir, 'restore.pending.json'))) {
    return (
      `${input.message}\n\n` +
      `A backup restore is waiting to be applied. Your current data has not been replaced ` +
      `yet:\n${input.dbPath}\n\nBackups are in:\n${backups}\n\n${tail}`
    )
  }
  return (
    `${input.message}\n\n` +
    `Your data has not been modified. A pre-migration backup, if one was needed, ` +
    `is in:\n${backups}\n\n${tail}`
  )
}
