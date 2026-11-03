import Database from 'better-sqlite3'
import { fsyncFileSync } from '@slayzone/platform/durable-fs'

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
  const scoped = tables.has('chat_ownership') && tables.has('chat_tab_bindings')
  const ownedTab = (
    tab: string
  ) => `EXISTS(SELECT 1 FROM chat_tab_bindings b JOIN chat_ownership o ON o.id=b.conversation_id
    WHERE b.tab_id=${tab} AND (o.state='deleted' OR (o.state='active' AND o.computer_id IS NOT NULL)))`
  const ownedTask = (
    task: string
  ) => `EXISTS(SELECT 1 FROM chat_ownership o WHERE o.task_id=${task} AND o.state IN ('active','deleted'))
    AND NOT EXISTS(SELECT 1 FROM chat_ownership o WHERE o.task_id=${task} AND o.state IN ('legacy','copying','verified'))`
  try {
    db.pragma('secure_delete=ON')
    db.pragma('foreign_keys=OFF')
    db.transaction(() => {
      // A pending source is still the only recoverable copy. Preserve that source
      // in transitional backups; sanitize only content with a committed owner.
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
        if (!tables.has(table)) continue
        if (!scoped) db.exec(`DELETE FROM ${quote(table)}`)
        else if (table === 'chat_workspace_diffs')
          db.exec(
            `DELETE FROM chat_workspace_diffs WHERE capture_id IN (SELECT id FROM chat_workspace_changes c WHERE ${ownedTab('c.tab_id')})`
          )
        else if (['agent_prompts', 'chat_attachment_messages'].includes(table))
          db.exec(`DELETE FROM ${quote(table)} WHERE ${ownedTask(`${quote(table)}.task_id`)}`)
        else if (table.startsWith('chat_cli_'))
          db.exec(`DELETE FROM ${quote(table)} WHERE EXISTS(SELECT 1 FROM tasks t JOIN chat_ownership o ON o.task_id=t.id
            WHERE t.project_id=${quote(table)}.project_id AND o.mode=${quote(table)}.mode AND o.state='active')
            AND NOT EXISTS(SELECT 1 FROM terminal_tabs tab JOIN tasks t ON t.id=tab.task_id WHERE t.project_id=${quote(table)}.project_id
              AND NOT (${ownedTab('tab.id')}))`)
        else db.exec(`DELETE FROM ${quote(table)} WHERE ${ownedTab(`${quote(table)}.tab_id`)}`)
      }
      if (tables.has('terminal_tabs') && tables.has('chat_threads'))
        db.exec(
          `UPDATE terminal_tabs SET label='Thread' WHERE id IN (SELECT id FROM chat_threads ${scoped ? `WHERE ${ownedTab('chat_threads.parent_tab_id')}` : ''})`
        )
      if (tables.has('chat_threads'))
        db.exec(
          `UPDATE chat_threads SET title='Thread' ${scoped ? `WHERE ${ownedTab('chat_threads.parent_tab_id')}` : ''}`
        )
      if (tables.has('agent_turns'))
        db.exec(
          `UPDATE agent_turns SET prompt_preview='' ${scoped ? `WHERE ${ownedTask('agent_turns.task_id')}` : ''}`
        )
      if (tables.has('artifact_blob_leases')) db.exec('DELETE FROM artifact_blob_leases')
      if (tables.has('artifact_blob_pins')) {
        db.exec("DELETE FROM artifact_blob_pins WHERE scope='hub-backup'")
        if (scoped)
          db.exec(`DELETE FROM artifact_blob_pins WHERE scope='legacy-chat-migration'
          AND owner_id IN(SELECT id FROM chat_ownership WHERE state='deleted' OR (state='active' AND computer_id IS NOT NULL))`)
      }
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
  fsyncFileSync(path)
}
