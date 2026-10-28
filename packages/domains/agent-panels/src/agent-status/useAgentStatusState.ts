import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '../trpc'

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

/** Stored JSON merged over the defaults; null when it does not parse (kept as-is then). */
function parseStoredState(stored: string): AgentStatusState | null {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(stored) }
  } catch {
    return null
  }
}

export function useAgentStatusState(): [
  AgentStatusState,
  (updates: Partial<AgentStatusState>) => void
] {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [state, setState] = useState<AgentStatusState>(DEFAULT_STATE)

  const storedQuery = useQuery(trpc.settings.get.queryOptions({ key: SETTINGS_KEY }))
  const stored = storedQuery.data

  // Hydrate from the persisted value whenever it changes — adjusted during render.
  // Starts as "not loaded" (undefined) so a value already cached at mount hydrates too.
  const [hydratedFrom, setHydratedFrom] = useState<typeof stored>(undefined)
  if (stored !== hydratedFrom) {
    setHydratedFrom(stored)
    const parsed = stored ? parseStoredState(stored) : null
    if (parsed) setState(parsed)
  }

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
