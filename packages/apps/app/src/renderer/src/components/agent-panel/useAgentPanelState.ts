import { useCallback } from 'react'
import { useSetting, useSetSettingMutation } from '@slayzone/settings/client'

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
  floatingEnabled: false,
}

const SETTINGS_KEY = 'agentPanelState'

function parseState(raw: string | null | undefined): AgentPanelState {
  if (!raw) return DEFAULT_STATE
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_STATE
  }
}

export function useAgentPanelState(): [
  AgentPanelState,
  (updates: Partial<AgentPanelState>) => void,
] {
  const raw = useSetting(SETTINGS_KEY)
  const state = parseState(raw)
  const setSetting = useSetSettingMutation()

  const updateState = useCallback(
    (updates: Partial<AgentPanelState>) => {
      const next = { ...state, ...updates }
      setSetting.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
    },
    [state, setSetting],
  )

  return [state, updateState]
}
