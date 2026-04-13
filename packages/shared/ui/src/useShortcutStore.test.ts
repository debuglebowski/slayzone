import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useShortcutStore } from './useShortcutStore'

// Mock window.api
const mockSettings = {
  get: vi.fn<(key: string) => Promise<string | null>>(),
  set: vi.fn<(key: string, value: string) => Promise<void>>(),
}
const mockShortcuts = { changed: vi.fn() }

Object.defineProperty(globalThis, 'window', {
  value: { api: { settings: mockSettings, shortcuts: mockShortcuts } },
  writable: true,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockSettings.get.mockResolvedValue(null)
  mockSettings.set.mockResolvedValue(undefined)
  // Reset store state
  useShortcutStore.setState({ overrides: {}, isRecording: false, loaded: false })
})

describe('load', () => {
  it('parses valid JSON from settings', async () => {
    mockSettings.get.mockResolvedValue(JSON.stringify({ search: 'mod+shift+p' }))
    await useShortcutStore.getState().load()
    expect(useShortcutStore.getState().overrides).toEqual({ search: 'mod+shift+p' })
    expect(useShortcutStore.getState().loaded).toBe(true)
  })

  it('handles null settings (no overrides saved)', async () => {
    mockSettings.get.mockResolvedValue(null)
    await useShortcutStore.getState().load()
    expect(useShortcutStore.getState().overrides).toEqual({})
    expect(useShortcutStore.getState().loaded).toBe(true)
  })

  it('handles invalid JSON gracefully', async () => {
    mockSettings.get.mockResolvedValue('not-json{{{')
    await useShortcutStore.getState().load()
    expect(useShortcutStore.getState().overrides).toEqual({})
    expect(useShortcutStore.getState().loaded).toBe(true)
  })
})

describe('getKeys', () => {
  it('returns default keys when no override', () => {
    expect(useShortcutStore.getState().getKeys('search')).toBe('mod+k')
  })

  it('returns override when set', () => {
    useShortcutStore.setState({ overrides: { search: 'mod+shift+p' } })
    expect(useShortcutStore.getState().getKeys('search')).toBe('mod+shift+p')
  })

  it('returns null for unknown id', () => {
    expect(useShortcutStore.getState().getKeys('nonexistent')).toBeNull()
  })

  it('returns null when override explicitly cleared', () => {
    useShortcutStore.setState({ overrides: { search: null } })
    expect(useShortcutStore.getState().getKeys('search')).toBeNull()
  })
})

describe('findConflict', () => {
  it('finds same-scope conflict', () => {
    const conflict = useShortcutStore.getState().findConflict('mod+k', 'global')
    expect(conflict).toBeDefined()
    expect(conflict!.id).toBe('search')
  })

  it('ignores cross-scope shortcuts', () => {
    // mod+o is default for panel-terminal (task scope)
    const conflict = useShortcutStore.getState().findConflict('mod+o', 'global')
    expect(conflict).toBeUndefined()
  })

  it('checks overrides not just defaults', () => {
    useShortcutStore.setState({ overrides: { search: 'mod+shift+k' } })
    // Original mod+k should no longer conflict
    const conflict = useShortcutStore.getState().findConflict('mod+k', 'global')
    expect(conflict).toBeUndefined()
    // New binding should conflict
    const conflict2 = useShortcutStore.getState().findConflict('mod+shift+k', 'global')
    expect(conflict2).toBeDefined()
    expect(conflict2!.id).toBe('search')
  })
})

describe('findShadow', () => {
  it('finds global shortcut that shadows scoped shortcut', () => {
    // mod+d is default for terminal-split (terminal scope)
    // If we assign mod+d to a global shortcut, it shadows
    useShortcutStore.setState({ overrides: { 'new-task': 'mod+d' } })
    const shadow = useShortcutStore.getState().findShadow('mod+d', 'global')
    expect(shadow).toBeDefined()
    expect(shadow!.scope).not.toBe('global')
  })

  it('finds scoped shortcut shadowed by global', () => {
    // mod+n is global (new-task). If we check from terminal scope, it shadows
    const shadow = useShortcutStore.getState().findShadow('mod+n', 'terminal')
    expect(shadow).toBeDefined()
    expect(shadow!.id).toBe('new-task')
    expect(shadow!.scope).toBe('global')
  })

  it('ignores same-scope (handled by findConflict)', () => {
    // mod+j is zen-mode (global only, no cross-scope binding at this key)
    const shadow = useShortcutStore.getState().findShadow('mod+j', 'global')
    expect(shadow).toBeUndefined()
  })

  it('ignores component scope <-> component scope (no shadow relationship)', () => {
    // mod+f exists in both terminal and browser scope — same priority, no shadow
    const shadow = useShortcutStore.getState().findShadow('mod+f', 'terminal')
    expect(shadow === undefined || shadow.scope === 'global' || shadow.scope === 'task').toBe(true)
  })

  it('finds task scope shadowed by component scope', () => {
    // mod+s is task scope (panel-settings) and editor scope (editor-save)
    const shadow = useShortcutStore.getState().findShadow('mod+s', 'task')
    expect(shadow).toBeDefined()
    expect(shadow!.scope).toBe('editor')
  })
})

describe('setOverride', () => {
  it('persists to settings and notifies', async () => {
    await useShortcutStore.getState().setOverride('search', 'mod+shift+p')
    expect(useShortcutStore.getState().overrides.search).toBe('mod+shift+p')
    expect(mockSettings.set).toHaveBeenCalledOnce()
    expect(mockShortcuts.changed).toHaveBeenCalledOnce()
  })

  it('preserves existing overrides', async () => {
    useShortcutStore.setState({ overrides: { 'zen-mode': 'mod+shift+j' } })
    await useShortcutStore.getState().setOverride('search', 'mod+shift+p')
    expect(useShortcutStore.getState().overrides).toEqual({
      'zen-mode': 'mod+shift+j',
      search: 'mod+shift+p',
    })
  })
})

describe('batchSetOverrides', () => {
  it('sets multiple overrides with single persist and notify', async () => {
    await useShortcutStore.getState().batchSetOverrides({
      search: 'mod+shift+p',
      'zen-mode': 'mod+shift+j',
    })
    expect(useShortcutStore.getState().overrides.search).toBe('mod+shift+p')
    expect(useShortcutStore.getState().overrides['zen-mode']).toBe('mod+shift+j')
    expect(mockSettings.set).toHaveBeenCalledOnce()
    expect(mockShortcuts.changed).toHaveBeenCalledOnce()
  })
})

describe('resetAll', () => {
  it('clears all overrides', async () => {
    useShortcutStore.setState({ overrides: { search: 'mod+shift+p', 'zen-mode': 'mod+j' } })
    await useShortcutStore.getState().resetAll()
    expect(useShortcutStore.getState().overrides).toEqual({})
    expect(mockSettings.set).toHaveBeenCalledWith('custom_shortcuts', '{}')
    expect(mockShortcuts.changed).toHaveBeenCalledOnce()
  })
})

describe('isRecording', () => {
  it('toggles recording state', () => {
    useShortcutStore.getState().setRecording(true)
    expect(useShortcutStore.getState().isRecording).toBe(true)
    useShortcutStore.getState().setRecording(false)
    expect(useShortcutStore.getState().isRecording).toBe(false)
  })
})
