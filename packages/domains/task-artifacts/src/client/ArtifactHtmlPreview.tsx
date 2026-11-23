import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  resolveReadOnlyLinkClickTarget,
  useHtmlPreviewLinks,
  type LinkOpenTarget
} from '@slayzone/editor'
import { electronBootstrap, useHubId } from '@slayzone/transport/client'
import { useStableCallback } from '@slayzone/ui'
import {
  SLZ_ARTIFACT_SCHEME,
  toArtifactFileUrl,
  toHtmlArtifactPreviewUrl
} from '@slayzone/platform/slz-file-url'
import {
  HTML_PREVIEW_LINK_MESSAGE_TYPE,
  parseHtmlPreviewLinkMessage
} from '@slayzone/platform/html-preview-links'
import { ARTIFACT_DEVICE_PARTITION, type DeviceViewport } from '@slayzone/platform/preview-devices'
import {
  deviceChassisLayout,
  DeviceCameraCutout,
  DeviceChassisBody,
  type ArtifactDeviceFrame
} from './ArtifactDeviceFrame'
import type { HtmlArtifactTheme } from './ArtifactsPanel.constants'

// Hub HTML previews get an origin per artifact so browser storage stays private
// to it. Standalone previews keep the opaque-origin sandbox on slz-file://.
// `contentVersion` cache-busts on each save so the iframe reloads after edits.
//
// The parent is cross-origin, so the main-process protocol handler injects
// the theme CSS before the document loads, using the URL's `?theme=` param.
//
// Zoom cannot go through CSS `zoom` here the way it does for the DOM panes: the
// frame is a separate document on its own origin behind `sandbox`, so the parent
// can neither restyle it nor rely on a layout-scale crossing the frame boundary.
// Shrinking the frame's layout viewport by the zoom factor and scaling the
// element back up by the same factor reproduces browser zoom exactly — the inner
// document reflows to the narrower viewport, then paints enlarged.
export function HtmlPreviewFrame({
  artifactId,
  contentVersion,
  getFilePath,
  zoom,
  htmlTheme,
  deviceViewport,
  deviceFrame,
  onOpenLink
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
  zoom: number
  htmlTheme: HtmlArtifactTheme
  deviceViewport?: DeviceViewport
  deviceFrame?: ArtifactDeviceFrame
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const hubId = useHubId()
  const [src, setSrc] = useState<string | null>(null)
  const [failedViewport, setFailedViewport] = useState<DeviceViewport | null>(null)
  const fallbackToViewport = useCallback(
    () => setFailedViewport(deviceViewport ?? null),
    [deviceViewport]
  )
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Links: the sandbox drops popups and a bare click would navigate the preview
  // itself — main's bridge relays them here instead (html-preview-links.ts).
  useHtmlPreviewLinks(iframeRef, onOpenLink)
  // `null` while in flight or resolved; a string once the path could not be
  // resolved. Previously there was no error branch at all: `getFilePath` had no
  // `.catch` and no null handling, so a rejection OR a null path left `src` null
  // forever and the pane sat on "Loading..." with no retry and no way to tell a
  // slow load from a dead one. That indefinite state is what the e2e preview
  // "flake" was — it never resolved, so no timeout could have saved it.
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Guard the late resolution. The `key` at the call site already remounts this
    // component per artifact/version, so there is no state to reset here; this
    // covers the remaining in-mount case (a `Retry` issued while the previous
    // lookup is still in flight).
    let cancelled = false
    getFilePath(artifactId)
      .then(async (p) => {
        if (cancelled) return
        if (!p) {
          setError('This artifact has no file on disk yet.')
          return
        }
        const theme = htmlTheme === 'system' ? undefined : htmlTheme
        const url = hubId
          ? await toHtmlArtifactPreviewUrl(hubId, artifactId, p, contentVersion, theme)
          : toArtifactFileUrl(null, artifactId, p, contentVersion, theme)
        if (!cancelled) setSrc(url)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not load the preview.')
      })
    return () => {
      cancelled = true
    }
  }, [hubId, artifactId, contentVersion, getFilePath, htmlTheme, attempt])

  if (error)
    return (
      <div
        data-testid="html-preview-error"
        className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <span className="text-destructive">{error}</span>
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    )
  if (!src)
    return (
      <div
        data-testid="html-preview-loading"
        className="flex-1 flex items-center justify-center text-xs text-muted-foreground"
      >
        Loading...
      </div>
    )
  const isArtifactOrigin = src.startsWith(`${SLZ_ARTIFACT_SCHEME}://`)
  const sandbox = isArtifactOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts'
  if (deviceViewport) {
    const configure = isArtifactOrigin ? electronBootstrap.artifactDevicePreview() : null
    const emulationFailed = failedViewport === deviceViewport
    return (
      <DevicePreviewCanvas viewport={deviceViewport} frame={deviceFrame} zoom={zoom}>
        {configure && !emulationFailed ? (
          <ArtifactDeviceGuest
            src={src}
            viewport={deviceViewport}
            configure={configure}
            onFallback={fallbackToViewport}
            onOpenLink={onOpenLink}
          />
        ) : (
          <>
            <iframe
              ref={iframeRef}
              src={src}
              sandbox={sandbox}
              className="block border-0"
              style={{ width: deviceViewport.width, height: deviceViewport.height }}
              title="HTML preview"
            />
            {(deviceViewport.mobile || emulationFailed) && (
              <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-background/90 px-1.5 text-xs text-muted-foreground">
                Viewport only
              </span>
            )}
          </>
        )}
      </DevicePreviewCanvas>
    )
  }
  return (
    <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        src={src}
        sandbox={sandbox}
        className="absolute top-0 left-0 border-0"
        style={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          transform: `scale(${zoom})`,
          transformOrigin: '0 0'
        }}
        title="HTML preview"
      />
    </div>
  )
}

const CANVAS_PADDING = 12

function DevicePreviewCanvas({
  viewport,
  frame,
  zoom,
  children
}: {
  viewport: DeviceViewport
  frame?: ArtifactDeviceFrame
  zoom: number
  children: ReactNode
}) {
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null)
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width && height) setAvailable({ width, height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const chassis = frame ? deviceChassisLayout(frame, viewport) : undefined
  const width = chassis?.width ?? viewport.width
  const height = chassis?.height ?? viewport.height
  const fit = available
    ? Math.min(
        1,
        Math.max(1, available.width - CANVAS_PADDING * 2) / width,
        Math.max(1, available.height - CANVAS_PADDING * 2) / height
      )
    : 1
  const scale = fit * zoom
  const hinge = viewport.displayFeature
  const hingeSize = hinge ? hinge.maskLength || 1 : 0
  return (
    <div ref={measure} className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-surface-0">
      <div className="flex min-h-full min-w-full w-max" style={{ padding: CANVAS_PADDING }}>
        <div
          className="relative m-auto shrink-0 overflow-hidden"
          style={{ width: width * scale, height: height * scale }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width, height, transform: `scale(${scale})` }}
          >
            {frame && chassis && <DeviceChassisBody model={frame.device.id} layout={chassis} />}
            <div
              key="live-screen"
              className={
                chassis
                  ? 'absolute overflow-hidden bg-background'
                  : 'absolute overflow-hidden rounded-sm outline-1 -outline-offset-1 outline-border bg-background'
              }
              style={{
                left: chassis?.screenLeft ?? 0,
                top: chassis?.screenTop ?? 0,
                width: viewport.width,
                height: viewport.height,
                borderRadius: chassis?.chassis.radius
              }}
            >
              {children}
              {hinge && (
                <div
                  aria-hidden="true"
                  className={
                    hinge.maskLength
                      ? chassis
                        ? 'absolute bg-black'
                        : 'absolute bg-surface-0'
                      : 'pointer-events-none absolute bg-border/50'
                  }
                  style={
                    hinge.orientation === 'vertical'
                      ? { top: 0, bottom: 0, left: hinge.offset, width: hingeSize }
                      : { left: 0, right: 0, top: hinge.offset, height: hingeSize }
                  }
                />
              )}
            </div>
            {chassis && <DeviceCameraCutout layout={chassis} />}
          </div>
        </div>
      </div>
    </div>
  )
}

type ConfigureGuest = NonNullable<ReturnType<typeof electronBootstrap.artifactDevicePreview>>
type GuestElement = HTMLElement & { getWebContentsId: () => number }
type GuestMessage = Event & { channel: string; args: unknown[] }

function ArtifactDeviceGuest({
  src,
  viewport,
  configure,
  onFallback,
  onOpenLink
}: {
  src: string
  viewport: DeviceViewport
  configure: ConfigureGuest
  onFallback: () => void
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const [guestId, setGuestId] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const guestRef = useRef<GuestElement | null>(null)
  const fallback = useStableCallback(onFallback)

  useEffect(() => {
    const guest = guestRef.current
    if (!guest) return
    const timer = guest.hasAttribute('src') ? undefined : window.setTimeout(fallback, 10_000)
    const handleReady = () => {
      window.clearTimeout(timer)
      setGuestId(guest.getWebContentsId())
    }
    const handleLoad = (event: Event) => {
      if ((event as Event & { url: string }).url === src) setLoaded(true)
    }
    const handleFailure = (event: Event) => {
      const { errorCode, isMainFrame } = event as Event & {
        errorCode?: number
        isMainFrame?: boolean
      }
      if (isMainFrame !== false && errorCode !== -3) fallback()
    }
    const handleMessage = (event: Event) => {
      const { channel, args } = event as GuestMessage
      if (channel !== HTML_PREVIEW_LINK_MESSAGE_TYPE) return
      const message = parseHtmlPreviewLinkMessage(args[0])
      if (!message) return
      const target = resolveReadOnlyLinkClickTarget(message.url, message)
      if (target) onOpenLink(message.url, target)
    }
    guest.addEventListener('dom-ready', handleReady)
    guest.addEventListener('did-navigate', handleLoad)
    guest.addEventListener('did-fail-load', handleFailure)
    guest.addEventListener('render-process-gone', fallback)
    guest.addEventListener('ipc-message', handleMessage)
    // Attach to the blank guest first so the first artifact script sees the device.
    if (!guest.hasAttribute('src')) guest.setAttribute('src', 'about:blank')
    return () => {
      window.clearTimeout(timer)
      guest.removeEventListener('dom-ready', handleReady)
      guest.removeEventListener('did-navigate', handleLoad)
      guest.removeEventListener('did-fail-load', handleFailure)
      guest.removeEventListener('render-process-gone', fallback)
      guest.removeEventListener('ipc-message', handleMessage)
    }
  }, [fallback, onOpenLink, src])

  useEffect(() => {
    if (guestId === null) return
    let active = true
    void configure(guestId, src, viewport).then(
      (ok) => {
        if (active && !ok) onFallback()
      },
      () => {
        if (active) onFallback()
      }
    )
    return () => {
      active = false
    }
  }, [guestId, src, viewport, configure, onFallback])

  return (
    <>
      <webview
        ref={(node) => {
          guestRef.current = node as GuestElement | null
        }}
        partition={ARTIFACT_DEVICE_PARTITION}
        aria-label="HTML device preview"
        title="Chromium device preview"
        className="block"
        style={{ width: viewport.width, height: viewport.height }}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground">
          Loading…
        </div>
      )}
    </>
  )
}
