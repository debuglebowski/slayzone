import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setShortcutBackend, useShortcutStore } from './useShortcutStore'

// The injected persistence backend: this device's client host (client.config.json
// on the desktop) — it rebuilds the native menu itself, so there is no separate notify.
type Overrides = Record<string, string | null>
const backend = {
  load: vi.fn<() => Promise<Overrides | null>>(),
  save: vi.fn<(o: Overrides) => Promise<void>>()
}
let changedListener: ((o: Overrides) => void) | null = null

setShortcutBackend({
  load: () => backend.load(),
  save: (o) => backend.save(o),
  onChanged: (l) => {
    changedListener = l
    return () => {
      changedListener = null
    }
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  backend.load.mockResolvedValue(null)
  backend.save.mockResolvedValue(undefined)
  // Reset store state
  useShortcutStore.setState({ overrides: {}, isRecording: false, loaded: false })
})

describe('load', () => {
  it('loads the stored map', async () => {
    backend.load.mockResolvedValue({ search: 'mod+shift+p' })
    await useShortcutStore.getState().load()
    expect(useShortcutStore.getState().overrides).toEqual({ search: 'mod+shift+p' })
    expect(useShortcutStore.getState().loaded).toBe(true)
  })

  it('handles no stored overrides', async () => {
    backend.load.mockResolvedValue(null)
    await useShortcutStore.getState().load()
    expect(useShortcutStore.getState().overrides).toEqual({})
    expect(useShortcutStore.getState().loaded).toBe(true)
  })

  it('handles a failing backend gracefully', async () => {
    backend.load.mockRejectedValue(new Error('host gone'))
    await useShortcutStore.getState().load()
    expect(useShortcutStore.getState().overrides).toEqual({})
    expect(useShortcutStore.getState().loaded).toBe(true)
  })

  describe('default migrations', () => {
    it('clears user overrides matching retired defaults', async () => {
      backend.load.mockResolvedValue({
        'zen-mode': 'mod+j',
        'panel-settings': 'mod+s',
        search: 'mod+shift+p' // unrelated, should persist
      })
      await useShortcutStore.getState().load()
      expect(useShortcutStore.getState().overrides).toEqual({ search: 'mod+shift+p' })
      // Single persist write for the whole migration pass
      expect(backend.save).toHaveBeenCalledOnce()
      expect(backend.save).toHaveBeenCalledWith({ search: 'mod+shift+p' })
    })

    it('preserves overrides that differ from the retired default', async () => {
      // User deliberately set zen-mode to a custom combo — must not be wiped
      backend.load.mockResolvedValue({ 'zen-mode': 'mod+alt+j' })
      await useShortcutStore.getState().load()
      expect(useShortcutStore.getState().overrides).toEqual({ 'zen-mode': 'mod+alt+j' })
      expect(backend.save).not.toHaveBeenCalled()
    })

    it('skips persist when no migration applies', async () => {
      backend.load.mockResolvedValue({ search: 'mod+shift+p' })
      await useShortcutStore.getState().load()
      expect(backend.save).not.toHaveBeenCalled()
    })
  })

  describe('id renames', () => {
    it('rewrites override key when shortcut id is renamed', async () => {
      backend.load.mockResolvedValue({ 'agent-panel': 'mod+shift+a' })
      await useShortcutStore.getState().load()
      expect(useShortcutStore.getState().overrides).toEqual({ 'global-agent-panel': 'mod+shift+a' })
      expect(backend.save).toHaveBeenCalledOnce()
      expect(backend.save).toHaveBeenCalledWith({ 'global-agent-panel': 'mod+shift+a' })
    })

    it('keeps existing new-id override when both legacy and new ids present', async () => {
      backend.load.mockResolvedValue({
        'agent-panel': 'mod+shift+a',
        'global-agent-panel': 'mod+alt+a'
      })
      await useShortcutStore.getState().load()
      expect(useShortcutStore.getState().overrides).toEqual({ 'global-agent-panel': 'mod+alt+a' })
    })
  })

  it("rewrites a legacy '' clear to null (unbound) and persists it", async () => {
    backend.load.mockResolvedValue({ 'new-task': '', search: 'mod+shift+p' })
    await useShortcutStore.getState().load()
    expect(useShortcutStore.getState().overrides).toEqual({
      'new-task': null,
      search: 'mod+shift+p'
    })
    expect(backend.save).toHaveBeenCalledOnce()
    expect(backend.save).toHaveBeenCalledWith({ 'new-task': null, search: 'mod+shift+p' })
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

  it("returns '' (not the default) for a legacy '' clear", () => {
    useShortcutStore.setState({ overrides: { search: '' } })
    expect(useShortcutStore.getState().getKeys('search')).toBe('')
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
    // mod+z is undo (global only, no cross-scope binding at this key)
    const shadow = useShortcutStore.getState().findShadow('mod+z', 'global')
    expect(shadow).toBeUndefined()
  })

  it('ignores component scope <-> component scope (no shadow relationship)', () => {
    // mod+f exists in both terminal and browser scope — same priority, no shadow
    const shadow = useShortcutStore.getState().findShadow('mod+f', 'terminal')
    expect(shadow === undefined || shadow.scope === 'global' || shadow.scope === 'task').toBe(true)
  })

  it('finds task scope shadowed by component scope', () => {
    // mod+s is editor scope (editor-save). From task scope, editor shadows.
    const shadow = useShortcutStore.getState().findShadow('mod+s', 'task')
    expect(shadow).toBeDefined()
    expect(shadow!.scope).toBe('editor')
  })
})

describe('setOverride', () => {
  it('persists through the backend', async () => {
    await useShortcutStore.getState().setOverride('search', 'mod+shift+p')
    expect(useShortcutStore.getState().overrides.search).toBe('mod+shift+p')
    expect(backend.save).toHaveBeenCalledOnce()
  })

  it('preserves existing overrides', async () => {
    useShortcutStore.setState({ overrides: { 'zen-mode': 'mod+shift+j' } })
    await useShortcutStore.getState().setOverride('search', 'mod+shift+p')
    expect(useShortcutStore.getState().overrides).toEqual({
      'zen-mode': 'mod+shift+j',
      search: 'mod+shift+p'
    })
  })
})

describe('batchSetOverrides', () => {
  it('sets multiple overrides with a single persist', async () => {
    await useShortcutStore.getState().batchSetOverrides({
      search: 'mod+shift+p',
      'zen-mode': 'mod+shift+j'
    })
    expect(useShortcutStore.getState().overrides.search).toBe('mod+shift+p')
    expect(useShortcutStore.getState().overrides['zen-mode']).toBe('mod+shift+j')
    expect(backend.save).toHaveBeenCalledOnce()
  })
})

describe('resetAll', () => {
  it('clears all overrides', async () => {
    useShortcutStore.setState({ overrides: { search: 'mod+shift+p', 'zen-mode': 'mod+j' } })
    await useShortcutStore.getState().resetAll()
    expect(useShortcutStore.getState().overrides).toEqual({})
    expect(backend.save).toHaveBeenCalledWith({})
  })
})

describe('changes from another window', () => {
  it('adopts the map the backend reports, without saving it back', async () => {
    await useShortcutStore.getState().load()
    changedListener?.({ search: 'mod+alt+k' })
    expect(useShortcutStore.getState().overrides).toEqual({ search: 'mod+alt+k' })
    expect(backend.save).not.toHaveBeenCalled()
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
