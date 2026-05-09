import { useCallback } from 'react'
import { useSetting, useSetSettingMutation } from '@slayzone/settings/client'

export interface AgentStatusState {
  isLocked: boolean
  filterCurrentProject: boolean
  panelWidth: number
}

export const DEFAULT_AGENT_STATUS_PANEL_WIDTH = 320

const DEFAULT_STATE: AgentStatusState = {
  isLocked: false,
  filterCurrentProject: false,
  panelWidth: DEFAULT_AGENT_STATUS_PANEL_WIDTH,
}

const SETTINGS_KEY = 'agentStatusPanelState'

function parseState(raw: string | null | undefined): AgentStatusState {
  if (!raw) return DEFAULT_STATE
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_STATE
  }
}

export function useAgentStatusState(): [
  AgentStatusState,
  (updates: Partial<AgentStatusState>) => void,
] {
  const raw = useSetting(SETTINGS_KEY)
  const state = parseState(raw)
  const setSetting = useSetSettingMutation()

  const updateState = useCallback(
    (updates: Partial<AgentStatusState>) => {
      const next = { ...state, ...updates }
      setSetting.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
    },
    [state, setSetting],
  )

  return [state, updateState]
}
