import { useEffect } from 'react'
import { create } from 'zustand'
import { getTrpcClient } from '@slayzone/transport/client'

export interface GlobalAgentPanelState {
  isOpen: boolean
  panelWidth: number
  sessionIndex: number
  mode?: string
  floatingEnabled: boolean
}

export const DEFAULT_GLOBAL_AGENT_PANEL_WIDTH = 400
export const GLOBAL_AGENT_PANEL_MIN_WIDTH = 320
export const GLOBAL_AGENT_PANEL_MAX_WIDTH = 720

const DEFAULT_STATE: GlobalAgentPanelState = {
  isOpen: false,
  panelWidth: DEFAULT_GLOBAL_AGENT_PANEL_WIDTH,
  sessionIndex: 0,
  floatingEnabled: false
}

const SETTINGS_KEY = 'globalAgentPanelState'

// SHARED singleton store (was per-instance React useState). The panel's open/
// width/session/mode state is owned by ONE source of truth so any consumer can
// read AND drive it consistently — the command palette toggles it from the
// store-driven AppDialogs while HomeView renders the panel from the same state.
// Persists to the settings table via the vanilla tRPC client (mirrors
// useTabStore); hydrates once on first mount.
interface GlobalAgentPanelStore {
  state: GlobalAgentPanelState
  update: (updates: Partial<GlobalAgentPanelState>) => void
  hydrate: () => Promise<void>
}

// Module-scope guards: hydrate runs at most once; an early user toggle must not
// be clobbered by the async hydrate result.
let hydrateStarted = false
let touched = false

const useStore = create<GlobalAgentPanelStore>((set, get) => ({
  state: DEFAULT_STATE,
  update: (updates) => {
    touched = true
    const next = { ...get().state, ...updates }
    set({ state: next })
    void getTrpcClient().settings.set.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
  },
  hydrate: async () => {
    if (hydrateStarted) return
    hydrateStarted = true
    try {
      const stored = await getTrpcClient().settings.get.query({ key: SETTINGS_KEY })
      if (stored && !touched) {
        try {
          set({ state: { ...DEFAULT_STATE, ...JSON.parse(stored) } })
        } catch {
          // ignore parse errors
        }
      }
    } catch {
      // tRPC not ready / no stored value — keep defaults
    }
  }
}))

export function useGlobalAgentPanelState(): [
  GlobalAgentPanelState,
  (updates: Partial<GlobalAgentPanelState>) => void
] {
  const state = useStore((s) => s.state)
  const update = useStore((s) => s.update)
  useEffect(() => {
    void useStore.getState().hydrate()
  }, [])
  return [state, update]
}
