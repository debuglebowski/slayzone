import { useState, useEffect, useCallback, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useSubscription, getTrpcClient } from '@slayzone/transport/client'
import type { PanelConfig, PanelView, WebPanelDefinition } from '../shared/types'
import {
  DEFAULT_PANEL_CONFIG,
  isPanelEnabled,
  orderIdToTaskId,
  orderIdToHomeId
} from '../shared/types'
import { mergePanelOrder, mergePredefinedWebPanels } from '../shared/panel-config'

const SETTINGS_KEY = 'panel_config'
const CHANGE_EVENT = 'panel-config-changed'

function loadConfig(): Promise<PanelConfig> {
  return getTrpcClient()
    .settings.get.query({ key: SETTINGS_KEY })
    .then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as PanelConfig
          // Tolerate partial configs: the merge helpers index `webPanels`, so a
          // config missing it must not throw — that would silently reset the
          // user's entire panel layout back to defaults.
          if (!Array.isArray(parsed.webPanels)) parsed.webPanels = []
          return mergePanelOrder(mergePredefinedWebPanels(parsed))
        } catch {
          /* ignore */
        }
      }
      return DEFAULT_PANEL_CONFIG
    })
}

export function usePanelConfig(): {
  config: PanelConfig
  updateConfig: (next: PanelConfig) => Promise<void>
  enabledWebPanels: WebPanelDefinition[]
  isBuiltinEnabled: (id: string, view: PanelView) => boolean
  /** Returns ordered task-view panel IDs (e.g. 'terminal','browser','editor','artifacts','web:*','diff','settings','processes'). */
  getOrderedTaskIds: () => string[]
  /** Returns ordered home-view panel IDs (e.g. 'git','editor','processes','web:*'). Omits task-only panels. */
  getOrderedHomeIds: () => string[]
} {
  const trpc = useTRPC()
  const setSetting = useMutation(trpc.settings.set.mutationOptions())
  const [config, setConfig] = useState<PanelConfig>(DEFAULT_PANEL_CONFIG)

  useEffect(() => {
    void loadConfig().then(setConfig)

    // Cross-component refresh: another instance of this hook (same window) writes
    // the config and dispatches this window CustomEvent. Keep it for in-window sync.
    const onChanged = () => {
      void loadConfig().then(setConfig)
    }
    window.addEventListener(CHANGE_EVENT, onChanged)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChanged)
    }
  }, [])

  // External settings changes (CLI, other windows) — replaces `app.onSettingsChanged`.
  useSubscription(
    trpc.notify.onSettingsChanged.subscriptionOptions(undefined, {
      onData: () => {
        void loadConfig().then(setConfig)
      }
    })
  )

  const updateConfig = useCallback(
    async (next: PanelConfig) => {
      setConfig(next)
      await setSetting.mutateAsync({ key: SETTINGS_KEY, value: JSON.stringify(next) })
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
    },
    [setSetting]
  )

  const enabledWebPanels = useMemo(
    () => config.webPanels.filter((wp) => isPanelEnabled(config, wp.id, 'task')),
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

  return {
    config,
    updateConfig,
    enabledWebPanels,
    isBuiltinEnabled,
    getOrderedTaskIds,
    getOrderedHomeIds
  }
}
