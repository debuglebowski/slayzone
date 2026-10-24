/**
 * Which settings keys are per user, which are the hub's, which are never served
 * (T-16). The hub list is closed — every entry is a key hub server code reads —
 * and everything else defaults to per user, so a new client key is private.
 *
 * Run with: npx vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/settings/src/server/scope.test.ts
 */
import { describe, expect, it } from 'vitest'
import { settingScope } from './scope'

describe('settingScope', () => {
  it('per user: one person’s UI state, including the G-09 key', () => {
    for (const key of [
      'viewState',
      'panel_config',
      'onboarding_completed',
      'globalAgentPanelState',
      'mcp_custom_servers',
      'commit_graph:project:p1',
      'slay_nudge_dismissed:p1',
      'some_key_added_next_year'
    ]) {
      expect(settingScope(key), key).toBe('user')
    }
  })

  it('hub: keys the hub’s own server code reads', () => {
    for (const key of [
      'default_terminal_mode',
      'auto_create_worktree_on_task_create',
      'worktree_base_path',
      'worktree_copy_behavior',
      'worktree_copy_paths',
      'worktree_submodule_init',
      'terminal_auto_close_idle',
      'terminal_idle_close_value',
      'terminal_idle_close_unit',
      'terminal_agent_startup',
      'test_profiles',
      'diagnostics_enabled',
      'diagnostics_retention_days',
      'trpc_preferred_port',
      'server_port',
      'hub_label',
      'backup_names',
      'ai_providers:p1',
      'ai_instruction_variant:p1',
      'default_claude_flags'
    ]) {
      expect(settingScope(key), key).toBe('hub')
    }
  })

  it('internal: integration credentials', () => {
    expect(settingScope('integration:credential:abc')).toBe('internal')
  })

  it('matches prefixes, not substrings', () => {
    expect(settingScope('my_ai_providers:p1')).toBe('user')
    expect(settingScope('x:integration:credential:abc')).toBe('user')
  })
})
