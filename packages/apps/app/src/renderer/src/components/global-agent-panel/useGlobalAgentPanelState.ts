import { useState, useEffect, useCallback } from 'react'

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

export function useGlobalAgentPanelState(): [
  GlobalAgentPanelState,
  (updates: Partial<GlobalAgentPanelState>) => void
] {
  const [state, setState] = useState<GlobalAgentPanelState>(DEFAULT_STATE)

  useEffect(() => {
    window.api.settings.get(SETTINGS_KEY).then((stored) => {
      if (stored) {
        try {
          setState({ ...DEFAULT_STATE, ...JSON.parse(stored) })
        } catch {
          // ignore parse errors
        }
      }
    })
  }, [])

  const updateState = useCallback((updates: Partial<GlobalAgentPanelState>) => {
    setState((prev) => {
      const next = { ...prev, ...updates }
      window.api.settings.set(SETTINGS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  return [state, updateState]
}
