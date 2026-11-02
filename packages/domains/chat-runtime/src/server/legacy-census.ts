/** Complete legacy content census, independent of a tab's current UI mode.
 * Expressions are internal aliases, never user-provided SQL.
 */
export function legacyChatTabContentSql(alias: 't' | 'terminal_tabs' = 't'): string {
  const id = `${alias}.id`
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
    OR EXISTS(SELECT 1 FROM chat_threads WHERE id=${id} OR parent_tab_id=${id}))`
}

export function legacyChatTaskContentSql(
  taskIdColumn: 'task.id' | 't.task_id' = 'task.id'
): string {
  return `(EXISTS(SELECT 1 FROM agent_prompts WHERE task_id=${taskIdColumn})
    OR EXISTS(SELECT 1 FROM chat_attachment_messages WHERE task_id=${taskIdColumn})
    OR EXISTS(SELECT 1 FROM agent_turns WHERE task_id=${taskIdColumn} AND prompt_preview<>''))`
}
