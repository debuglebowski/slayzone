import { describe, expect, it } from 'vitest'
import { isDeviceSetting } from './device-keys'
import { projectOfKeyedSetting, settingRule } from './registry'
import { isProjectOverridable } from '../server/project-settings'
import { settingScope } from '../server/scope'

describe('settings registry', () => {
  it('device keys are per device, stored per user on the hub', () => {
    expect(isDeviceSetting('terminal_font_size')).toBe(true)
    expect(settingScope('terminal_font_size')).toBe('user')
    expect(isDeviceSetting('panel_config')).toBe(false)
  })

  it('only listed hub keys and chat defaults are overridable by a project', () => {
    expect(isProjectOverridable('default_agent_id')).toBe(true)
    expect(isProjectOverridable('chat_default_mode:claude-chat')).toBe(true)
    expect(isProjectOverridable('worktree_base_path')).toBe(false)
    expect(isProjectOverridable('terminal_font_size')).toBe(false)
  })

  it('policy locks are hub keys (admin-only writes)', () => {
    expect(settingScope('policy_lock:default_agent_id')).toBe('hub')
  })

  it('a key named like an Object member is a plain user key', () => {
    expect(settingRule('constructor')).toBeUndefined()
    expect(settingScope('toString')).toBe('user')
  })

  it('names the project of a project-keyed key only', () => {
    expect(projectOfKeyedSetting('ai_providers:p1')).toBe('p1')
    expect(projectOfKeyedSetting('chat_default_mode:claude-chat')).toBeNull()
  })
})
