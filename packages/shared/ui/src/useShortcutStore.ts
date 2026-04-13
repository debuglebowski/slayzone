import { create } from 'zustand'
import { shortcutDefinitions, type ShortcutDefinition, type ShortcutScope } from '@slayzone/shortcuts'

// Typed accessor for the Electron preload API. The full type lives in @slayzone/types
// and is augmented onto Window by the preload. We use a minimal cast here so this
// package can typecheck independently without pulling in the full ElectronAPI type.
const api = () => (window as any).api as {
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
  }
  shortcuts: {
    changed: () => void
  }
}

const SETTINGS_KEY = 'custom_shortcuts'

interface ShortcutState {
  /** User overrides. `null` value means explicitly cleared (unbound). */
  overrides: Record<string, string | null>
  isRecording: boolean
  loaded: boolean
  load: () => Promise<void>
  /** Returns the effective key combo for a shortcut. `null` means unbound. */
  getKeys: (id: string) => string | null
  findConflict: (keys: string, scope: ShortcutScope) => ShortcutDefinition | undefined
  findShadow: (keys: string, scope: ShortcutScope) => ShortcutDefinition | undefined
  setOverride: (id: string, keys: string | null) => Promise<void>
  batchSetOverrides: (entries: Record<string, string | null>) => Promise<void>
  resetAll: () => Promise<void>
  setRecording: (recording: boolean) => void
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  overrides: {},
  isRecording: false,
  loaded: false,

  load: async () => {
    const raw = await api().settings.get(SETTINGS_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        // Migrate: attention-panel was changed from mod+shift+a to ctrl+.
        // Remove stale override so users get the new default
        if (parsed['attention-panel'] === 'mod+shift+a') {
          delete parsed['attention-panel']
          await api().settings.set(SETTINGS_KEY, JSON.stringify(parsed))
          api().shortcuts.changed()
        }
        set({ overrides: parsed, loaded: true })
      } catch {
        set({ loaded: true })
      }
    } else {
      set({ loaded: true })
    }
  },

  getKeys: (id: string) => {
    const { overrides } = get()
    if (id in overrides) return overrides[id]
    const def = shortcutDefinitions.find((d) => d.id === id)
    return def?.defaultKeys ?? null
  },

  findConflict: (keys: string, scope: ShortcutScope) => {
    const { overrides } = get()
    return shortcutDefinitions.find((d) => {
      if (d.scope !== scope) return false
      const effective = d.id in overrides ? overrides[d.id] : d.defaultKeys
      return effective !== null && effective === keys
    })
  },

  // Find a shortcut in a different scope that would be shadowed by this binding.
  // Higher-priority scopes shadow lower ones. Same-priority component scopes
  // (editor/terminal/browser) don't shadow each other — only one has focus.
  findShadow: (keys: string, scope: ShortcutScope) => {
    const { overrides } = get()
    const componentScopes: ShortcutScope[] = ['editor', 'terminal', 'browser']
    return shortcutDefinitions.find((d) => {
      if (d.scope === scope) return false // same-scope is handled by findConflict
      // Component scopes at same priority don't shadow each other
      if (componentScopes.includes(scope) && componentScopes.includes(d.scope)) return false
      // Only warn when one scope can shadow the other (different priority levels)
      const effective = d.id in overrides ? overrides[d.id] : d.defaultKeys
      return effective !== null && effective === keys
    })
  },

  setOverride: async (id: string, keys: string | null) => {
    const newOverrides = { ...get().overrides, [id]: keys }
    set({ overrides: newOverrides })
    await api().settings.set(SETTINGS_KEY, JSON.stringify(newOverrides))
    api().shortcuts.changed()
  },

  batchSetOverrides: async (entries: Record<string, string | null>) => {
    const newOverrides = { ...get().overrides, ...entries }
    set({ overrides: newOverrides })
    await api().settings.set(SETTINGS_KEY, JSON.stringify(newOverrides))
    api().shortcuts.changed()
  },

  resetAll: async () => {
    set({ overrides: {} })
    await api().settings.set(SETTINGS_KEY, '{}')
    api().shortcuts.changed()
  },

  setRecording: (recording: boolean) => set({ isRecording: recording })
}))
