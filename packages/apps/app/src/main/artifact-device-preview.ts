import { session, type WebContents, type WebPreferences } from 'electron'
import { z } from 'zod'
import {
  ARTIFACT_DEVICE_PARTITION,
  MAX_DEVICE_VIEWPORT_SIZE,
  type DeviceViewport
} from '@slayzone/platform/preview-devices'
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
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', {
    enabled: viewport.mobile,
    ...(viewport.mobile ? { maxTouchPoints: 5 } : {})
  })
  await cdp.sendCommand('Emulation.setEmitTouchEventsForMouse', {
    enabled: viewport.mobile,
    configuration: viewport.mobile ? 'mobile' : 'desktop'
  })
  await cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: viewport.userAgent ?? '' })
}

interface PreviewGuest {
  owner: WebContents
  contents: WebContents
  url?: string
  pending: Promise<boolean>
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
      guests.set(id, { owner, contents, pending: Promise.resolve(true) })
      contents.once('destroyed', () => guests.delete(id))
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-navigate', (event) => event.preventDefault())
      contents.on('will-redirect', (event) => event.preventDefault())
      return true
    },

    configure(owner: WebContents, id: number, url: unknown, input: unknown): Promise<boolean> {
      const guest = guests.get(id)
      const viewport = viewportSchema.safeParse(input)
      if (!guest || guest.owner !== owner || typeof url !== 'string' || !viewport.success) {
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
          await applyDeviceViewport(contents, viewport.data)
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
