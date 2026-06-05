import { useCallback, useState } from 'react'
import { track } from '@slayzone/telemetry/client'
import type {
  BrowserTab,
  DeviceEmulation,
  DeviceSlot,
  GridLayout,
  MultiDeviceConfig
} from '../shared'
import { defaultMultiDeviceConfig } from './device-presets'

interface UseBrowserMultiDeviceParams {
  activeTab: BrowserTab | null
  updateActiveTab: (patch: Partial<BrowserTab>) => void
  browserDeviceDefaults: Parameters<typeof defaultMultiDeviceConfig>[0]
}

export function useBrowserMultiDevice({
  activeTab,
  updateActiveTab,
  browserDeviceDefaults
}: UseBrowserMultiDeviceParams) {
  const [reloadTrigger, setReloadTrigger] = useState(0)
  const [forceReloadTrigger, setForceReloadTrigger] = useState(0)

  // Multi-device state (derived from active tab)
  const multiDeviceMode = activeTab?.multiDeviceMode ?? false
  const [defaultConfig] = useState(() => defaultMultiDeviceConfig(browserDeviceDefaults))
  const multiDeviceConfig = activeTab?.multiDeviceConfig ?? defaultConfig
  const multiDeviceLayout: GridLayout = activeTab?.multiDeviceLayout ?? 'horizontal'

  const toggleMultiDevice = useCallback(() => {
    if (!activeTab) return
    const entering = !multiDeviceMode
    // Each tab has its own view — no need to reset ready state
    track('browser_multidevice_toggled')
    updateActiveTab({
      multiDeviceMode: entering,
      ...(entering && !activeTab.multiDeviceConfig
        ? { multiDeviceConfig: defaultMultiDeviceConfig(browserDeviceDefaults) }
        : {}),
      ...(entering && !activeTab.multiDeviceLayout
        ? { multiDeviceLayout: 'horizontal' as GridLayout }
        : {})
    })
  }, [activeTab, multiDeviceMode, updateActiveTab])

  const setMultiDeviceLayout = useCallback(
    (layout: GridLayout) => {
      updateActiveTab({ multiDeviceLayout: layout })
    },
    [updateActiveTab]
  )

  const setMultiDeviceConfig = useCallback(
    (config: MultiDeviceConfig) => {
      updateActiveTab({ multiDeviceConfig: config })
    },
    [updateActiveTab]
  )

  const toggleSlot = useCallback(
    (slot: DeviceSlot) => {
      const newConfig = {
        ...multiDeviceConfig,
        [slot]: { ...multiDeviceConfig[slot], enabled: !multiDeviceConfig[slot].enabled }
      }
      if (!Object.values(newConfig).some((c) => c.enabled)) return
      setMultiDeviceConfig(newConfig)
    },
    [multiDeviceConfig, setMultiDeviceConfig]
  )

  const setPreset = useCallback(
    (slot: DeviceSlot, preset: DeviceEmulation) => {
      setMultiDeviceConfig({ ...multiDeviceConfig, [slot]: { ...multiDeviceConfig[slot], preset } })
    },
    [multiDeviceConfig, setMultiDeviceConfig]
  )

  return {
    multiDeviceMode,
    multiDeviceConfig,
    multiDeviceLayout,
    reloadTrigger,
    forceReloadTrigger,
    setReloadTrigger,
    setForceReloadTrigger,
    toggleMultiDevice,
    setMultiDeviceLayout,
    setMultiDeviceConfig,
    toggleSlot,
    setPreset
  }
}
