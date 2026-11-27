import type { Task } from './types'

/**
 * The fields a board "card row" leaves out: what only the task's own page reads
 * (its description, agent launch config, editor/git/panel working state). A board
 * of card rows is a fraction of the full rows' size, and a page reads the rest from
 * the task's full row (`task.get`).
 *
 * Kept on purpose: every card and list field, and what lets a task page render at
 * once from the board (`panel_visibility`, `panel_sizes`, `browser_tabs`,
 * `browser_url` — the detail snapshot's panels and browser fallback).
 */
export const TASK_CARD_OMITTED_FIELDS: ReadonlySet<keyof Task> = new Set<keyof Task>([
  'description',
  'description_format',
  'provider_config',
  'terminal_shell',
  'claude_flags',
  'codex_flags',
  'cursor_flags',
  'gemini_flags',
  'opencode_flags',
  'dangerously_skip_permissions',
  'worktree_parent_branch',
  'web_panel_urls',
  'editor_open_files',
  'diff_collapsed_files',
  'git_active_tab',
  'merge_context',
  'loop_config',
  'active_artifact_id',
  'artifacts_sidebar',
  'dev_url_toast_dismissed',
  'commit_graph_config'
])

/**
 * `row` as a card row (a copy without the omitted fields). Still typed as the row:
 * the board's wire shape names full `Task`s, and a reader tells the two apart with
 * {@link isFullTaskRow}.
 */
export function toCardRow<T extends Task>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const key in row) {
    if (!TASK_CARD_OMITTED_FIELDS.has(key as keyof Task)) out[key] = row[key]
  }
  return out as T
}

/** Whether `row` carries every field (a full row), not just a card's. */
export function isFullTaskRow(row: Task): boolean {
  for (const key of TASK_CARD_OMITTED_FIELDS) if (!(key in row)) return false
  return true
}
