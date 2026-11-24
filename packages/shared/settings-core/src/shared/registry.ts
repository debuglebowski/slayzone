import { LEGACY_CHAT_TABLES_DROPPED_SETTING } from '@slayzone/platform/legacy-chat-tables'

/**
 * Every setting key that is not one user's plain UI state, and what it is
 * (plans/settings-by-scope.md). One list instead of one per concern: the server's key
 * scopes (`settingScope`), the device-only keys (`isDeviceSetting`), the keys a
 * project may override (`isProjectOverridable`) and the machine-local ones all derive
 * from it.
 *
 * Kinds:
 * - `hub`: read by the hub's own server code; one value for everyone on the hub.
 * - `device`: one device's preference (screen, fonts, GPU, keyboard); kept on the
 *   device by `deviceSettingsLink`, stored on the hub per user like `user` keys.
 * - `internal`: server-only; never served or written through the settings API.
 * - anything unlisted is `user`: what a client stores for its own UI, per user.
 *
 * Lean leaf (one browser-safe import) so every shell can load it on the boot path.
 */
export type SettingKind = 'hub' | 'device' | 'internal'

export interface SettingRule {
  kind: SettingKind
  /** A project may set its own value (hub keys only). */
  projectOverride?: boolean
  /** The key names a project after the prefix (`ai_providers:<projectId>`). */
  projectKeyed?: boolean
  /** Describes this one machine: never exported or imported. */
  machineLocal?: boolean
}

/**
 * The allowed roots the hub added to its own machine's local computer for worktree
 * bases and automation folders, so it can remove them again (hub
 * computer-project-sync.ts). Server-only state.
 */
export const LOCAL_COMPUTER_WORK_ROOTS_KEY = 'local_computer_work_roots'

/**
 * Hub policy (phase 6): `policy_lock:<key>` = '1' locks a hub setting for projects.
 * Read by the server's override resolution, written by hub admins only.
 */
export const POLICY_LOCK_PREFIX = 'policy_lock:'

const hub: SettingRule = { kind: 'hub' }
const overridable: SettingRule = { kind: 'hub', projectOverride: true }
const device: SettingRule = { kind: 'device' }

/** Exact keys. The reader is named for each hub key: that is why it is hub-wide. */
const KEYS: Readonly<Record<string, SettingRule>> = {
  // task create (task ops, MCP create-subtask, REST subtasks + skills, ai-config)
  default_agent_id: overridable,
  // task create (task ops shared.ts)
  auto_create_worktree_on_task_create: hub,
  worktree_base_path: hub,
  // worktree create (worktrees composite-ops.ts)
  worktree_copy_behavior: hub,
  worktree_copy_paths: hub,
  worktree_submodule_init: hub,
  // idle-close sweep + warm pool (hub composition.ts)
  terminal_auto_close_idle: hub,
  terminal_idle_close_value: hub,
  terminal_idle_close_unit: hub,
  // agent startup mode (warm pool in hub composition.ts, task create's warm reserve,
  // boot restore in task-terminals tab-flags.ts)
  terminal_agent_startup: overridable,
  // test panel (test-panel-store.ts)
  test_profiles: hub,
  // diagnostics config (diagnostics-store.ts)
  diagnostics_enabled: hub,
  diagnostics_verbose: hub,
  diagnostics_include_pty_output: hub,
  diagnostics_retention_days: hub,
  // ports (ws-server.ts, hub port-claim.ts)
  trpc_preferred_port: hub,
  trpc_server_port: hub,
  server_port: hub,
  // hub identity + backups (transport hub router, hub backup.ts)
  hub_label: hub,
  backup_names: hub,
  // Legacy per-provider default flags: seeded by early migrations and read only by
  // v61, which moved them to `agents.default_flags`. Hub-wide by origin.
  default_claude_flags: hub,
  default_codex_flags: hub,
  default_cursor_flags: hub,
  default_gemini_flags: hub,
  default_opencode_flags: hub,

  // Device preferences (phase 4): theme …
  app_theme_id: device,
  app_theme_id_dark: device,
  app_theme_id_light: device,
  app_theme_split: device,
  terminal_override_theme_id: device,
  editor_override_theme_id: device,
  // … text size and fonts …
  terminal_font_family: device,
  terminal_font_size: device,
  editor_font_size: device,
  chat_font_size: device,
  notes_font_family: device,
  // … terminal rendering and keyboard …
  terminal_scrollback: device,
  terminal_option_as_meta: device,
  terminal_force_compatibility_renderer: device,
  // … motion and window-size dependent widths.
  reduce_motion: device,
  chat_width: device,
  chat_threads_width: device,

  // This machine only, and server-internal.
  [LOCAL_COMPUTER_WORK_ROOTS_KEY]: { kind: 'internal', machineLocal: true },
  // When THIS database dropped its legacy chat tables: a record of this install's
  // schema, meaningless in any other.
  [LEGACY_CHAT_TABLES_DROPPED_SETTING]: { kind: 'internal', machineLocal: true }
}

/** Key prefixes, checked in order when no exact key matches. */
const PREFIXES: ReadonlyArray<readonly [string, SettingRule]> = [
  // Server-only secrets (integrations credentials.ts).
  ['integration:credential:', { kind: 'internal' }],
  // Project-keyed config read by hub server code (ai-config handlers-store.ts, REST skills).
  ['ai_providers:', { kind: 'hub', projectKeyed: true }],
  ['ai_instruction_variant:', { kind: 'hub', projectKeyed: true }],
  // Per-provider chat defaults read by the chat spawn for tasks that never picked one
  // (terminal chat-data-ops.ts, the computer bootstrap). Not project-keyed.
  ['chat_default_mode:', overridable],
  ['chat_default_model:', overridable],
  ['chat_default_effort:', overridable],
  [POLICY_LOCK_PREFIX, hub]
]

/** What `key` is, or undefined for a plain per-user UI key. */
export function settingRule(key: string): SettingRule | undefined {
  // Own keys only: `key` comes from a client, and `constructor` must not hit Object's.
  if (Object.hasOwn(KEYS, key)) return KEYS[key]
  return PREFIXES.find(([prefix]) => key.startsWith(prefix))?.[1]
}

/** The project a project-keyed key (`ai_providers:<projectId>`) names, else null. */
export function projectOfKeyedSetting(key: string): string | null {
  const hit = PREFIXES.find(([prefix, rule]) => rule.projectKeyed && key.startsWith(prefix))
  return hit ? key.slice(hit[0].length) || null : null
}
