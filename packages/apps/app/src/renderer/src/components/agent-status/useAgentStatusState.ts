import { useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'

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
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [state, setState] = useState<AgentStatusState>(DEFAULT_STATE)

  const storedQuery = useQuery(trpc.settings.get.queryOptions({ key: SETTINGS_KEY }))
  const stored = storedQuery.data

  useEffect(() => {
    if (stored) {
      try {
        setState({ ...DEFAULT_STATE, ...JSON.parse(stored) })
      } catch {
        // ignore parse errors
      }
    }
  }, [stored])

  const updateState = useCallback(
    (updates: Partial<AgentStatusState>) => {
      setState((prev) => {
        const next = { ...prev, ...updates }
        void trpcClient.settings.set.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
        return next
      })
    },
    [trpcClient]
  )

  return [state, updateState]
}
