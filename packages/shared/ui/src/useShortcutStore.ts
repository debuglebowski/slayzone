import { create } from 'zustand'
import {
  shortcutDefinitions,
  normalizeShortcutOverrides,
  resolveShortcutKeys,
  type ShortcutDefinition,
  type ShortcutOverrides,
  type ShortcutScope
} from '@slayzone/shortcuts'

// Persistence seam, injected at boot by the host. @slayzone/ui is the base
// design-system layer and deliberately has NO transport dependency, so the backend
// is passed in rather than imported. The renderer wires it to THIS device's client
// host (client.config.json on the desktop), which also rebuilds the native menu.
export interface ShortcutBackend {
  /** The stored override map (null when none is stored). */
  load: () => Promise<ShortcutOverrides | null>
  /** Persist the whole map. */
  save: (overrides: ShortcutOverrides) => Promise<void>
  /** Another window (or the one-time hub adoption) changed the stored map. */
  onChanged?: (listener: (overrides: ShortcutOverrides) => void) => () => void
}

let backend: ShortcutBackend | null = null
let offChanged: (() => void) | null = null

/** Wire the shortcut persistence backend. Call once at renderer boot, before
 *  the store's `load()` runs. */
export function setShortcutBackend(b: ShortcutBackend): void {
  backend = b
  offChanged?.()
  offChanged =
    b.onChanged?.((next) => {
      useShortcutStore.setState({ overrides: normalizeShortcutOverrides(next).overrides })
    }) ?? null
}

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

const persist = async (overrides: ShortcutOverrides): Promise<void> => {
  await backend?.save(overrides)
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  overrides: {},
  isRecording: false,
  loaded: false,

  load: async () => {
    const stored = await (backend?.load() ?? Promise.resolve(null)).catch(() => null)
    // Renames, retired defaults and legacy '' clears (@slayzone/shortcuts) — the same
    // rules main applies when it builds the native menu from the file.
    const { overrides, changed } = normalizeShortcutOverrides(stored)
    if (changed) await persist(overrides).catch(() => undefined)
    set({ overrides, loaded: true })
  },

  getKeys: (id: string) => resolveShortcutKeys(get().overrides, id),

  findConflict: (keys: string, scope: ShortcutScope) => {
    const { overrides } = get()
    return shortcutDefinitions.find((d) => {
      if (d.scope !== scope) return false
      const effective = resolveShortcutKeys(overrides, d.id)
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
      const effective = resolveShortcutKeys(overrides, d.id)
      return effective !== null && effective === keys
    })
  },

  setOverride: async (id: string, keys: string | null) => {
    const newOverrides = { ...get().overrides, [id]: keys }
    set({ overrides: newOverrides })
    await persist(newOverrides)
  },

  batchSetOverrides: async (entries: Record<string, string | null>) => {
    const newOverrides = { ...get().overrides, ...entries }
    set({ overrides: newOverrides })
    await persist(newOverrides)
  },

  resetAll: async () => {
    set({ overrides: {} })
    await persist({})
  },

  setRecording: (recording: boolean) => set({ isRecording: recording })
}))
