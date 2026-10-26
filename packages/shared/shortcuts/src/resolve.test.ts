import { describe, it, expect } from 'vitest'
import { resolveShortcutKeys } from './index'

describe('resolveShortcutKeys', () => {
  it('returns the default when there is no override', () => {
    expect(resolveShortcutKeys({}, 'search')).toBe('mod+k')
  })

  it('returns the override when set', () => {
    expect(resolveShortcutKeys({ search: 'mod+shift+p' }, 'search')).toBe('mod+shift+p')
  })

  it('a cleared override beats the default — null, and the legacy empty string', () => {
    expect(resolveShortcutKeys({ search: null }, 'search')).toBeNull()
    expect(resolveShortcutKeys({ search: '' }, 'search')).toBe('')
  })

  it('returns null for an unknown id', () => {
    expect(resolveShortcutKeys({}, 'nonexistent')).toBeNull()
  })
})
