import { useState, useEffect, useCallback, useMemo } from 'react'
import type { PanelConfig, PanelView, WebPanelDefinition } from '../shared/types'
import { DEFAULT_PANEL_CONFIG, isPanelEnabled, orderIdToTaskId, orderIdToHomeId } from '../shared/types'
import { mergePanelOrder, mergePredefinedWebPanels } from '../shared/panel-config'

const SETTINGS_KEY = 'panel_config'
const CHANGE_EVENT = 'panel-config-changed'

function loadConfig(): Promise<PanelConfig> {
  return window.api.settings.get(SETTINGS_KEY).then(raw => {
    if (raw) {
      try {
        return mergePanelOrder(mergePredefinedWebPanels(JSON.parse(raw) as PanelConfig))
      } catch { /* ignore */ }
    }
    return DEFAULT_PANEL_CONFIG
  })
}

export function usePanelConfig(): {
  config: PanelConfig
  updateConfig: (next: PanelConfig) => Promise<void>
  enabledWebPanels: WebPanelDefinition[]
  isBuiltinEnabled: (id: string, view: PanelView) => boolean
  /** Returns ordered task-view panel IDs (e.g. 'terminal','browser','editor','assets','web:*','diff','settings','processes'). */
  getOrderedTaskIds: () => string[]
  /** Returns ordered home-view panel IDs (e.g. 'git','editor','processes','web:*'). Omits task-only panels. */
  getOrderedHomeIds: () => string[]
} {
  const [config, setConfig] = useState<PanelConfig>(DEFAULT_PANEL_CONFIG)

  useEffect(() => {
    void loadConfig().then(setConfig)

    const onChanged = () => { void loadConfig().then(setConfig) }
    window.addEventListener(CHANGE_EVENT, onChanged)
    const cleanupIpc = window.api?.app?.onSettingsChanged?.(onChanged)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChanged)
      cleanupIpc?.()
    }
  }, [])

  const updateConfig = useCallback(async (next: PanelConfig) => {
    setConfig(next)
    await window.api.settings.set(SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  }, [])

  const enabledWebPanels = useMemo(
    () => config.webPanels.filter(wp => isPanelEnabled(config, wp.id, 'task')),
    [config]
  )

  const isBuiltinEnabled = useCallback(
    (id: string, view: PanelView) => isPanelEnabled(config, id, view),
    [config]
  )

  const getOrderedTaskIds = useCallback(() => {
    return (config.order ?? []).map(orderIdToTaskId)
  }, [config])

  const getOrderedHomeIds = useCallback(() => {
    const out: string[] = []
    for (const id of config.order ?? []) {
      const h = orderIdToHomeId(id)
      if (h) out.push(h)
    }
    return out
  }, [config])

  return { config, updateConfig, enabledWebPanels, isBuiltinEnabled, getOrderedTaskIds, getOrderedHomeIds }
}
