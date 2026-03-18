import { create } from 'zustand'
import { shortcutDefinitions, type ShortcutDefinition, type ShortcutScope } from './shortcut-definitions'

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
  overrides: Record<string, string>
  isRecording: boolean
  loaded: boolean
  load: () => Promise<void>
  getKeys: (id: string) => string
  isCustomized: (id: string) => boolean
  findConflict: (keys: string, scope: ShortcutScope) => ShortcutDefinition | undefined
  setOverride: (id: string, keys: string) => Promise<void>
  removeOverride: (id: string) => Promise<void>
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
        set({ overrides: JSON.parse(raw), loaded: true })
      } catch {
        set({ loaded: true })
      }
    } else {
      set({ loaded: true })
    }
  },

  getKeys: (id: string) => {
    const { overrides } = get()
    if (overrides[id]) return overrides[id]
    const def = shortcutDefinitions.find((d) => d.id === id)
    return def?.defaultKeys ?? ''
  },

  isCustomized: (id: string) => {
    return id in get().overrides
  },

  findConflict: (keys: string, scope: ShortcutScope) => {
    const { overrides } = get()
    return shortcutDefinitions.find((d) => {
      if (d.scope !== scope) return false
      const effective = overrides[d.id] ?? d.defaultKeys
      return effective === keys
    })
  },

  setOverride: async (id: string, keys: string) => {
    const newOverrides = { ...get().overrides, [id]: keys }
    set({ overrides: newOverrides })
    await api().settings.set(SETTINGS_KEY, JSON.stringify(newOverrides))
    api().shortcuts.changed()
  },

  removeOverride: async (id: string) => {
    const { [id]: _, ...rest } = get().overrides
    set({ overrides: rest })
    const value = Object.keys(rest).length === 0 ? '{}' : JSON.stringify(rest)
    await api().settings.set(SETTINGS_KEY, value)
    api().shortcuts.changed()
  },

  resetAll: async () => {
    set({ overrides: {} })
    await api().settings.set(SETTINGS_KEY, '{}')
    api().shortcuts.changed()
  },

  setRecording: (recording: boolean) => set({ isRecording: recording })
}))
