/** Complete legacy content census, independent of a tab's current UI mode.
 * Expressions are internal aliases, never user-provided SQL.
 *
 * `tables`: whether this install still has its legacy chat tables
 * (`legacyChatTables(db)`, `@slayzone/platform/legacy-chat-tables`). Once they are
 * dropped (robustness plan §9, Phase 8) no hub-era content exists outside thread
 * records, and the SQL never names a dropped table.
 */
export function legacyChatTabContentSql(
  tables: boolean,
  alias: 't' | 'terminal_tabs' = 't'
): string {
  const id = `${alias}.id`
  const threads = `EXISTS(SELECT 1 FROM chat_threads WHERE id=${id} OR parent_tab_id=${id})`
  if (!tables) return `(${threads})`
  return `(${[
    'chat_events',
    'chat_queue',
    'chat_tab_state',
    'chat_timeline_pages',
    'chat_timeline_checkpoints',
    'chat_workspace_changes'
  ]
    .map((table) => `EXISTS(SELECT 1 FROM ${table} WHERE tab_id=${id})`)
    .join(' OR ')}
    OR ${threads})`
}

export function legacyChatTaskContentSql(
  tables: boolean,
  taskIdColumn: 'task.id' | 't.task_id' = 'task.id'
): string {
  // Prompts and turn previews left this census with the tables (v207 handed them to
  // the computers directly, robustness plan §9).
  if (!tables) return '(0)'
  return `(EXISTS(SELECT 1 FROM chat_attachment_messages WHERE task_id=${taskIdColumn}))`
}
