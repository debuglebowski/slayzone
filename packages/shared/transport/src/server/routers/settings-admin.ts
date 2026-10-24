/**
 * Which `settings.set` writes need a hub admin (T-15): the hub-wide keys. Per-user
 * keys (view state, layout, filters) stay writable by every user, or nobody could
 * save their own UI state.
 *
 * @module transport/server/routers/settings-admin
 */
import { adminOnlyTrpcError, callerIsNotAdmin } from '../admin-gate'
import { publicProcedure } from '../trpc'

// COPY of `settingScope` from T-16 (PR #112, domains/settings/src/server/scope.ts):
// dedupe to that one after both merge.
type SettingScope = 'hub' | 'user' | 'internal'

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
  // agent startup mode (warm pool in hub composition.ts, task create's warm reserve,
  // boot restore in task-terminals tab-flags.ts)
  'terminal_agent_startup',
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

function settingScope(key: string): SettingScope {
  if (INTERNAL_PREFIXES.some((p) => key.startsWith(p))) return 'internal'
  if (HUB_KEYS.has(key) || HUB_PREFIXES.some((p) => key.startsWith(p))) return 'hub'
  return 'user'
}

/**
 * Whether writing `key` needs a hub admin: every key that is not one user's own.
 * `internal` keys are included — T-16 refuses them to everyone; until then a
 * non-admin must not overwrite the hub's integration credentials either.
 */
export function settingWriteNeedsAdmin(key: string): boolean {
  return settingScope(key) !== 'user'
}

/**
 * `publicProcedure` plus the key check, for `settings.set`. Reads the raw input
 * because it runs before the router's own `.input()` parser; a malformed input is
 * left for that parser to reject.
 */
export const settingsWriteProcedure = publicProcedure.use(
  async ({ ctx, path, getRawInput, next }) => {
    if (callerIsNotAdmin(ctx)) {
      const key = ((await getRawInput()) as { key?: unknown } | undefined)?.key
      if (typeof key === 'string' && settingWriteNeedsAdmin(key)) throw adminOnlyTrpcError(path)
    }
    return next()
  }
)
