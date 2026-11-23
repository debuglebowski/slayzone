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

interface Chassis {
  form: 'handheld' | 'laptop' | 'monitor'
  bezel: { top: number; right: number; bottom: number; left: number }
  radius: number
  edge: string
  rim: string
  cutout?: CameraCutout
  bezelCamera?: number
  buttons?: boolean
  homeButton?: boolean
  hingeSide?: boolean
}

function bezel(vertical: number, horizontal = vertical) {
  return { top: vertical, right: horizontal, bottom: vertical, left: horizontal }
}

const iphone: Chassis = {
  form: 'handheld',
  bezel: bezel(11),
  radius: 43,
  edge: '#524b43',
  rim: '#bcb2a5',
  cutout: { width: 124, height: 32, top: 12 },
  buttons: true
}

const tablet: Chassis = {
  form: 'handheld',
  bezel: bezel(21),
  radius: 14,
  edge: '#41464e',
  rim: '#9298a0',
  bezelCamera: 0.5
}

const laptop: Chassis = {
  form: 'laptop',
  bezel: { ...bezel(24, 16), bottom: 30 },
  radius: 12,
  edge: '#343a46',
  rim: '#9faab9',
  bezelCamera: 0.5
}

const monitor: Chassis = {
  form: 'monitor',
  bezel: { ...bezel(18), bottom: 32 },
  radius: 5,
  edge: '#30363d',
  rim: '#737f8c'
}

const iphoneDuo: Chassis = {
  ...iphone,
  bezel: bezel(15),
  radius: 32,
  edge: '#3c475d',
  rim: '#8192b1',
  cutout: { width: 112, height: 28, top: 13, position: 0.75 }
}

const galaxyFold: Chassis = {
  form: 'handheld',
  bezel: bezel(13),
  radius: 19,
  edge: '#525d6a',
  rim: '#a3b3c4',
  buttons: true
}

const surfaceDuo: Chassis = {
  form: 'handheld',
  bezel: bezel(43, 13),
  radius: 3,
  edge: '#899096',
  rim: '#e0e4e6',
  bezelCamera: 0.83,
  buttons: true
}

const chassisById: Record<string, readonly [Chassis, Chassis?]> = {
  'iphone-15-pro': [iphone],
  'iphone-15-pro-max': [{ ...iphone, radius: 47, edge: '#3c4658', rim: '#8696ac' }],
  'iphone-se': [
    {
      form: 'handheld',
      bezel: { ...bezel(53, 10), bottom: 61 },
      radius: 0,
      edge: '#4a4851',
      rim: '#a39ea8',
      bezelCamera: 0.37,
      buttons: true,
      homeButton: true
    }
  ],
  'pixel-7': [
    {
      form: 'handheld',
      bezel: { ...bezel(11), bottom: 16 },
      radius: 25,
      edge: '#56604b',
      rim: '#9ba282',
      cutout: { width: 17, height: 17, top: 9 },
      buttons: true
    }
  ],
  'iphone-duo': [
    {
      ...iphoneDuo,
      bezel: { ...bezel(13), left: 21 },
      radius: 35,
      hingeSide: true,
      cutout: { width: 119, height: 30, top: 12 }
    },
    iphoneDuo
  ],
  'galaxy-z-fold-5': [
    {
      ...galaxyFold,
      bezel: { ...bezel(12), left: 20 },
      hingeSide: true,
      cutout: { width: 15, height: 15, top: 10 }
    },
    galaxyFold
  ],
  'surface-duo': [{ ...surfaceDuo, bezelCamera: 0.66 }, surfaceDuo],
  'ipad-pro': [{ ...tablet, bezel: bezel(24), radius: 17 }]
}

// Include the rim, edge buttons and their shadow in the scaled paint area.
const FRAME_MARGIN = 20

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
  const side = chassis.form === 'laptop' ? Math.round(screenWidth * 0.055) : 0
  const baseHeight =
    chassis.form === 'monitor'
      ? Math.round(screenHeight * 0.16)
      : chassis.form === 'laptop'
        ? Math.round(screenWidth * 0.036)
        : 0
  const bodyWidth = screenWidth + chassis.bezel.left + chassis.bezel.right
  const bodyHeight = screenHeight + chassis.bezel.top + chassis.bezel.bottom
  const naturalWidth = bodyWidth + 2 * side
  const naturalHeight = bodyHeight + baseHeight
  const screenX = side + chassis.bezel.left
  const screenY = chassis.bezel.top

  return {
    chassis,
    width: (rotated ? naturalHeight : naturalWidth) + FRAME_MARGIN * 2,
    height: (rotated ? naturalWidth : naturalHeight) + FRAME_MARGIN * 2,
    screenLeft: FRAME_MARGIN + (rotated ? naturalHeight - screenY - screenHeight : screenX),
    screenTop: FRAME_MARGIN + (rotated ? screenX : screenY),
    screenX,
    screenY,
    screenWidth,
    bodyWidth,
    bodyHeight,
    baseHeight,
    side,
    layerStyle: {
      left: FRAME_MARGIN,
      top: FRAME_MARGIN,
      width: naturalWidth,
      height: naturalHeight,
      transform: rotated ? 'translateX(' + naturalHeight + 'px) rotate(90deg)' : undefined
    } satisfies CSSProperties
  }
}

type ChassisLayout = ReturnType<typeof deviceChassisLayout>

const lens = 'radial-gradient(circle at 36% 32%, #7591b0, #1a2030 34%, #090a0d 69%)'
const layerClass = 'pointer-events-none absolute origin-top-left'

export function DeviceChassisBody({ model, layout }: { model: string; layout: ChassisLayout }) {
  const { chassis, side, bodyWidth, bodyHeight, baseHeight, screenX, screenWidth } = layout
  const metal =
    'linear-gradient(155deg, ' +
    chassis.rim +
    ', ' +
    chassis.edge +
    ' 35%, ' +
    chassis.edge +
    ' 70%, ' +
    chassis.rim +
    ')'

  return (
    <div
      aria-hidden="true"
      data-testid="artifact-device-frame"
      data-device={model}
      className={layerClass}
      style={layout.layerStyle}
    >
      {chassis.form === 'monitor' && (
        <>
          <div
            className="absolute left-1/2 w-[12%] -translate-x-1/2"
            style={{
              top: bodyHeight - 2,
              height: baseHeight,
              background: metal,
              clipPath: 'polygon(8% 0, 92% 0, 78% 100%, 22% 100%)'
            }}
          />
          <div
            className="absolute bottom-0 left-1/2 w-[32%] -translate-x-1/2 rounded-[35%]"
            style={{ height: Math.round(baseHeight * 0.16), background: metal }}
          />
        </>
      )}
      <div
        className="absolute top-0"
        style={{
          left: side,
          width: bodyWidth,
          height: bodyHeight,
          borderRadius: chassis.radius + (chassis.form === 'handheld' ? 12 : 7),
          background: metal,
          boxShadow: '0 7px 18px #0006, inset 0 0 0 1px #ffffff40'
        }}
      >
        <div
          className="absolute rounded-[inherit]"
          style={{
            inset: 3,
            background: 'linear-gradient(155deg, #282b31, #101215 35%, #171a1e 78%, #24282e)',
            boxShadow: 'inset 0 0 0 1px #0009'
          }}
        />
        {chassis.hingeSide && (
          <div
            className="absolute left-1 top-[9%] h-[82%] w-1 rounded-full"
            style={{ background: 'linear-gradient(90deg, #ffffff26, #0008)' }}
          />
        )}
        {chassis.buttons && (
          <>
            <div
              className="absolute -right-[2px] top-[24%] h-[8%] w-1 rounded-r-sm"
              style={{ background: chassis.rim }}
            />
            <div
              className="absolute -right-[2px] top-[35%] h-[5%] w-1 rounded-r-sm"
              style={{ background: chassis.edge }}
            />
          </>
        )}
        {chassis.homeButton && (
          <>
            <div
              className="absolute left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-black"
              style={{ top: chassis.bezel.top / 2 }}
            />
            <div
              className="absolute bottom-[11px] left-1/2 size-[38px] -translate-x-1/2 rounded-full"
              style={{
                background: '#14161a',
                border: '2px solid #50535c',
                boxShadow: 'inset 0 1px 4px #000'
              }}
            />
          </>
        )}
      </div>
      {chassis.bezelCamera !== undefined && (
        <div
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            top: chassis.bezel.top / 2,
            left: screenX + screenWidth * chassis.bezelCamera,
            background: lens
          }}
        />
      )}
      {chassis.form === 'laptop' && (
        <>
          <div
            className="absolute inset-x-0"
            style={{
              top: bodyHeight - 2,
              height: baseHeight + 2,
              clipPath: 'polygon(6% 0, 94% 0, 100% 65%, 98% 94%, 2% 94%, 0 65%)',
              background: 'linear-gradient(#65707f, #b3bac4 22%, #8c97a5 66%, #333a45 71%, #6f7884)'
            }}
          />
          <div
            className="absolute left-1/2 h-2 w-[12%] -translate-x-1/2 rounded-b-lg"
            style={{ top: bodyHeight, background: '#46505c' }}
          />
        </>
      )}
    </div>
  )
}

export function DeviceCameraCutout({ layout }: { layout: ChassisLayout }) {
  const camera = layout.chassis.cutout
  if (!camera) return null
  return (
    <div aria-hidden="true" className={layerClass} style={layout.layerStyle}>
      <div
        className="absolute flex -translate-x-1/2 items-center justify-end rounded-full"
        style={{
          left: layout.screenX + layout.screenWidth * (camera.position ?? 0.5),
          top: layout.screenY + camera.top,
          width: camera.width,
          height: camera.height,
          paddingRight: camera.width > camera.height ? 10 : 3,
          background: '#07080a',
          boxShadow: 'inset 0 0 0 1px #ffffff18'
        }}
      >
        <div className="size-2 rounded-full" style={{ background: lens }} />
      </div>
    </div>
  )
}
