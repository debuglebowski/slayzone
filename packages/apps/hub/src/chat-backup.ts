import Database from 'better-sqlite3'
import { openSync, closeSync, fsyncSync } from 'node:fs'

/** Sanitize the unpublished snapshot, never the live database. Old backups stay intact. */
export async function sanitizeHubChatBackup(path: string): Promise<void> {
  const db = new Database(path)
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
  )
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as {
    name: string
    sql: string
  }[]
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
  try {
    db.pragma('secure_delete=ON')
    db.pragma('foreign_keys=OFF')
    db.transaction(() => {
      // Ownership fences protect the live source; they must not retain content in a backup.
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`)
      for (const table of [
        'chat_workspace_diffs',
        'chat_workspace_changes',
        'chat_events',
        'chat_queue',
        'chat_tab_state',
        'chat_timeline_pages',
        'chat_timeline_checkpoints',
        'agent_prompts',
        'chat_attachment_messages',
        'chat_cli_snapshots',
        'chat_cli_models',
        'chat_cli_command_details'
      ]) {
        if (tables.has(table)) db.exec(`DELETE FROM ${quote(table)}`)
      }
      if (tables.has('terminal_tabs') && tables.has('chat_threads'))
        db.exec("UPDATE terminal_tabs SET label='Thread' WHERE id IN (SELECT id FROM chat_threads)")
      if (tables.has('chat_threads')) db.exec("UPDATE chat_threads SET title='Thread'")
      if (tables.has('agent_turns')) db.exec("UPDATE agent_turns SET prompt_preview=''")
      for (const trigger of triggers) db.exec(trigger.sql)
    })()
    // secure_delete covers current cells; VACUUM also removes remnants predating this feature.
    db.exec('VACUUM')
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    if (checkpoint.some((r) => r.busy)) throw new Error('Backup sanitation checkpoint is busy')
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('Backup integrity check failed')
  } finally {
    db.close()
  }
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
