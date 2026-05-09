import { useCallback, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC } from '@slayzone/transport/client'
import { useSetting, useSetSettingMutation } from '@slayzone/settings/client'
import type { PanelConfig, PanelView, WebPanelDefinition } from '../shared/types'
import { DEFAULT_PANEL_CONFIG, isPanelEnabled, orderIdToTaskId, orderIdToHomeId } from '../shared/types'
import { mergePanelOrder, mergePredefinedWebPanels } from '../shared/panel-config'

const SETTINGS_KEY = 'panel_config'
const CHANGE_EVENT = 'panel-config-changed'

function parseConfig(raw: string | null | undefined): PanelConfig {
  if (raw) {
    try {
      return mergePanelOrder(mergePredefinedWebPanels(JSON.parse(raw) as PanelConfig))
    } catch { /* ignore */ }
  }
  return DEFAULT_PANEL_CONFIG
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
  const queryClient = useQueryClient()
  const raw = useSetting(SETTINGS_KEY)
  const setSetting = useSetSettingMutation()

  const config = useMemo(() => parseConfig(raw), [raw])

  // Sibling-component updates (same window) — invalidate cache so useSetting refetches
  useEffect(() => {
    const onChanged = () => {
      queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey({ key: SETTINGS_KEY }) })
    }
    window.addEventListener(CHANGE_EVENT, onChanged)
    return () => window.removeEventListener(CHANGE_EVENT, onChanged)
  }, [queryClient, trpc])

  // Cross-window settings change (CLI / other window edits panel config).
  useSubscription(
    trpc.app.notify.onSettingsChanged.subscriptionOptions(undefined, {
      onData: () => {
        queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey({ key: SETTINGS_KEY }) })
      },
    }),
  )

  const updateConfig = useCallback(async (next: PanelConfig) => {
    await setSetting.mutateAsync({ key: SETTINGS_KEY, value: JSON.stringify(next) })
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  }, [setSetting])

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
