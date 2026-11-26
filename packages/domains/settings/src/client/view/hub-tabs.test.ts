import { describe, expect, it } from 'vitest'
import { hubPageTabs } from './hub-tabs'

const keys = (opts: { isDefault: boolean; solo: boolean; isLocal?: boolean }) =>
  hubPageTabs({ isLocal: false, ...opts }).map(([k]) => k)

describe('hubPageTabs', () => {
  it('a hub among others: overview and computers first, host pages on the default only', () => {
    expect(keys({ isDefault: true, solo: false })).toEqual([
      'overview',
      'computers',
      'projects',
      'users',
      'agents',
      'worktrees',
      'mcp',
      'backups',
      'data'
    ])
    expect(keys({ isDefault: false, solo: false })).toEqual([
      'overview',
      'computers',
      'projects',
      'users',
      'agents',
      'worktrees'
    ])
  })

  it('the local hub has no sign-in accounts, so no Users tab', () => {
    expect(keys({ isDefault: true, solo: false, isLocal: true })).not.toContain('users')
  })

  it('the only hub, local: no hub or computer pages as such (its projects stay)', () => {
    expect(keys({ isDefault: true, solo: true, isLocal: true })).toEqual([
      'projects',
      'agents',
      'worktrees',
      'mcp',
      'backups',
      'data'
    ])
  })
})
