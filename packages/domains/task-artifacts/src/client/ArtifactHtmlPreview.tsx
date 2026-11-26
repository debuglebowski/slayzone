import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
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
import {
  ARTIFACT_DEVICE_PARTITION,
  zoomDeviceViewport,
  type DeviceViewport
} from '@slayzone/platform/preview-devices'
import type {
  HtmlPrototypeActionMessage,
  HtmlPrototypeActionValue
} from '@slayzone/platform/html-prototype-actions'
import {
  withArtifactPreviewMode,
  type ArtifactControlsPosition
} from '@slayzone/platform/artifact-controls'
import { ArtifactControlsDock, type ArtifactControlsSize } from './ArtifactControlsDock'
import { deviceChassisLayout, DeviceCameraCutout, DeviceChassisBody } from './ArtifactDeviceFrame'
import type { ArtifactDevicePreview } from './ArtifactDevicePicker'
import type { HtmlArtifactTheme } from './ArtifactsPanel.constants'
import { ZoomStepper } from './ZoomStepper'

type SendAction = (message: HtmlPrototypeActionMessage) => void
type RegisterActionTarget = (send: SendAction) => () => void
/** Each screen registers once loaded; the docks' actions go to every screen. */
const ActionTargetContext = createContext<RegisterActionTarget | null>(null)
type Docks = Partial<Record<ArtifactControlsPosition, ReactNode>>
const DOCK_GAP = 10
// Until a dock reports what its controls need.
const DEFAULT_DOCK_HEIGHT = 40
const DEFAULT_DOCK_WIDTH = 160

function useActionTarget(ready: boolean, send: SendAction) {
  const register = useContext(ActionTargetContext)
  const sendAction = useStableCallback(send)
  useEffect(() => {
    if (!ready || !register) return
    return register(sendAction)
  }, [ready, register, sendAction])
}

// Hub HTML previews get an origin per artifact so browser storage stays private
// to it. Standalone previews keep the opaque-origin sandbox on slz-file://.
// `contentVersion` cache-busts on each save so the iframe reloads after edits.
//
// The parent is cross-origin, so the main-process protocol handler injects
// the theme CSS before the document loads, using the URL's `?theme=` param.
//
// `<slay-artifact-controls>` (see `@slayzone/platform/artifact-controls`): each
// position used gets a dock, the same document loaded in controls mode, around
// the screen(s); the screens load in screen mode, which hides the controls.
//
// Zoom cannot go through CSS `zoom` here the way it does for the DOM panes: the
// frame is a separate document on its own origin behind `sandbox`, so the parent
// can neither restyle it nor rely on a layout-scale crossing the frame boundary.
// Shrinking the frame's layout viewport by the zoom factor and scaling the
// element back up by the same factor reproduces browser zoom exactly — the inner
// document reflows to the narrower viewport, then paints enlarged.
//
// Device previews have two zooms: `zoom` scales the whole device (frame and
// page alike), display zoom zooms the page inside the device's screen, as if
// its resolution were lower or higher (see `deviceScreenStyle`).
export function HtmlPreviewFrame({
  artifactId,
  contentVersion,
  getFilePath,
  zoom,
  htmlTheme,
  controls,
  devicePreviews = [],
  showDeviceFrame = true,
  displayZoomPct = 100,
  onDisplayZoomPctChange,
  onOpenLink
}: {
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
  zoom: number
  htmlTheme: HtmlArtifactTheme
  controls: readonly ArtifactControlsPosition[]
  devicePreviews?: readonly ArtifactDevicePreview[]
  showDeviceFrame?: boolean
  /** Device previews only; the canvas shows its control when it can be changed. */
  displayZoomPct?: number
  onDisplayZoomPctChange?: (pct: number) => void
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const hubId = useHubId()
  const [src, setSrc] = useState<string | null>(null)
  const [actionTargets, setActionTargets] = useState<SendAction[]>([])
  const registerActionTarget = useCallback<RegisterActionTarget>((send) => {
    setActionTargets((targets) => [...targets, send])
    return () => setActionTargets((targets) => targets.filter((target) => target !== send))
  }, [])
  const [dockSizes, setDockSizes] = useState<
    Partial<Record<ArtifactControlsPosition, ArtifactControlsSize>>
  >({})
  const resizeDock = useCallback(
    (position: ArtifactControlsPosition, size: ArtifactControlsSize) =>
      setDockSizes((sizes) => {
        const old = sizes[position]
        return old?.width === size.width && old.height === size.height
          ? sizes
          : { ...sizes, [position]: size }
      }),
    []
  )
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
  const actionsReady = actionTargets.length === Math.max(devicePreviews.length, 1)
  const dispatchAction = (message: HtmlPrototypeActionMessage) => {
    if (!actionsReady) return
    for (const send of actionTargets) send(message)
  }
  const docks: Docks = {}
  for (const position of controls) {
    docks[position] = (
      <ArtifactControlsDock
        src={src}
        position={position}
        ready={actionsReady}
        onAction={dispatchAction}
        onResize={resizeDock}
      />
    )
  }
  const dockExtent = (position: ArtifactControlsPosition) =>
    position === 'top' || position === 'bottom'
      ? (dockSizes[position]?.height ?? DEFAULT_DOCK_HEIGHT)
      : (dockSizes[position]?.width ?? DEFAULT_DOCK_WIDTH)
  const screenSrc = controls.length > 0 ? withArtifactPreviewMode(src, { kind: 'screen' }) : src
  const edgeDock = (position: 'top' | 'bottom') =>
    docks[position] && (
      <div className="max-h-[50%] shrink-0" style={{ height: dockExtent(position) }}>
        {docks[position]}
      </div>
    )
  const sideDock = (position: 'left' | 'right') =>
    docks[position] && (
      <div className="max-w-[40%] shrink-0" style={{ width: dockExtent(position) }}>
        {docks[position]}
      </div>
    )

  return (
    <ActionTargetContext.Provider value={controls.length > 0 ? registerActionTarget : null}>
      {devicePreviews.length > 0 ? (
        <DevicePreviewCanvas
          previews={devicePreviews}
          docks={docks}
          dockExtent={dockExtent}
          showDeviceFrame={showDeviceFrame}
          zoom={zoom}
          displayZoomPct={displayZoomPct}
          onDisplayZoomPctChange={onDisplayZoomPctChange}
          src={screenSrc}
          sandbox={sandbox}
          configure={isArtifactOrigin ? electronBootstrap.artifactDevicePreview() : null}
          onOpenLink={onOpenLink}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
          {edgeDock('top')}
          <div className="flex min-h-0 min-w-0 flex-1">
            {sideDock('left')}
            <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-background">
              <ArtifactPreviewIframe
                src={screenSrc}
                sandbox={sandbox}
                className="absolute top-0 left-0 border-0"
                style={{
                  width: `${100 / zoom}%`,
                  height: `${100 / zoom}%`,
                  transform: `scale(${zoom})`,
                  transformOrigin: '0 0'
                }}
                onOpenLink={onOpenLink}
              />
            </div>
            {sideDock('right')}
          </div>
          {edgeDock('bottom')}
        </div>
      )}
    </ActionTargetContext.Provider>
  )
}

function ArtifactPreviewIframe({
  src,
  sandbox,
  className,
  style,
  label,
  onOpenLink
}: {
  src: string
  sandbox: string
  className: string
  style: CSSProperties
  label?: string
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  useHtmlPreviewLinks(iframeRef, onOpenLink)
  // IDs are authored by the artifact. The local-preview sandbox has an opaque origin.
  useActionTarget(loaded, (message) => {
    iframeRef.current?.contentWindow?.postMessage(message, '*')
  })
  return (
    <iframe
      ref={iframeRef}
      src={src}
      sandbox={sandbox}
      className={className}
      style={style}
      title={label ? 'HTML preview — ' + label : 'HTML preview'}
      onLoad={() => setLoaded(true)}
    />
  )
}

const CANVAS_PADDING = 12
const COMPARISON_GAP = 16
const CAPTION_HEIGHT = 24

function DevicePreviewCanvas({
  previews,
  docks,
  dockExtent,
  showDeviceFrame,
  zoom,
  displayZoomPct,
  onDisplayZoomPctChange,
  src,
  sandbox,
  configure,
  onOpenLink
}: {
  previews: readonly ArtifactDevicePreview[]
  docks: Docks
  dockExtent: (position: ArtifactControlsPosition) => number
  showDeviceFrame: boolean
  zoom: number
  displayZoomPct: number
  onDisplayZoomPctChange?: (pct: number) => void
  src: string
  sandbox: string
  configure: ConfigureGuest | null
  onOpenLink: (href: string, target: LinkOpenTarget) => void
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

  const screens = previews.map(({ slot, viewport, frame, label }) => {
    const chassis = showDeviceFrame && frame ? deviceChassisLayout(frame, viewport) : undefined
    return {
      slot,
      viewport,
      frame,
      label,
      chassis,
      width: chassis?.width ?? viewport.width,
      height: chassis?.height ?? viewport.height
    }
  })
  const comparing = screens.length > 1
  const gap = comparing ? COMPARISON_GAP : 0
  const captions = comparing ? CAPTION_HEIGHT : 0
  const edgeWidth = available ? Math.max(0, available.width - CANVAS_PADDING * 2) : undefined
  // A dock never takes more than half the height or 40% of the width.
  const extent = (position: ArtifactControlsPosition) => {
    if (!docks[position]) return 0
    const wanted = dockExtent(position)
    if (!available) return wanted
    return position === 'top' || position === 'bottom'
      ? Math.min(wanted, available.height / 2)
      : Math.min(wanted, available.width * 0.4)
  }
  const space = (position: ArtifactControlsPosition) =>
    docks[position] ? extent(position) + DOCK_GAP : 0
  const totalWidth = screens.reduce((sum, screen) => sum + screen.width, 0)
  const tallest = Math.max(...screens.map(({ height }) => height))
  // Use one scale so the on-screen sizes are comparable even in a narrow pane.
  const fit = available
    ? Math.min(
        1,
        Math.max(1, available.width - CANVAS_PADDING * 2 - gap - space('left') - space('right')) /
          totalWidth,
        Math.max(
          1,
          available.height - CANVAS_PADDING * 2 - captions - space('top') - space('bottom')
        ) / tallest
      )
    : 1
  const edgeDock = (position: 'top' | 'bottom') =>
    docks[position] && (
      <div
        className="sticky shrink-0"
        style={{ insetInline: CANVAS_PADDING, height: extent(position), width: edgeWidth }}
      >
        {docks[position]}
      </div>
    )
  const sideDock = (position: 'left' | 'right') =>
    docks[position] && (
      <div className="shrink-0" style={{ width: extent(position) }}>
        {docks[position]}
      </div>
    )
  const scale = fit * zoom
  // Floats over the canvas, in a corner no controls dock is docked along.
  const displayZoomEdge = docks.bottom && !docks.top ? 'top-3' : 'bottom-3'

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={measure}
        data-testid="artifact-device-canvas"
        className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-surface-0"
      >
        <div
          className="flex min-h-full min-w-full w-max flex-col items-center justify-center"
          style={{ padding: CANVAS_PADDING, gap: DOCK_GAP }}
        >
          {edgeDock('top')}
          <div className="flex shrink-0 items-stretch" style={{ gap: DOCK_GAP }}>
            {sideDock('left')}
            <div className="flex shrink-0 items-start" style={{ gap }}>
              {screens.map(({ slot, viewport, frame, label, chassis, width, height }) => {
                const caption = label
                  ? label + ' · ' + viewport.width + ' × ' + viewport.height
                  : undefined
                return (
                  <figure key={slot} className="m-0 shrink-0" style={{ width: width * scale }}>
                    {caption && (
                      <figcaption
                        className="truncate text-center text-xs text-muted-foreground tabular-nums"
                        style={{ height: CAPTION_HEIGHT }}
                        title={caption}
                      >
                        {caption}
                      </figcaption>
                    )}
                    <div className="relative overflow-hidden" style={{ height: height * scale }}>
                      <div
                        className="absolute left-0 top-0 origin-top-left"
                        style={{ width, height, transform: 'scale(' + scale + ')' }}
                      >
                        {frame && chassis && (
                          <DeviceChassisBody model={frame.device.id} layout={chassis} />
                        )}
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
                            borderRadius: chassis?.screenRadius
                          }}
                        >
                          <LiveDevicePreview
                            src={src}
                            sandbox={sandbox}
                            configure={configure}
                            viewport={viewport}
                            zoom={displayZoomPct / 100}
                            label={label}
                            onOpenLink={onOpenLink}
                          />
                          <DeviceHinge feature={viewport.displayFeature} framed={!!chassis} />
                        </div>
                        {chassis && <DeviceCameraCutout layout={chassis} />}
                      </div>
                    </div>
                  </figure>
                )
              })}
            </div>
            {sideDock('right')}
          </div>
          {edgeDock('bottom')}
        </div>
      </div>
      {onDisplayZoomPctChange && (
        <div
          className={
            'absolute right-4 z-10 flex items-center gap-1.5 rounded-lg border border-border bg-popover py-1 pr-1 pl-2 shadow-md ' +
            displayZoomEdge
          }
          title="Above 100%, the page sees a lower resolution; below, a higher one."
        >
          <span className="text-xs text-muted-foreground">Display zoom</span>
          <ZoomStepper
            zoom={displayZoomPct}
            onZoom={onDisplayZoomPctChange}
            label="Display zoom"
            noun="Display zoom"
            testId="artifact-display-zoom"
          />
        </div>
      )}
    </div>
  )
}

function DeviceHinge({
  feature,
  framed
}: {
  feature: DeviceViewport['displayFeature']
  framed: boolean
}) {
  if (!feature) return null
  const size = feature.maskLength || 1
  return (
    <div
      aria-hidden="true"
      className={
        feature.maskLength
          ? framed
            ? 'absolute bg-black'
            : 'absolute bg-surface-0'
          : 'pointer-events-none absolute bg-border/50'
      }
      style={
        feature.orientation === 'vertical'
          ? { top: 0, bottom: 0, left: feature.offset, width: size }
          : { left: 0, right: 0, top: feature.offset, height: size }
      }
    />
  )
}

/**
 * The page's box inside a device screen at `zoom`: the zoomed layout viewport
 * (what the page lays out in), scaled back up to cover the whole screen.
 */
function deviceScreenStyle(viewport: DeviceViewport, zoom: number): CSSProperties {
  const { width, height } = zoomDeviceViewport(viewport, zoom)
  if (zoom === 1) return { width, height }
  return {
    width,
    height,
    // Per axis: the zoomed size is rounded to whole CSS pixels, the screen is not.
    transform: 'scale(' + viewport.width / width + ', ' + viewport.height / height + ')',
    transformOrigin: '0 0'
  }
}

function LiveDevicePreview({
  src,
  sandbox,
  configure,
  viewport,
  zoom,
  label,
  onOpenLink
}: {
  src: string
  sandbox: string
  configure: ConfigureGuest | null
  viewport: DeviceViewport
  zoom: number
  label?: string
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const [failedViewport, setFailedViewport] = useState<DeviceViewport | null>(null)
  const fallback = useCallback(() => setFailedViewport(viewport), [viewport])

  const failed = failedViewport === viewport
  const screenStyle = deviceScreenStyle(viewport, zoom)
  if (configure && !failed) {
    return (
      <ArtifactDeviceGuest
        src={src}
        viewport={viewport}
        zoom={zoom}
        style={screenStyle}
        configure={configure}
        onFallback={fallback}
        onOpenLink={onOpenLink}
        label={label}
      />
    )
  }
  return (
    <>
      <ArtifactPreviewIframe
        src={src}
        sandbox={sandbox}
        className="block border-0"
        style={screenStyle}
        label={label}
        onOpenLink={onOpenLink}
      />
      {(viewport.mobile || failed) && (
        <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-background/90 px-1.5 text-xs text-muted-foreground">
          Viewport only
        </span>
      )}
    </>
  )
}

type ConfigureGuest = NonNullable<ReturnType<typeof electronBootstrap.artifactDevicePreview>>
type GuestElement = HTMLElement & {
  getWebContentsId: () => number
  getURL: () => string
  send: (channel: string, action: string, value?: HtmlPrototypeActionValue) => Promise<void>
}
type GuestMessage = Event & { channel: string; args: unknown[] }

function ArtifactDeviceGuest({
  src,
  viewport,
  zoom,
  style,
  configure,
  onFallback,
  onOpenLink,
  label
}: {
  src: string
  viewport: DeviceViewport
  /** Emulated inside the guest; `style` scales its smaller viewport back up. */
  zoom: number
  style: CSSProperties
  configure: ConfigureGuest
  onFallback: () => void
  label?: string
  onOpenLink: (href: string, target: LinkOpenTarget) => void
}) {
  const [guestId, setGuestId] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const guestRef = useRef<GuestElement | null>(null)
  const fallback = useStableCallback(onFallback)
  useActionTarget(loaded, ({ type, action, value }) => {
    void guestRef.current?.send(type, action, value).catch(fallback)
  })

  useEffect(() => {
    const guest = guestRef.current
    if (!guest) return
    const timer = guest.hasAttribute('src') ? undefined : window.setTimeout(fallback, 10_000)
    const handleReady = () => {
      window.clearTimeout(timer)
      setGuestId(guest.getWebContentsId())
      if (guest.getURL().split('#', 1)[0] === src) setLoaded(true)
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
    guest.addEventListener('did-fail-load', handleFailure)
    guest.addEventListener('render-process-gone', fallback)
    guest.addEventListener('ipc-message', handleMessage)
    // Attach to the blank guest first so the first artifact script sees the device.
    if (!guest.hasAttribute('src')) guest.setAttribute('src', 'about:blank')
    return () => {
      window.clearTimeout(timer)
      guest.removeEventListener('dom-ready', handleReady)
      guest.removeEventListener('did-fail-load', handleFailure)
      guest.removeEventListener('render-process-gone', fallback)
      guest.removeEventListener('ipc-message', handleMessage)
    }
  }, [fallback, onOpenLink, src])

  useEffect(() => {
    if (guestId === null) return
    let active = true
    void configure(guestId, src, viewport, zoom).then(
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
  }, [guestId, src, viewport, zoom, configure, onFallback])

  return (
    <>
      {/* Electron's internal iframe needs the webview's default flex display to fill its height. */}
      <webview
        ref={(node) => {
          guestRef.current = node as GuestElement | null
        }}
        partition={ARTIFACT_DEVICE_PARTITION}
        aria-label={label ? 'HTML device preview — ' + label : 'HTML device preview'}
        title="Chromium device preview"
        style={style}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground">
          Loading…
        </div>
      )}
    </>
  )
}
