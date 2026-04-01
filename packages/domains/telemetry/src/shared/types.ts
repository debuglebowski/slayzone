export type TelemetryTier = 'anonymous' | 'opted_in'

export type TelemetryEventName =
  // App lifecycle
  | 'app_opened'
  | 'heartbeat'
  | 'app_backgrounded'
  // Onboarding
  | 'onboarding_step'
  | 'onboarding_completed'
  | 'onboarding_skipped'
  | 'onboarding_provider_selected'
  // Navigation
  | '$pageview'
  | 'search_used'
  | 'keyboard_shortcut_used'
  | 'tab_reopened'
  | 'undo_used'
  | 'redo_used'
  // Task lifecycle
  | 'task_created'
  | 'task_completed'
  | 'task_deleted'
  | 'task_duplicated'
  | 'task_archived'
  | 'task_status_changed'
  | 'task_priority_changed'
  | 'task_description_ai_generated'
  | 'subtask_created'
  | 'task_dependency_added'
  | 'temporary_task_created'
  | 'task_moved_to_project'
  | 'task_snoozed'
  | 'task_unsnoozed'
  | 'due_date_set'
  | 'copy_title'
  | 'copy_link'
  // Tags
  | 'tag_created'
  | 'tag_assigned'
  // Kanban
  | 'kanban_drag_drop'
  | 'filter_applied'
  | 'group_by_changed'
  | 'columns_customized'
  // Panels & layout
  | 'panel_toggled'
  | 'zen_mode_toggled'
  | 'explode_mode_toggled'
  | 'screenshot_captured'
  // Terminal
  | 'terminal_mode_switched'
  | 'provider_session_started'
  | 'terminal_group_created'
  | 'terminal_search_used'
  | 'terminal_buffer_cleared'
  | 'terminal_restarted'
  | 'custom_mode_created'
  | 'ccs_profile_selected'
  // Git & worktrees
  | 'git_operation'
  | 'branch_created'
  | 'branch_checked_out'
  | 'merge_started'
  | 'rebase_action'
  | 'stage_all'
  | 'discard_changes'
  | 'pr_created'
  | 'pr_merged'
  | 'pr_commented'
  | 'commit_graph_viewed'
  | 'worktree_created'
  | 'worktree_files_copied'
  // Editor
  | 'editor_file_opened'
  | 'file_created'
  | 'file_renamed'
  | 'file_deleted'
  | 'folder_created'
  | 'file_copied'
  | 'file_cut'
  | 'file_pasted'
  | 'file_duplicated'
  | 'path_copied'
  | 'file_search_used'
  | 'quick_open_used'
  | 'reveal_in_finder'
  // Browser panel
  | 'web_panel_opened'
  | 'web_panel_tab_added'
  | 'browser_tab_closed'
  | 'browser_navigated'
  | 'browser_devtools_toggled'
  | 'browser_multidevice_toggled'
  // Integrations
  | 'integration_connected'
  | 'issues_imported'
  | 'task_synced'
  // Project
  | 'project_created'
  | 'project_switched'
  | 'project_settings_tab_viewed'
  | 'ai_config_changed'
  // Settings
  | 'settings_changed'
  | 'theme_changed'
  | 'telemetry_tier_changed'
  // Processes
  | 'process_created'
  | 'process_stopped'
  // Backup
  | 'backup_created'
  | 'backup_restored'
  | 'auto_backup_toggled'
  // Data
  | 'data_exported'
  | 'data_imported'
  // Misc
  | 'notification_clicked'
  | 'changelog_viewed'
  | 'leaderboard_viewed'
  | 'update_installed'

export interface TelemetryEventProps {
  // App lifecycle
  app_opened: { version: string }
  heartbeat: { active_ms: number; active_minutes: number }
  app_backgrounded: {
    reason: 'backgrounded' | 'shutdown'
    active_ms: number
    active_minutes: number
  }
  // Onboarding
  onboarding_step: { step: number; step_name: string }
  onboarding_completed: { provider: string; tier: string }
  onboarding_skipped: { from_step: number; from_step_name: string }
  onboarding_provider_selected: { provider: string }
  // Navigation
  $pageview: { $current_url: string; page: 'home' | 'task' | 'leaderboard' | 'usage-analytics'; task_id?: string }
  search_used: { had_results: boolean }
  keyboard_shortcut_used: { key: string }
  tab_reopened: Record<string, never>
  undo_used: Record<string, never>
  redo_used: Record<string, never>
  // Task lifecycle
  task_created: { provider: string; from_template: boolean }
  task_completed: { provider: string; had_worktree: boolean }
  task_deleted: { was_temporary: boolean }
  task_duplicated: Record<string, never>
  task_archived: { bulk: boolean }
  task_status_changed: { from: string; to: string }
  task_priority_changed: { priority: string }
  task_description_ai_generated: Record<string, never>
  subtask_created: Record<string, never>
  task_dependency_added: Record<string, never>
  temporary_task_created: Record<string, never>
  task_moved_to_project: Record<string, never>
  task_snoozed: Record<string, never>
  task_unsnoozed: Record<string, never>
  due_date_set: Record<string, never>
  copy_title: Record<string, never>
  copy_link: Record<string, never>
  // Tags
  tag_created: Record<string, never>
  tag_assigned: Record<string, never>
  // Kanban
  kanban_drag_drop: Record<string, never>
  filter_applied: { type: string }
  group_by_changed: { field: string }
  columns_customized: Record<string, never>
  // Panels & layout
  panel_toggled: { panel: string; active: boolean; context: 'task' | 'home' }
  zen_mode_toggled: Record<string, never>
  explode_mode_toggled: Record<string, never>
  screenshot_captured: Record<string, never>
  // Terminal
  terminal_mode_switched: { from: string; to: string }
  provider_session_started: { provider: string }
  terminal_group_created: { split_vs_new: 'split' | 'new' }
  terminal_search_used: Record<string, never>
  terminal_buffer_cleared: Record<string, never>
  terminal_restarted: { provider: string }
  custom_mode_created: Record<string, never>
  ccs_profile_selected: Record<string, never>
  // Git & worktrees
  git_operation: { op: string }
  branch_created: Record<string, never>
  branch_checked_out: Record<string, never>
  merge_started: { ai_assisted: boolean }
  rebase_action: { action: 'continue' | 'skip' | 'abort' }
  stage_all: Record<string, never>
  discard_changes: Record<string, never>
  pr_created: Record<string, never>
  pr_merged: Record<string, never>
  pr_commented: Record<string, never>
  commit_graph_viewed: Record<string, never>
  worktree_created: { auto_vs_manual: 'auto' | 'manual' }
  worktree_files_copied: Record<string, never>
  // Editor
  editor_file_opened: { from: 'sidebar' | 'keybind' | 'link' | 'terminal' | 'search' }
  file_created: Record<string, never>
  file_renamed: Record<string, never>
  file_deleted: Record<string, never>
  folder_created: Record<string, never>
  file_copied: Record<string, never>
  file_cut: Record<string, never>
  file_pasted: Record<string, never>
  file_duplicated: Record<string, never>
  path_copied: Record<string, never>
  file_search_used: { had_results: boolean }
  quick_open_used: Record<string, never>
  reveal_in_finder: Record<string, never>
  // Browser panel
  web_panel_opened: Record<string, never>
  web_panel_tab_added: { predefined_vs_custom: 'predefined' | 'custom' }
  browser_tab_closed: Record<string, never>
  browser_navigated: Record<string, never>
  browser_devtools_toggled: Record<string, never>
  browser_multidevice_toggled: Record<string, never>
  // Integrations
  integration_connected: { provider: string }
  issues_imported: { provider: string }
  task_synced: { provider: string; direction: 'push' | 'pull' }
  // Project
  project_created: Record<string, never>
  project_switched: Record<string, never>
  project_settings_tab_viewed: { tab: string }
  ai_config_changed: { section: string }
  // Settings
  settings_changed: { key: string }
  theme_changed: { mode?: 'light' | 'dark' | 'system'; themeId?: string }
  telemetry_tier_changed: { tier: TelemetryTier }
  // Processes
  process_created: Record<string, never>
  process_stopped: Record<string, never>
  // Backup
  backup_created: Record<string, never>
  backup_restored: Record<string, never>
  auto_backup_toggled: Record<string, never>
  // Data
  data_exported: { format: string }
  data_imported: Record<string, never>
  // Misc
  notification_clicked: Record<string, never>
  changelog_viewed: Record<string, never>
  leaderboard_viewed: Record<string, never>
  update_installed: Record<string, never>
}
