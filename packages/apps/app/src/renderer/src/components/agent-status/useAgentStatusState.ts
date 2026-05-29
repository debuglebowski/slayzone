import { useState, useEffect, useCallback } from 'react'

export interface AgentStatusState {
  isLocked: boolean
  filterCurrentProject: boolean
  panelWidth: number
}

export const DEFAULT_AGENT_STATUS_PANEL_WIDTH = 320
export const AGENT_STATUS_PANEL_MIN_WIDTH = 240
export const AGENT_STATUS_PANEL_MAX_WIDTH = 480

const DEFAULT_STATE: AgentStatusState = {
  isLocked: false,
  filterCurrentProject: false,
  panelWidth: DEFAULT_AGENT_STATUS_PANEL_WIDTH
}

const SETTINGS_KEY = 'agentStatusPanelState'

export function useAgentStatusState(): [
  AgentStatusState,
  (updates: Partial<AgentStatusState>) => void
] {
  const [state, setState] = useState<AgentStatusState>(DEFAULT_STATE)

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

  const updateState = useCallback((updates: Partial<AgentStatusState>) => {
    setState((prev) => {
      const next = { ...prev, ...updates }
      window.api.settings.set(SETTINGS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  return [state, updateState]
}
