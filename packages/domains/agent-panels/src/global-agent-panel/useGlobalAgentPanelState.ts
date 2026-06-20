import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

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
  const trpc = useTRPC()
  const [state, setState] = useState<GlobalAgentPanelState>(DEFAULT_STATE)

  const storedQuery = useQuery(trpc.settings.get.queryOptions({ key: SETTINGS_KEY }))
  const setSettings = useMutation(trpc.settings.set.mutationOptions())

  useEffect(() => {
    const stored = storedQuery.data
    if (stored) {
      try {
        setState({ ...DEFAULT_STATE, ...JSON.parse(stored) })
      } catch {
        // ignore parse errors
      }
    }
  }, [storedQuery.data])

  const updateState = useCallback(
    (updates: Partial<GlobalAgentPanelState>) => {
      setState((prev) => {
        const next = { ...prev, ...updates }
        setSettings.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
        return next
      })
    },
    [setSettings]
  )

  return [state, updateState]
}
