export type DeviceCategory = 'Desktop' | 'Laptop' | 'Tablet' | 'Phone' | 'Foldable'

export interface DeviceDisplayFeature {
  orientation: 'vertical' | 'horizontal'
  offset: number
  maskLength: number
}

interface DeviceScreen {
  name?: string
  width: number
  height: number
  displayFeature?: DeviceDisplayFeature
  posture?: 'folded'
}

export interface PreviewDevice {
  id: string
  name: string
  category: DeviceCategory
  deviceScaleFactor: number
  mobile: boolean
  userAgent?: string
  screens: readonly [DeviceScreen, ...DeviceScreen[]]
}

export interface DeviceViewport extends Omit<DeviceScreen, 'name'> {
  deviceScaleFactor: number
  mobile: boolean
  angle: 0 | 90
  userAgent?: string
}

export const MAX_DEVICE_VIEWPORT_SIZE = 4096
export const ARTIFACT_DEVICE_PARTITION = 'persist:artifact-device-previews'

/**
 * Mobile previews turn the mouse into touch inside the preview only. Chromium's own
 * mouse-to-touch emulation is shared by the whole window, so the guest preload
 * forwards primary-button mouse input and main replays it as touch on that guest.
 */
/** Guest → main (invoke) and main → guest (send): whether mouse input becomes touch. */
export const ARTIFACT_DEVICE_TOUCH_MODE = 'artifact-device-preview:touch-mode'
/** Guest → main: one {@link ArtifactDeviceTouchInput} to replay as touch. */
export const ARTIFACT_DEVICE_TOUCH_INPUT = 'artifact-device-preview:touch-input'

export interface ArtifactDeviceTouchInput {
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'
  /** CSS pixels relative to the preview's viewport. */
  x: number
  y: number
}

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function androidUserAgent(model: string) {
  return `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36`
}

function fixedDevice(
  id: string,
  name: string,
  category: DeviceCategory,
  width: number,
  height: number,
  deviceScaleFactor = 1,
  userAgent?: string
): PreviewDevice {
  return {
    id,
    name,
    category,
    deviceScaleFactor,
    mobile: category === 'Phone' || category === 'Tablet',
    userAgent,
    screens: [{ width, height }]
  }
}

export const DEVICE_CATEGORIES: readonly DeviceCategory[] = [
  'Desktop',
  'Laptop',
  'Tablet',
  'Phone',
  'Foldable'
]

export const PREVIEW_DEVICES: readonly PreviewDevice[] = [
  fixedDevice('desktop-1080p', 'Desktop 1080p', 'Desktop', 1920, 1080),
  fixedDevice('desktop-1440p', 'Desktop 1440p', 'Desktop', 2560, 1440),
  fixedDevice('compact-laptop', 'Compact laptop', 'Laptop', 1366, 768),
  fixedDevice('laptop', 'Laptop', 'Laptop', 1440, 900),
  fixedDevice('ipad-mini', 'iPad Mini', 'Tablet', 768, 1024, 2, IPAD_UA),
  fixedDevice('ipad-pro', 'iPad Pro 12.9"', 'Tablet', 1024, 1366, 2, IPAD_UA),
  fixedDevice('iphone-se', 'iPhone SE', 'Phone', 375, 667, 2, MOBILE_UA),
  fixedDevice('iphone-15-pro', 'iPhone 15 Pro', 'Phone', 393, 852, 3, MOBILE_UA),
  fixedDevice('iphone-15-pro-max', 'iPhone 15 Pro Max', 'Phone', 430, 932, 3, MOBILE_UA),
  fixedDevice('pixel-7', 'Pixel 7', 'Phone', 412, 915, 2.625, androidUserAgent('Pixel 7')),
  {
    id: 'iphone-duo',
    name: 'iPhone Duo',
    category: 'Foldable',
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: MOBILE_UA.replaceAll('17_0', '27_0').replace('Version/17.0', 'Version/27.0'),
    // Full displays at 3x, from App Store Connect's device resolutions.
    // https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications#app-preview-resolutions
    screens: [
      { name: 'Cover', width: 466, height: 678 },
      { name: 'Unfolded', width: 951, height: 669 }
    ]
  },
  {
    id: 'galaxy-z-fold-5',
    name: 'Galaxy Z Fold 5',
    category: 'Foldable',
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: androidUserAgent('SM-F946U'),
    screens: [
      { name: 'Cover', width: 344, height: 882 },
      { name: 'Unfolded', width: 690, height: 829 },
      {
        name: 'Partially folded',
        width: 690,
        height: 829,
        posture: 'folded',
        displayFeature: { orientation: 'vertical', offset: 345, maskLength: 0 }
      }
    ]
  },
  {
    id: 'surface-duo',
    name: 'Surface Duo',
    category: 'Foldable',
    deviceScaleFactor: 2.5,
    mobile: true,
    userAgent: androidUserAgent('Surface Duo'),
    screens: [
      { name: 'Single screen', width: 540, height: 720 },
      {
        name: 'Dual screen',
        width: 1114,
        height: 720,
        posture: 'folded',
        displayFeature: { orientation: 'vertical', offset: 540, maskLength: 34 }
      }
    ]
  }
]

export function deviceViewport(device: PreviewDevice, screenIndex: number): DeviceViewport {
  const { width, height, displayFeature, posture } =
    device.screens[screenIndex] ?? device.screens[0]
  return {
    width,
    height,
    displayFeature,
    posture,
    angle: 0,
    mobile: device.mobile,
    deviceScaleFactor: device.deviceScaleFactor,
    userAgent: device.userAgent
  }
}

export function rotateDeviceViewport(viewport: DeviceViewport): DeviceViewport {
  const feature = viewport.displayFeature
  return {
    ...viewport,
    width: viewport.height,
    height: viewport.width,
    angle: viewport.angle === 0 ? 90 : 0,
    displayFeature: feature && {
      ...feature,
      orientation: feature.orientation === 'vertical' ? 'horizontal' : 'vertical'
    }
  }
}
