import { PREVIEW_DEVICES } from '@slayzone/platform/preview-devices'
import type { BrowserDeviceDefaults } from '@slayzone/ui'
import type { DeviceEmulation, DeviceSlot, MultiDeviceConfig } from '../shared'

export { MOBILE_UA, IPAD_UA } from '@slayzone/platform/preview-devices'

const DEVICE_PRESETS: DeviceEmulation[] = PREVIEW_DEVICES.filter(
  (device) => device.category !== 'Foldable'
).map(({ name, category, mobile, deviceScaleFactor, userAgent, screens }) => ({
  name,
  category: category === 'Phone' ? 'Mobile' : category,
  mobile,
  deviceScaleFactor,
  userAgent,
  width: screens[0].width,
  height: screens[0].height
}))

/** Default presets per device slot, optionally overridden by user settings */
export function defaultMultiDeviceConfig(
  overrides?: BrowserDeviceDefaults | null
): MultiDeviceConfig {
  const base = {
    desktop: {
      enabled: true,
      preset: { ...DEVICE_PRESETS.find((p) => p.name === 'Desktop 1080p')! }
    },
    tablet: { enabled: true, preset: { ...DEVICE_PRESETS.find((p) => p.name === 'iPad Mini')! } },
    mobile: {
      enabled: true,
      preset: { ...DEVICE_PRESETS.find((p) => p.name === 'iPhone 15 Pro')! }
    }
  }
  if (overrides) {
    for (const slot of ['desktop', 'tablet', 'mobile'] as const) {
      const o = overrides[slot]
      if (o) {
        base[slot].enabled = o.enabled
        base[slot].preset.width = o.width
        base[slot].preset.height = o.height
      }
    }
  }
  return base
}

/** All presets, with slot-relevant ones sorted first */
export function presetsForSlot(slot: DeviceSlot): DeviceEmulation[] {
  const isRelevant = (p: DeviceEmulation) => {
    if (slot === 'desktop') return !p.mobile
    if (slot === 'tablet') return p.mobile && p.width >= 700
    return p.mobile && p.width < 700
  }
  return [...DEVICE_PRESETS.filter(isRelevant), ...DEVICE_PRESETS.filter((p) => !isRelevant(p))]
}
