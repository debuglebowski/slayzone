import { create } from 'zustand'
import {
  shortcutDefinitions,
  SHORTCUT_DEFAULT_MIGRATIONS,
  SHORTCUT_ID_RENAMES,
  type ShortcutDefinition,
  type ShortcutScope
} from '@slayzone/shortcuts'

// Persistence + notify seam, injected at boot by the host (renderer wires it to
// tRPC; see shortcut-backend in the app). @slayzone/ui is the base design-system
// layer and deliberately has NO transport dependency, so the backend is passed
// in rather than imported — the successor to the old `window.api` preload global.
export interface ShortcutBackend {
  /** Read a persisted setting value (null when unset). */
  get: (key: string) => Promise<string | null>
  /** Persist a setting value. */
  set: (key: string, value: string) => Promise<void>
  /** Tell the host the shortcut map changed (rebuilds native menu accelerators). */
  notifyChanged: () => void
}

let backend: ShortcutBackend | null = null

/** Wire the shortcut persistence backend. Call once at renderer boot, before
 *  the store's `load()` runs. */
export function setShortcutBackend(b: ShortcutBackend): void {
  backend = b
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
    const raw = (await backend?.get(SETTINGS_KEY)) ?? null
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        // Clear any user overrides that still match a retired default, so the
        // new default takes effect. Registry lives next to shortcutDefinitions.
        let changed = false
        // Rename legacy shortcut ids first so subsequent migrations apply on the new id.
        for (const { from, to } of SHORTCUT_ID_RENAMES) {
          if (from in parsed) {
            if (!(to in parsed)) parsed[to] = parsed[from]
            delete parsed[from]
            changed = true
          }
        }
        for (const { id, oldDefault } of SHORTCUT_DEFAULT_MIGRATIONS) {
          if (parsed[id] === oldDefault) {
            delete parsed[id]
            changed = true
          }
        }
        if (changed) {
          await backend?.set(SETTINGS_KEY, JSON.stringify(parsed))
          backend?.notifyChanged()
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
    await backend?.set(SETTINGS_KEY, JSON.stringify(newOverrides))
    backend?.notifyChanged()
  },

  batchSetOverrides: async (entries: Record<string, string | null>) => {
    const newOverrides = { ...get().overrides, ...entries }
    set({ overrides: newOverrides })
    await backend?.set(SETTINGS_KEY, JSON.stringify(newOverrides))
    backend?.notifyChanged()
  },

  resetAll: async () => {
    set({ overrides: {} })
    await backend?.set(SETTINGS_KEY, '{}')
    backend?.notifyChanged()
  },

  setRecording: (recording: boolean) => set({ isRecording: recording })
}))
