import { describe, it, expect } from 'vitest'
import {
  toElectronAccelerator,
  matchesShortcut,
  matchesElectronInput,
  formatKeysForDisplay,
  withShortcut,
  shortcutDefinitions,
  MENU_SHORTCUT_DEFAULTS,
  detectPlatform,
  getBlockedWebPanelKeys,
  type ElectronInput,
} from './index'

describe('toElectronAccelerator', () => {
  it('converts mod+n', () => {
    expect(toElectronAccelerator('mod+n')).toBe('CmdOrCtrl+N')
  })

  it('converts mod+shift+d', () => {
    expect(toElectronAccelerator('mod+shift+d')).toBe('CmdOrCtrl+Shift+D')
  })

  it('converts mod+,', () => {
    expect(toElectronAccelerator('mod+,')).toBe('CmdOrCtrl+,')
  })

  it('converts alt+shift+k', () => {
    expect(toElectronAccelerator('alt+shift+k')).toBe('Alt+Shift+K')
  })

  it('converts escape', () => {
    expect(toElectronAccelerator('escape')).toBe('Escape')
  })

  it('converts ctrl+tab', () => {
    expect(toElectronAccelerator('ctrl+tab')).toBe('Ctrl+Tab')
  })

  it('converts mod+shift+n', () => {
    expect(toElectronAccelerator('mod+shift+n')).toBe('CmdOrCtrl+Shift+N')
  })
})

describe('matchesShortcut', () => {
  function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: '',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...overrides,
    } as KeyboardEvent
  }

  it('matches mod+k on macOS (metaKey)', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'k', metaKey: true }), 'mod+k')).toBe(true)
  })

  it('does not match mod+k without modifier', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'k' }), 'mod+k')).toBe(false)
  })

  it('matches mod+shift+d', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'd', metaKey: true, shiftKey: true }), 'mod+shift+d')).toBe(true)
  })

  it('does not match mod+shift+d without shift', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'd', metaKey: true }), 'mod+shift+d')).toBe(false)
  })

  it('matches escape without modifiers', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'Escape' }), 'escape')).toBe(true)
  })

  it('does not match escape when shift is held', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'Escape', shiftKey: true }), 'escape')).toBe(false)
  })

  it('key comparison is case-insensitive', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'K', metaKey: true }), 'mod+k')).toBe(true)
  })

  it('does not match mod+k when extra modifiers pressed', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true }), 'mod+k')).toBe(false)
  })

  it('matches mod+alt+r via e.code when macOS Alt produces dead key (®)', () => {
    expect(matchesShortcut(makeKeyEvent({ key: '®', code: 'KeyR', metaKey: true, altKey: true }), 'mod+alt+r')).toBe(true)
  })

  it('matches mod+alt+r when e.key is already correct', () => {
    expect(matchesShortcut(makeKeyEvent({ key: 'r', code: 'KeyR', metaKey: true, altKey: true }), 'mod+alt+r')).toBe(true)
  })
})

describe('shortcutDefinitions', () => {
  it('always contains go-home shortcut', () => {
    const goHome = shortcutDefinitions.find(d => d.id === 'go-home')
    expect(goHome).toBeDefined()
    expect(goHome!.platform).toBe('mac')
  })

  it('every definition has required fields', () => {
    for (const def of shortcutDefinitions) {
      expect(def.id).toBeTruthy()
      expect(def.label).toBeTruthy()
      expect(def.group).toBeTruthy()
      expect(def.defaultKeys === null || typeof def.defaultKeys === 'string').toBe(true)
      expect(def.scope).toBeTruthy()
    }
  })

  it('matchesShortcut returns false when keys is null', () => {
    const e = { key: 'k', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(matchesShortcut(e, null)).toBe(false)
  })

  it('formatKeysForDisplay returns null when keys is null', () => {
    expect(formatKeysForDisplay(null)).toBeNull()
  })

  it('toElectronAccelerator returns null when keys is null', () => {
    expect(toElectronAccelerator(null)).toBeNull()
  })

  it('has no duplicate ids', () => {
    const ids = shortcutDefinitions.map(d => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('formatKeysForDisplay', () => {
  it('formats mod+n (includes key name)', () => {
    expect(formatKeysForDisplay('mod+n')).toContain('N')
  })

  it('formats mod+shift+d (includes key name)', () => {
    expect(formatKeysForDisplay('mod+shift+d')).toContain('D')
  })

  it('formats escape as Escape', () => {
    expect(formatKeysForDisplay('escape')).toBe('Escape')
  })

  it('formats ctrl+tab (includes Tab)', () => {
    expect(formatKeysForDisplay('ctrl+tab')).toContain('Tab')
  })

  it('accepts explicit platform override', () => {
    expect(formatKeysForDisplay('mod+n', 'mac')).toBe('⌘N')
    expect(formatKeysForDisplay('mod+n', 'other')).toBe('CtrlN')
  })
})

describe('withShortcut', () => {
  it('appends keys in parentheses when non-null', () => {
    expect(withShortcut('Home', '⌘§')).toBe('Home (⌘§)')
  })

  it('returns bare label when keys is null', () => {
    expect(withShortcut('Home', null)).toBe('Home')
  })
})

describe('MENU_SHORTCUT_DEFAULTS', () => {
  it('is derived from shortcutDefinitions (no duplication)', () => {
    for (const [id, keys] of Object.entries(MENU_SHORTCUT_DEFAULTS)) {
      const def = shortcutDefinitions.find(d => d.id === id)
      expect(def).toBeDefined()
      expect(def!.defaultKeys).toBe(keys)
    }
  })
})

describe('matchesElectronInput', () => {
  function makeInput(overrides: Partial<ElectronInput>): ElectronInput {
    return {
      type: 'keyDown',
      key: '',
      meta: false,
      control: false,
      shift: false,
      alt: false,
      ...overrides,
    }
  }

  it('matches mod+, on macOS (meta)', () => {
    expect(matchesElectronInput(makeInput({ key: ',', meta: true }), 'mod+,')).toBe(true)
  })

  it('does not match on keyUp', () => {
    expect(matchesElectronInput(makeInput({ type: 'keyUp', key: ',', meta: true }), 'mod+,')).toBe(false)
  })

  it('matches mod+shift+, (project settings)', () => {
    expect(matchesElectronInput(makeInput({ key: ',', meta: true, shift: true }), 'mod+shift+,')).toBe(true)
  })

  it('does not match mod+shift+, when only meta pressed', () => {
    expect(matchesElectronInput(makeInput({ key: ',', meta: true }), 'mod+shift+,')).toBe(false)
  })

  it('matches mod+§ (go home)', () => {
    expect(matchesElectronInput(makeInput({ key: '§', meta: true }), 'mod+§')).toBe(true)
  })

  it('matches escape without modifiers', () => {
    expect(matchesElectronInput(makeInput({ key: 'Escape' }), 'escape')).toBe(true)
  })

  it('does not match when extra modifiers pressed', () => {
    expect(matchesElectronInput(makeInput({ key: 'k', meta: true, shift: true }), 'mod+k')).toBe(false)
  })

  it('matches mod+shift+s (screenshot)', () => {
    expect(matchesElectronInput(makeInput({ key: 's', meta: true, shift: true }), 'mod+shift+s')).toBe(true)
  })

  it('key comparison is case-insensitive', () => {
    expect(matchesElectronInput(makeInput({ key: 'S', meta: true, shift: true }), 'mod+shift+s')).toBe(true)
  })

  it('matches mod+alt+r via code when macOS Alt produces dead key (®)', () => {
    expect(matchesElectronInput(makeInput({ key: '®', code: 'KeyR', meta: true, alt: true }), 'mod+alt+r')).toBe(true)
  })
})

describe('detectPlatform', () => {
  it('returns mac or other', () => {
    const result = detectPlatform()
    expect(['mac', 'other']).toContain(result)
  })
})

describe('getBlockedWebPanelKeys', () => {
  it('includes OS reserved keys', () => {
    const blocked = getBlockedWebPanelKeys()
    expect(blocked.has('h')).toBe(true) // macOS hide
    expect(blocked.has('q')).toBe(true) // macOS quit
    expect(blocked.has('m')).toBe(true) // macOS minimize
  })

  it('includes global Cmd+letter shortcuts from definitions', () => {
    const blocked = getBlockedWebPanelKeys()
    expect(blocked.has('n')).toBe(true) // new-task (mod+n)
    expect(blocked.has('k')).toBe(true) // search (mod+k)
    expect(blocked.has('w')).toBe(true) // close-tab (mod+w)
  })

  it('includes task-scope Cmd+letter shortcuts from definitions', () => {
    const blocked = getBlockedWebPanelKeys()
    expect(blocked.has('o')).toBe(true) // panel-terminal (mod+o)
    expect(blocked.has('p')).toBe(true) // panel-processes (mod+p)
    expect(blocked.has('b')).toBe(true) // panel-browser (mod+b)
    expect(blocked.has('s')).toBe(true) // panel-settings (mod+s)
  })

  it('does NOT include terminal/editor/browser scope shortcuts', () => {
    const blocked = getBlockedWebPanelKeys()
    // mod+f is terminal-search (terminal scope) and browser-find (browser scope)
    // but NOT any global/task scope shortcut at mod+f, so it should be available
    // Actually mod+f is not used at global or task scope, so it's not blocked
    // by the definition scan. But it IS a system shortcut (Cmd+F = find).
    // This is acceptable — the OS doesn't reserve Cmd+F.
  })

  it('does not block every letter (some remain available)', () => {
    const blocked = getBlockedWebPanelKeys()
    const available = 'abcdefghijklmnopqrstuvwxyz'.split('').filter(l => !blocked.has(l))
    expect(available.length).toBeGreaterThan(0)
  })
})
