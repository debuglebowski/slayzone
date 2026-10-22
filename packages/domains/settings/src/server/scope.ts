/**
 * Which settings belong to one user and which to the hub (T-16).
 *
 * The `settings` table was one global key/value store, which is right for a hub
 * with one operator and wrong for a hub with several users: one user's open tabs
 * (`viewState`) decided which of ANOTHER user's temporary tasks the boot purge
 * deleted, and every user saw every other user's layout, filters and project-keyed
 * state. On a request that carries a user (a hub that requires login), keys are
 * routed by scope:
 *
 *   - `hub`: read by the hub's own server code to decide what it does — task
 *     creation defaults, worktree behaviour, the idle-close sweep, the warm pool,
 *     diagnostics, ports, backups. That code has no user to ask about, so these
 *     stay in `settings`, one value for everyone. A closed list: a key goes here
 *     only when server code reads it (the grep is `FROM settings` / `SettingsService`).
 *   - `internal`: secrets the server keeps in `settings` for itself (integration
 *     credentials). Never served or written through the settings API, to anyone.
 *   - `user`: everything else — what a client stores for its own UI. Per user, in
 *     `user_settings`. The DEFAULT, so a key added later is private until someone
 *     decides otherwise; the failure mode of a misclassified server-read key is a
 *     preference that has no effect on a login hub, never one user seeing another's.
 *
 * A request with no user (a hub without login — the desktop app's) is unaffected:
 * every key except `internal` reads and writes `settings`, exactly as before.
 *
 * A `user` key never falls back to a `settings` row: that row is legacy state of
 * whoever ran the hub before login (the first admin adopts it at boot, see
 * `adoptLegacyUserSettings`), and serving it to every user is the leak this fixes.
 * So a migration that seeds a `user` key's default only seeds it for a hub without
 * login — put a per-user default in the client.
 */

export type SettingScope = 'hub' | 'user' | 'internal'

/** Read by hub server code (file named for the reader). */
const HUB_KEYS: ReadonlySet<string> = new Set([
  // task create (task ops, MCP create-subtask, REST subtasks + skills, ai-config)
  'default_terminal_mode',
  // task create (task ops shared.ts)
  'auto_create_worktree_on_task_create',
  'worktree_base_path',
  // worktree create (worktrees composite-ops.ts)
  'worktree_copy_behavior',
  'worktree_copy_paths',
  'worktree_submodule_init',
  // idle-close sweep + warm pool (hub composition.ts)
  'terminal_auto_close_idle',
  'terminal_idle_close_value',
  'terminal_idle_close_unit',
  'terminal_prewarm_enabled',
  // test panel (test-panel-store.ts)
  'test_profiles',
  // diagnostics config (diagnostics-store.ts)
  'diagnostics_enabled',
  'diagnostics_verbose',
  'diagnostics_include_pty_output',
  'diagnostics_retention_days',
  // ports (ws-server.ts, hub port-claim.ts)
  'trpc_preferred_port',
  'trpc_server_port',
  'server_port',
  // hub identity + backups (transport hub router, hub backup.ts)
  'hub_label',
  'backup_names',
  // Legacy per-provider default flags: seeded by early migrations and read only by
  // v61, which moved them to `terminal_modes.default_flags`. Hub-wide by origin.
  'default_claude_flags',
  'default_codex_flags',
  'default_cursor_flags',
  'default_gemini_flags',
  'default_opencode_flags'
])

/** Project-keyed config read by hub server code (ai-config handlers-store.ts, REST skills). */
const HUB_PREFIXES: readonly string[] = ['ai_providers:', 'ai_instruction_variant:']

/** Server-only secrets (integrations credentials.ts). */
const INTERNAL_PREFIXES: readonly string[] = ['integration:credential:']

export function settingScope(key: string): SettingScope {
  if (INTERNAL_PREFIXES.some((p) => key.startsWith(p))) return 'internal'
  if (HUB_KEYS.has(key) || HUB_PREFIXES.some((p) => key.startsWith(p))) return 'hub'
  return 'user'
}
