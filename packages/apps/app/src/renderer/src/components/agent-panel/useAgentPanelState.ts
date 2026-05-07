import { useState, useEffect, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'

export interface AgentPanelState {
  isOpen: boolean
  panelWidth: number
  sessionIndex: number
  mode?: string
  floatingEnabled: boolean
}

export const DEFAULT_AGENT_PANEL_WIDTH = 400

const DEFAULT_STATE: AgentPanelState = {
  isOpen: false,
  panelWidth: DEFAULT_AGENT_PANEL_WIDTH,
  sessionIndex: 0,
  floatingEnabled: false
}

const SETTINGS_KEY = 'agentPanelState'

export function useAgentPanelState(): [
  AgentPanelState,
  (updates: Partial<AgentPanelState>) => void
] {
  const [state, setState] = useState<AgentPanelState>(DEFAULT_STATE)

  useEffect(() => {
    getTrpcVanillaClient().settings.get.query({ key: SETTINGS_KEY }).then((stored) => {
      if (stored) {
        try {
          setState({ ...DEFAULT_STATE, ...JSON.parse(stored) })
        } catch {
          // ignore parse errors
        }
      }
    })
  }, [])

  const updateState = useCallback((updates: Partial<AgentPanelState>) => {
    setState((prev) => {
      const next = { ...prev, ...updates }
      getTrpcVanillaClient().settings.set.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
      return next
    })
  }, [])

  return [state, updateState]
}
