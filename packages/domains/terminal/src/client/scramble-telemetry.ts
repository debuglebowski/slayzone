/**
 * Telemetry capture for WebGL renderer downgrades.
 *
 * When any detection signal fires (Signal A context-loss / B frame-time /
 * C scramble probe / manual settings flip), we serialize enough state to
 * diagnose the cause after the fact — GPU info, DPR, visibility, recent
 * geometry events, optional canvas screenshot — and ship it through the
 * `diagnostics.recordClientEvent` tRPC mutation so it lands in
 * `diagnostics_events`. Future inspection (`/diagnostics` export, ad-hoc
 * SQL) sees the row with the full payload.
 *
 * Snapshot must be captured *before* the addon is disposed — the GL
 * context goes invalid on dispose, and `canvas.toDataURL` returns blank
 * without preserveDrawingBuffer + a live context. `downgradeToDom` calls
 * `onDowngrade` (which calls this) before its own dispose for exactly
 * this reason.
 */
import { getTrpcClient } from '@slayzone/transport/client'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { DowngradeReason } from './webgl-loader'
import type { DiagEvent } from './terminal-webgl-diag'
import { liveWebglCount, webglContextFor } from './webgl-budget'

/** What we ship per downgrade — keep field names stable for analysis tooling. */
export interface DowngradeSnapshot {
  reason: DowngradeReason
  sessionId: string
  mode?: string
  tsMs: number
  /** `performance.now()` since page load — useful for ordering against rAF logs. */
  perfMs: number
  dpr: number
  visibilityState: DocumentVisibilityState
  hasFocus: boolean
  /** Vendor / renderer strings from `WEBGL_debug_renderer_info`, when available. */
  gpu: { vendor?: string; renderer?: string } | null
  /**
   * `image/png` data URL of the WebGL canvas — present when capture succeeded.
   * Throttled: at most one per {@link SCREENSHOT_MIN_INTERVAL_MS} across all
   * sessions (null for the rest), so a burst of downgrades does not encode a PNG
   * per pane on the main thread.
   */
  screenshotDataUrl: string | null
  /** Tail of the per-session terminal-webgl-diag ring buffer. */
  recentDiagEvents: DiagEvent[]
  /** Cell + viewport metrics at fire time. */
  geometry: {
    cols: number | null
    rows: number | null
    canvasWidth: number | null
    canvasHeight: number | null
  }
  /** Time since last `atlas-correct` event for this session, in ms. -1 if none. */
  msSinceLastAtlasCorrect: number
  /**
   * How many terminals were rendering via WebGL when this fired.
   *
   * xterm's `CharAtlasCache` is module-level, so panes with matching
   * font/size/DPR/theme SHARE one `TextureAtlas` — repacking it invalidates every
   * sharer's vertex data, and a pane that does not repaint keeps painting stale
   * texcoords. That made pane count the single most useful correlate of a scramble
   * report, and it previously had to be reconstructed by hand from other records.
   * Counted from the WebGL budget registry (live addons whose GL context is not
   * lost — webgl-budget.ts). It used to be counted by calling `getContext()` on
   * every canvas of every pane, per downgrade: quadratic in a downgrade burst, and
   * under GPU pressure the probes themselves failed context creation thousands of
   * times.
   */
  webglPaneCount: number | null
}

const reportedDowngrades = new Set<string>()

/**
 * True the first time a (session, reason) downgrade is seen in this renderer —
 * callers skip capture + report after that. A session downgrades at most once per
 * addon anyway; this stops a reload/re-attach loop from re-reporting the same fact.
 */
export function shouldReportDowngrade(sessionId: string, reason: DowngradeReason): boolean {
  const key = `${sessionId}:${reason}`
  if (reportedDowngrades.has(key)) return false
  reportedDowngrades.add(key)
  return true
}

/** Minimum spacing between two screenshot captures (any session). */
export const SCREENSHOT_MIN_INTERVAL_MS = 10_000
let lastScreenshotAt = -Infinity

/** Read GPU vendor + renderer via `WEBGL_debug_renderer_info` (no-op if extension missing). */
function readGpuInfo(
  gl: WebGL2RenderingContext | WebGLRenderingContext | null
): { vendor?: string; renderer?: string } | null {
  try {
    if (!gl) return null
    if (gl.isContextLost()) return null
    const ext = gl.getExtension('WEBGL_debug_renderer_info') as {
      UNMASKED_VENDOR_WEBGL: number
      UNMASKED_RENDERER_WEBGL: number
    } | null
    if (!ext) return null
    return {
      vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? ''),
      renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
    }
  } catch {
    return null
  }
}

/**
 * Capture diagnostic state for a downgrade-about-to-happen. Caller must invoke
 * this while the WebGL addon is still live (`downgradeToDom` arranges this by
 * firing `onDowngrade` before dispose).
 *
 * Reads from `window.__slayzone_terminalDiag` for the recent-events tail —
 * the diag harness has been recording webgl-load / atlas-correct / fit
 * events with cell geometry; the last ~30 give the timeline leading up to
 * the downgrade.
 */
export function captureDowngradeSnapshot(
  addon: WebglAddon,
  terminal: Pick<XTerm, 'element' | 'cols' | 'rows'>,
  reason: DowngradeReason,
  sessionId: string,
  mode: string | undefined
): DowngradeSnapshot {
  // The addon's own GL context — no getContext() probing (see webgl-budget.ts).
  const { canvas, gl } = webglContextFor(terminal.element, addon)
  const gpu = readGpuInfo(gl)

  let screenshotDataUrl: string | null = null
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (
    canvas &&
    canvas.width > 0 &&
    canvas.height > 0 &&
    nowMs - lastScreenshotAt >= SCREENSHOT_MIN_INTERVAL_MS
  ) {
    lastScreenshotAt = nowMs
    try {
      screenshotDataUrl = canvas.toDataURL('image/png')
    } catch {
      // tainted / context-lost canvas — skip; rest of payload still useful.
      screenshotDataUrl = null
    }
  }

  const diagApi = (
    window as unknown as {
      __slayzone_terminalDiag?: { dump: (s?: string) => DiagEvent[] }
    }
  ).__slayzone_terminalDiag
  const recentDiagEvents = diagApi ? diagApi.dump(sessionId).slice(-30) : []

  const now = performance.now()
  let msSinceLastAtlasCorrect = -1
  for (let i = recentDiagEvents.length - 1; i >= 0; i--) {
    if (recentDiagEvents[i].event === 'atlas-correct') {
      msSinceLastAtlasCorrect = Math.round(now - recentDiagEvents[i].t)
      break
    }
  }

  return {
    reason,
    sessionId,
    mode,
    tsMs: Date.now(),
    perfMs: Math.round(now),
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'visible',
    hasFocus: typeof document !== 'undefined' ? document.hasFocus() : true,
    gpu,
    screenshotDataUrl,
    recentDiagEvents,
    geometry: {
      cols: terminal.cols ?? null,
      rows: terminal.rows ?? null,
      canvasWidth: canvas?.width ?? null,
      canvasHeight: canvas?.height ?? null
    },
    msSinceLastAtlasCorrect,
    webglPaneCount: liveWebglCount()
  }
}

/**
 * Ship a captured snapshot through the renderer-side diagnostics mutation. Lands
 * in `diagnostics_events` with `event = 'terminal.webgl_renderer_downgrade'`
 * and the full snapshot as payload (the diagnostics service JSON-serializes
 * the payload column; the screenshot data URL goes along for the ride).
 */
export function reportDowngradeSnapshot(snapshot: DowngradeSnapshot): void {
  try {
    void getTrpcClient().diagnostics.recordClientEvent.mutate({
      event: 'terminal.webgl_renderer_downgrade',
      level: 'warn',
      sessionId: snapshot.sessionId,
      message: `WebGL renderer downgraded (${snapshot.reason})`,
      payload: snapshot as unknown as Record<string, unknown>
    })
  } catch {
    // Diagnostics failures (incl. tRPC client not yet ready) must never block
    // the downgrade itself.
  }
}

/**
 * Counterpart to {@link DowngradeSnapshot}: the denominator payload. Emitted
 * once per session when the WebGL renderer activates cleanly. `count(ok)` is
 * the baseline the downgrade events are measured against (downgrade rate ≈
 * `count(downgrade) / count(ok)`, since a session that downgrades almost always
 * emitted `ok` first — it loads clean, then scrambles later).
 *
 * Keep field names stable for analysis tooling — same contract as DowngradeSnapshot.
 */
export interface RendererOkEvent {
  sessionId: string
  mode?: string
  tsMs: number
  /** Vendor / renderer strings from `WEBGL_debug_renderer_info`, when available. */
  gpu: { vendor?: string; renderer?: string } | null
}

/**
 * Ship a {@link RendererOkEvent} through the renderer-side diagnostics mutation.
 * Lands in `diagnostics_events` with `event = 'terminal.webgl_renderer_ok'`.
 * `level: 'info'` (not warn) — a healthy session is not a problem.
 */
export function reportRendererOk(
  terminal: Pick<XTerm, 'element'>,
  sessionId: string,
  mode: string | undefined,
  addon?: WebglAddon | null
): void {
  try {
    const event: RendererOkEvent = {
      sessionId,
      mode,
      tsMs: Date.now(),
      gpu: readGpuInfo(webglContextFor(terminal.element, addon).gl)
    }
    void getTrpcClient().diagnostics.recordClientEvent.mutate({
      event: 'terminal.webgl_renderer_ok',
      level: 'info',
      sessionId,
      message: 'WebGL renderer active',
      payload: event as unknown as Record<string, unknown>
    })
  } catch {
    // Diagnostics failures (incl. tRPC client not yet ready) must never block
    // rendering.
  }
}
