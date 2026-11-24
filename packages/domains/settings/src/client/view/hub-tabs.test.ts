import { describe, expect, it } from 'vitest'
import { hubPageTabs } from './hub-tabs'

const keys = (opts: { isDefault: boolean; solo: boolean }) => hubPageTabs(opts).map(([k]) => k)

describe('hubPageTabs', () => {
  it('a hub among others: overview and computers first, host pages on the default only', () => {
    expect(keys({ isDefault: true, solo: false })).toEqual([
      'overview',
      'computers',
      'agents',
      'worktrees',
      'mcp',
      'backups',
      'data'
    ])
    expect(keys({ isDefault: false, solo: false })).toEqual([
      'overview',
      'computers',
      'agents',
      'worktrees'
    ])
  })

  it('the only hub, local: no hub or computer pages as such', () => {
    expect(keys({ isDefault: true, solo: true })).toEqual([
      'agents',
      'worktrees',
      'mcp',
      'backups',
      'data'
    ])
  })
})
