import { session, type WebContents, type WebPreferences } from 'electron'
import { z } from 'zod'
import {
  ARTIFACT_DEVICE_PARTITION,
  ARTIFACT_DEVICE_TOUCH_INPUT,
  ARTIFACT_DEVICE_TOUCH_MODE,
  MAX_DEVICE_VIEWPORT_SIZE,
  type ArtifactDeviceTouchInput,
  type DeviceViewport,
  zoomDeviceViewport
} from '@slayzone/platform/preview-devices'
import { ZOOM_STEPS } from '@slayzone/task-contracts'
import { parseHtmlArtifactPreviewUrl, SLZ_ARTIFACT_SCHEME } from '@slayzone/platform/slz-file-url'

const dimension = z.int().min(1).max(MAX_DEVICE_VIEWPORT_SIZE)
const viewportSchema = z
  .object({
    width: dimension,
    height: dimension,
    angle: z.union([z.literal(0), z.literal(90)]),
    deviceScaleFactor: z.number().positive().max(4),
    mobile: z.boolean(),
    userAgent: z.string().max(512).optional(),
    posture: z.literal('folded').optional(),
    displayFeature: z
      .object({
        orientation: z.enum(['vertical', 'horizontal']),
        offset: dimension,
        maskLength: z.int().min(0).max(MAX_DEVICE_VIEWPORT_SIZE)
      })
      .optional()
  })
  .refine(({ displayFeature, width, height }) => {
    if (!displayFeature) return true
    const size = displayFeature.orientation === 'vertical' ? width : height
    return displayFeature.offset + displayFeature.maskLength < size
  })

// The artifact zoom control's own range: zoom shrinks the emulated viewport and
// multiplies its pixel ratio, so it is bounded like the viewport is.
const zoomSchema = z
  .number()
  .min(ZOOM_STEPS[0] / 100)
  .max(ZOOM_STEPS[ZOOM_STEPS.length - 1] / 100)

const touchInputSchema = z.object({
  type: z.enum(['touchStart', 'touchMove', 'touchEnd', 'touchCancel']),
  x: z.number().min(-MAX_DEVICE_VIEWPORT_SIZE).max(MAX_DEVICE_VIEWPORT_SIZE),
  y: z.number().min(-MAX_DEVICE_VIEWPORT_SIZE).max(MAX_DEVICE_VIEWPORT_SIZE)
}) satisfies z.ZodType<ArtifactDeviceTouchInput>

async function applyDeviceViewport(guest: WebContents, viewport: DeviceViewport) {
  const { debugger: cdp } = guest
  if (!cdp.isAttached()) cdp.attach()
  await cdp.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
    screenOrientation: {
      type: viewport.width >= viewport.height ? 'landscapePrimary' : 'portraitPrimary',
      angle: viewport.angle
    },
    // Apply the hinge and posture with the metrics. Omitting the hinge on the
    // next metrics update removes it when switching back to a single screen.
    displayFeature: viewport.displayFeature,
    devicePosture: { type: viewport.posture ?? 'continuous' }
  })
  // Touch support only (maxTouchPoints, pointer: coarse). Never
  // Emulation.setEmitTouchEventsForMouse: Chromium has one touch emulator per
  // window, so on a <webview> it turns the whole app's mouse into touch, and the
  // guest can't turn it off again once it is gone. The preload forwards the mouse
  // instead (see ARTIFACT_DEVICE_TOUCH_INPUT).
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', {
    enabled: viewport.mobile,
    ...(viewport.mobile ? { maxTouchPoints: 5 } : {})
  })
  await cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: viewport.userAgent ?? '' })
}

interface PreviewGuest {
  owner: WebContents
  contents: WebContents
  url?: string
  pending: Promise<boolean>
  /** Mouse input becomes touch: the applied viewport is mobile. */
  touch: boolean
  /** A forwarded touch is down. */
  touching: boolean
  /** Touch events replay in order. */
  touchQueue: Promise<void>
}

function dispatchTouch(guest: PreviewGuest, input: ArtifactDeviceTouchInput) {
  const { contents } = guest
  guest.touchQueue = guest.touchQueue
    .then(async () => {
      if (contents.isDestroyed() || !contents.debugger.isAttached()) return
      await contents.debugger.sendCommand('Input.dispatchTouchEvent', {
        type: input.type,
        touchPoints:
          input.type === 'touchStart' || input.type === 'touchMove'
            ? [{ x: input.x, y: input.y }]
            : []
      })
    })
    .catch(() => {
      // The guest navigated, crashed or closed mid-gesture; the next touchStart starts over.
    })
}

function setTouchMode(guest: PreviewGuest, touch: boolean) {
  if (guest.touch === touch) return
  guest.touch = touch
  if (!touch && guest.touching) {
    guest.touching = false
    dispatchTouch(guest, { type: 'touchCancel', x: 0, y: 0 })
  }
  if (!guest.contents.isDestroyed()) guest.contents.send(ARTIFACT_DEVICE_TOUCH_MODE, touch)
}

function forwardTouch(guest: PreviewGuest, input: unknown) {
  const parsed = touchInputSchema.safeParse(input)
  if (!guest.touch || !parsed.success) return
  const touch = parsed.data
  if (touch.type === 'touchStart') {
    if (guest.touching) dispatchTouch(guest, { ...touch, type: 'touchCancel' })
    guest.touching = true
  } else if (!guest.touching) {
    return
  } else if (touch.type !== 'touchMove') {
    guest.touching = false
  }
  dispatchTouch(guest, touch)
}

export function createArtifactDevicePreviews(
  serveArtifact: (request: Request) => Promise<Response>,
  preloadPath: string
) {
  const isolatedSession = session.fromPartition(ARTIFACT_DEVICE_PARTITION)
  const guests = new Map<number, PreviewGuest>()
  isolatedSession.protocol.handle(SLZ_ARTIFACT_SCHEME, serveArtifact)
  isolatedSession.registerPreloadScript({ type: 'frame', filePath: preloadPath })
  isolatedSession.setPermissionCheckHandler(() => false)
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.on('will-download', (event) => event.preventDefault())

  // Serve only the one artifact main authorized for each guest. The partition
  // has no slz-file handler, browser-panel login state or app storage.
  isolatedSession.webRequest.onBeforeRequest(({ url, webContentsId }, callback) => {
    const isArtifact = url.startsWith(`${SLZ_ARTIFACT_SCHEME}://`)
    const authorized = webContentsId === undefined ? undefined : guests.get(webContentsId)?.url
    callback({ cancel: isArtifact && url.split('#', 1)[0] !== authorized })
  })

  return {
    prepare(preferences: WebPreferences, source: string): boolean {
      if (source !== 'about:blank') return false
      delete preferences.preload
      Object.assign(preferences, {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableDialogs: true
      })
      return true
    },

    attach(owner: WebContents, contents: WebContents): boolean {
      if (contents.session !== isolatedSession) return false
      const { id } = contents
      const guest: PreviewGuest = {
        owner,
        contents,
        pending: Promise.resolve(true),
        touch: false,
        touching: false,
        touchQueue: Promise.resolve()
      }
      guests.set(id, guest)
      contents.once('destroyed', () => guests.delete(id))
      // Scoped to this guest's IPC: only its own preload can ask or send.
      contents.ipc.handle(ARTIFACT_DEVICE_TOUCH_MODE, () => guest.touch)
      contents.ipc.on(ARTIFACT_DEVICE_TOUCH_INPUT, (_event, input: unknown) =>
        forwardTouch(guest, input)
      )
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-navigate', (event) => event.preventDefault())
      contents.on('will-redirect', (event) => event.preventDefault())
      return true
    },

    /** `zoomInput` zooms the page inside the device; see {@link zoomDeviceViewport}. */
    configure(
      owner: WebContents,
      id: number,
      url: unknown,
      input: unknown,
      zoomInput: unknown
    ): Promise<boolean> {
      const guest = guests.get(id)
      const viewport = viewportSchema.safeParse(input)
      const zoom = zoomSchema.safeParse(zoomInput)
      if (
        !guest ||
        guest.owner !== owner ||
        typeof url !== 'string' ||
        !viewport.success ||
        !zoom.success
      ) {
        return Promise.resolve(false)
      }

      // Rotation/screen changes can arrive during a prior configuration. Apply
      // them in order without waiting for artifact network requests to finish.
      guest.pending = guest.pending
        .then(async () => {
          const { contents } = guest
          if (contents.isDestroyed()) return false
          if (guest.url ? guest.url !== url : !(await parseHtmlArtifactPreviewUrl(new URL(url)))) {
            return false
          }
          await applyDeviceViewport(contents, zoomDeviceViewport(viewport.data, zoom.data))
          setTouchMode(guest, viewport.data.mobile)
          if (!guest.url) {
            guest.url = url
            void contents.loadURL(url).catch(() => {
              // The webview receives did-fail-load and restores the iframe.
            })
          }
          return true
        })
        .catch(() => false)
      return guest.pending
    }
  }
}
