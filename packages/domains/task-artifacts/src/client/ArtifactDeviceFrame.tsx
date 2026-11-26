import type { CSSProperties } from 'react'
import type { DeviceViewport, PreviewDevice } from '@slayzone/platform/preview-devices'

export interface ArtifactDeviceFrame {
  device: PreviewDevice
  screen: number
}

interface CameraCutout {
  width: number
  height: number
  top: number
  position?: number
}

type CornerRadii =
  | number
  | readonly [topLeft: number, topRight: number, bottomRight: number, bottomLeft: number]

interface Chassis {
  bezel: { top: number; right: number; bottom: number; left: number }
  radius: CornerRadii
  shellRadius?: CornerRadii
  rim: string
  cutout?: CameraCutout
  bezelCamera?: number
  homeButton?: boolean
  hinge?: 'spine' | 'center'
}

function bezel(vertical: number, horizontal = vertical) {
  return { top: vertical, right: horizontal, bottom: vertical, left: horizontal }
}

const iphone: Chassis = {
  bezel: bezel(11),
  radius: 43,
  rim: '#605951',
  cutout: { width: 124, height: 32, top: 12 }
}

const tablet: Chassis = {
  bezel: bezel(16),
  radius: 14,
  rim: '#525962',
  bezelCamera: 0.5
}

const laptop: Chassis = {
  bezel: bezel(14, 12),
  radius: 12,
  rim: '#525d6d',
  bezelCamera: 0.5
}

const monitor: Chassis = {
  bezel: bezel(12),
  radius: 5,
  rim: '#4c555d'
}

const iphoneDuo: Chassis = {
  bezel: bezel(14),
  radius: 28,
  rim: '#777b83',
  hinge: 'center'
}

const galaxyFold: Chassis = {
  bezel: bezel(13),
  radius: 19,
  rim: '#677482',
  hinge: 'center'
}

const surfaceDuo: Chassis = {
  bezel: bezel(28, 13),
  radius: 3,
  rim: '#737b84',
  bezelCamera: 0.83
}

const chassisById: Record<string, readonly [Chassis, Chassis?]> = {
  'iphone-15-pro': [iphone],
  'iphone-15-pro-max': [{ ...iphone, radius: 47, rim: '#647286' }],
  'iphone-se': [
    {
      bezel: { ...bezel(53, 10), bottom: 61 },
      radius: 0,
      shellRadius: 27,
      rim: '#635f6b',
      bezelCamera: 0.37,
      homeButton: true
    }
  ],
  'pixel-7': [
    {
      bezel: { ...bezel(11), bottom: 16 },
      radius: 25,
      rim: '#6e7562',
      cutout: { width: 17, height: 17, top: 9 }
    }
  ],
  'iphone-duo': [
    {
      ...iphoneDuo,
      bezel: { ...bezel(10, 9), left: 16 },
      radius: [6, 44, 44, 6],
      shellRadius: [12, 52, 52, 12],
      hinge: 'spine',
      // The cover has a corner camera. The inner camera is under the display.
      cutout: { width: 26, height: 26, top: 29, position: 0.91 }
    },
    iphoneDuo
  ],
  'galaxy-z-fold-5': [
    {
      ...galaxyFold,
      bezel: { ...bezel(11), left: 17 },
      radius: [7, 22, 22, 7],
      hinge: 'spine',
      cutout: { width: 15, height: 15, top: 10 }
    },
    galaxyFold
  ],
  'surface-duo': [
    { ...surfaceDuo, bezelCamera: 0.66 },
    { ...surfaceDuo, hinge: 'center' }
  ],
  'ipad-pro': [{ ...tablet, bezel: bezel(18), radius: 17 }]
}

// Reserve room for the bezel's shadow inside the scaled paint area.
const FRAME_MARGIN = 12

function cssRadius(radius: CornerRadii, rotate: boolean, adjustment = 0) {
  if (typeof radius === 'number') return Math.max(0, radius + adjustment)
  const [topLeft, topRight, bottomRight, bottomLeft] = radius
  const corners = rotate ? [bottomLeft, topLeft, topRight, bottomRight] : radius
  return corners.map((corner) => Math.max(0, corner + adjustment) + 'px').join(' ')
}

export function deviceChassisLayout(frame: ArtifactDeviceFrame, viewport: DeviceViewport) {
  const profiles = chassisById[frame.device.id]
  const chassis =
    (frame.screen > 0 ? profiles?.[1] : undefined) ??
    profiles?.[0] ??
    (frame.device.category === 'Desktop'
      ? monitor
      : frame.device.category === 'Laptop'
        ? laptop
        : tablet)

  // Shape the case in its native orientation. Rotate the case and cutouts as
  // a unit while the live screen gets its own upright, rotated viewport.
  const rotated = viewport.angle === 90
  const screenWidth = rotated ? viewport.height : viewport.width
  const screenHeight = rotated ? viewport.width : viewport.height
  const { top, right, bottom, left } = chassis.bezel
  const bodyWidth = screenWidth + left + right
  const bodyHeight = screenHeight + top + bottom

  return {
    chassis,
    width: (rotated ? bodyHeight : bodyWidth) + FRAME_MARGIN * 2,
    height: (rotated ? bodyWidth : bodyHeight) + FRAME_MARGIN * 2,
    screenLeft: FRAME_MARGIN + (rotated ? bottom : left),
    screenTop: FRAME_MARGIN + (rotated ? left : top),
    screenRadius: cssRadius(chassis.radius, rotated),
    screenX: left,
    screenY: top,
    screenWidth,
    layerStyle: {
      left: FRAME_MARGIN,
      top: FRAME_MARGIN,
      width: bodyWidth,
      height: bodyHeight,
      transform: rotated ? 'translateX(' + bodyHeight + 'px) rotate(90deg)' : undefined
    } satisfies CSSProperties
  }
}

type ChassisLayout = ReturnType<typeof deviceChassisLayout>

const layerClass = 'pointer-events-none absolute origin-top-left'

export function DeviceChassisBody({ model, layout }: { model: string; layout: ChassisLayout }) {
  const { chassis, screenX, screenWidth } = layout
  const shellRadius = chassis.shellRadius ?? chassis.radius
  const adjustment = chassis.shellRadius === undefined ? 7 : 0
  return (
    <div
      aria-hidden="true"
      data-testid="artifact-device-frame"
      data-device={model}
      className={layerClass}
      style={{
        ...layout.layerStyle,
        borderRadius: cssRadius(shellRadius, false, adjustment),
        background: chassis.rim,
        boxShadow: '0 2px 7px #0004, inset 0 0 0 1px #ffffff14'
      }}
    >
      <div
        className="absolute inset-[2px]"
        style={{
          borderRadius: cssRadius(shellRadius, false, adjustment - 2),
          background: '#000'
        }}
      />
      {chassis.hinge === 'spine' && (
        <div
          className="absolute inset-y-[7px] left-[2px] w-[4px] rounded-full"
          style={{ background: 'linear-gradient(90deg, #26282d, ' + chassis.rim + ', #151619)' }}
        />
      )}
      {chassis.hinge === 'center' && (
        <div
          className="absolute inset-y-0 w-px bg-black/60"
          style={{ left: screenX + screenWidth / 2 }}
        />
      )}
      {chassis.homeButton && (
        <div
          className="absolute bottom-[13px] left-1/2 size-[32px] -translate-x-1/2 rounded-full border"
          style={{ borderColor: chassis.rim }}
        />
      )}
      {chassis.bezelCamera !== undefined && (
        <div
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black"
          style={{
            top: chassis.bezel.top / 2,
            left: screenX + screenWidth * chassis.bezelCamera
          }}
        />
      )}
    </div>
  )
}

export function DeviceCameraCutout({ layout }: { layout: ChassisLayout }) {
  const camera = layout.chassis.cutout
  if (!camera) return null
  const pill = camera.width > camera.height
  return (
    <div aria-hidden="true" className={layerClass} style={layout.layerStyle}>
      <div
        className="absolute flex -translate-x-1/2 items-center rounded-full"
        style={{
          left: layout.screenX + layout.screenWidth * (camera.position ?? 0.5),
          top: layout.screenY + camera.top,
          width: camera.width,
          height: camera.height,
          justifyContent: pill ? 'flex-end' : 'center',
          paddingRight: pill ? 10 : 0,
          background: '#07080a',
          boxShadow: 'inset 0 0 0 1px #ffffff12'
        }}
      >
        <div
          className="size-2 rounded-full"
          style={{
            background: 'radial-gradient(circle at 35% 30%, #586478, #242b37 36%, #0e1014 74%)'
          }}
        />
      </div>
    </div>
  )
}
