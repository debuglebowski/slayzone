import { useCallback } from 'react'
import { useSetting, useSetSettingMutation } from '@slayzone/settings/client'

export interface GlobalAgentPanelState {
  isOpen: boolean
  panelWidth: number
  sessionIndex: number
  mode?: string
  floatingEnabled: boolean
}

export const DEFAULT_GLOBAL_AGENT_PANEL_WIDTH = 400

const DEFAULT_STATE: GlobalAgentPanelState = {
  isOpen: false,
  panelWidth: DEFAULT_GLOBAL_AGENT_PANEL_WIDTH,
  sessionIndex: 0,
  floatingEnabled: false,
}

const SETTINGS_KEY = 'globalAgentPanelState'

function parseState(raw: string | null | undefined): GlobalAgentPanelState {
  if (!raw) return DEFAULT_STATE
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_STATE
  }
}

export function useGlobalAgentPanelState(): [
  GlobalAgentPanelState,
  (updates: Partial<GlobalAgentPanelState>) => void,
] {
  const raw = useSetting(SETTINGS_KEY)
  const state = parseState(raw)
  const setSetting = useSetSettingMutation()

  const updateState = useCallback(
    (updates: Partial<GlobalAgentPanelState>) => {
      const next = { ...state, ...updates }
      setSetting.mutate({ key: SETTINGS_KEY, value: JSON.stringify(next) })
    },
    [state, setSetting],
  )

  return [state, updateState]
}
