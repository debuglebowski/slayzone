import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, getTrpcClient } from './trpc'
import type { PanelConfig, PanelView, WebPanelDefinition } from '@slayzone/task-contracts'
import {
  DEFAULT_PANEL_CONFIG,
  isPanelEnabled,
  orderIdToTaskId,
  orderIdToHomeId
} from '@slayzone/task-contracts'
import { mergePanelOrder, mergePredefinedWebPanels } from '@slayzone/task-contracts'

const SETTINGS_KEY = 'panel_config'
const CHANGE_EVENT = 'panel-config-changed'

function parseConfig(raw: string | null | undefined): PanelConfig {
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
}

/**
 * ONE panel config for the whole window, shared by every `usePanelConfig()`
 * (App, Home, and each open task tab). Each instance used to fetch and hold its
 * own copy and subscribe to `settings-changed` itself, so one settings ping made
 * every open tab refetch the same row and re-render with a new (identical)
 * object. Now: one fetch per change, and consumers re-render only when the
 * stored value actually differs.
 *
 * Read from the default hub (`getTrpcClient()`), as before.
 */
const panelConfigStore = (() => {
  let config: PanelConfig = DEFAULT_PANEL_CONFIG
  /** Raw setting behind `config`; undefined until the first load lands. */
  let raw: string | null | undefined
  const listeners = new Set<() => void>()
  let loading: Promise<void> | null = null
  let reloadAgain = false
  let stopExternal: (() => void) | null = null

  const publish = (nextRaw: string | null, next: PanelConfig): void => {
    raw = nextRaw
    config = next
    for (const l of listeners) l()
  }

  /** Re-read the setting. A request during an in-flight read queues one more
   *  read, so a change written after the first read began is never missed. */
  const reload = (): Promise<void> => {
    if (loading) {
      reloadAgain = true
      return loading
    }
    loading = getTrpcClient()
      .settings.get.query({ key: SETTINGS_KEY })
      .then(
        (value) => {
          if (value !== raw) publish(value, parseConfig(value))
        },
        () => {
          /* keep the last-known config; the next change signal retries */
        }
      )
      .then(() => {
        loading = null
        if (reloadAgain) {
          reloadAgain = false
          return reload()
        }
        return undefined
      })
    return loading
  }

  const onWindowChange = (): void => void reload()

  const start = (): void => {
    void reload()
    // In-window writes (another hook instance, the Settings dialog, e2e).
    window.addEventListener(CHANGE_EVENT, onWindowChange)
    // External settings changes (CLI, other windows — a secondary task window gets
    // this window's edits here) — replaces `app.onSettingsChanged`.
    let sub: { unsubscribe: () => void } | null = null
    try {
      sub = getTrpcClient().notify.onSettingsChanged.subscribe(undefined, {
        // Every `settings.set` (any window) signals its key: reload only for ours,
        // or for an unscoped ping (older hub, CLI/REST) that may have written it.
        onData: (event: { keys: string[] | null } | undefined) => {
          if (!event?.keys || event.keys.includes(SETTINGS_KEY)) void reload()
        }
      })
    } catch {
      /* no client yet / subscriptions unsupported — window events still apply */
    }
    stopExternal = () => {
      window.removeEventListener(CHANGE_EVENT, onWindowChange)
      sub?.unsubscribe()
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopExternal?.()
          stopExternal = null
        }
      }
    },
    get: (): PanelConfig => config,
    /** Optimistic local write (the caller persists it). */
    set(next: PanelConfig): void {
      publish(JSON.stringify(next), next)
    }
  }
})()

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
  // `mutateAsync` (stable), not the useMutation() result object (new every render).
  const { mutateAsync: setSetting } = useMutation(trpc.settings.set.mutationOptions())
  const config = useSyncExternalStore(panelConfigStore.subscribe, panelConfigStore.get)

  const updateConfig = useCallback(
    async (next: PanelConfig) => {
      panelConfigStore.set(next)
      await setSetting({ key: SETTINGS_KEY, value: JSON.stringify(next) })
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
