import { useState, useEffect, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'

export interface AgentStatusState {
  isLocked: boolean
  filterCurrentProject: boolean
  panelWidth: number
}

export const DEFAULT_AGENT_STATUS_PANEL_WIDTH = 320

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

  const updateState = useCallback((updates: Partial<AgentStatusState>) => {
    setState((prev) => {
      const next = { ...prev, ...updates }
      getTrpcVanillaClient().settings.set.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
      return next
    })
  }, [])

  return [state, updateState]
}
