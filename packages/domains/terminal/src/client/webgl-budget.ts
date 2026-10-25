/**
 * Registry + budget for live WebGL terminal renderers.
 *
 * Chromium caps live WebGL contexts per renderer process (~16). Past that it
 * force-loses the oldest one (`webglcontextlost`), which our context-loss signal
 * turns into a DOM downgrade. Restoring ~50 task tabs used to build a WebGL
 * renderer for every terminal, visible or not — 35 contexts were lost on one
 * boot. So a terminal gets WebGL only when it is on screen, and at most
 * {@link MAX_LIVE_WEBGL_RENDERERS} stay live: the most-recently-used ones, so
 * switching among recent tabs never rebuilds a renderer. Over the cap, the least
 * recently used OFF-SCREEN renderer is evicted (its terminal parks — see
 * renderer-park.ts — and rebuilds WebGL on its next reveal). A terminal on screen
 * is never evicted, even over the cap (explode mode can show more).
 *
 * The registry is also the single answer to "which panes run WebGL?" — the
 * downgrade telemetry used to find out by calling `getContext()` on every canvas
 * of every pane, which itself created contexts once the GPU was saturated.
 */
import type { WebglAddon } from '@xterm/addon-webgl'
import { mruRank } from './terminal-mru'

/** Live WebGL renderers kept at most (MRU) — well under Chromium's ~16 contexts. */
export const MAX_LIVE_WEBGL_RENDERERS = 8

export interface WebglBudgetEntry {
  sessionId: string
  addon: WebglAddon
  /** True while the owning terminal is on screen — never evicted then. */
  isOnScreen: () => boolean
  /**
   * Dispose this renderer and park the terminal. Called at most once, only for an
   * off-screen terminal. The addon is untracked by its own `dispose()`.
   */
  evict: () => void
}

const live = new Map<WebglAddon, WebglBudgetEntry>()

/**
 * Track a freshly loaded WebGL addon. Wraps its `dispose()` so EVERY disposal —
 * downgrade, context loss, force-compat, terminal disposal, eviction — removes
 * it from the registry through one choke point.
 */
export function trackWebglAddon(entry: WebglBudgetEntry): void {
  const { addon } = entry
  if (live.has(addon)) {
    live.set(addon, entry)
    return
  }
  const dispose = addon.dispose.bind(addon)
  addon.dispose = (): void => {
    live.delete(addon)
    dispose()
  }
  live.set(addon, entry)
}

/** True while `addon` is tracked and not yet disposed. */
export function isLiveWebglAddon(addon: WebglAddon | null | undefined): boolean {
  return !!addon && live.has(addon)
}

/** Every live WebGL addon (tracked, not disposed). */
export function liveWebglAddons(): WebglAddon[] {
  return Array.from(live.keys())
}

/** Live WebGL renderers whose GL context is not lost (see {@link webglContextOf}). */
export function liveWebglCount(): number {
  let n = 0
  for (const addon of live.keys()) {
    const gl = webglContextOf(addon)
    if (!gl || !gl.isContextLost()) n++
  }
  return n
}

/**
 * Off-screen renderers to evict so at most `max` stay live: least recently used
 * first (by terminal MRU rank, then registration order). Pure — exported for tests.
 */
export function pickEvictions(
  entries: WebglBudgetEntry[],
  max: number,
  rank: (sessionId: string) => number
): WebglBudgetEntry[] {
  const excess = entries.length - max
  if (excess <= 0) return []
  const candidates = entries
    .map((e, order) => ({ e, order }))
    .filter(({ e }) => !e.isOnScreen())
    // Highest rank = least recently used. Ties (never used): oldest registration first.
    .sort((a, b) => rank(b.e.sessionId) - rank(a.e.sessionId) || a.order - b.order)
  return candidates.slice(0, excess).map(({ e }) => e)
}

let enforceScheduled = false

/**
 * Evict over-budget off-screen renderers. Deferred to an idle slice so a reveal
 * that pushed the count over the cap never pays for someone else's teardown.
 */
export function scheduleWebglBudget(): void {
  if (enforceScheduled) return
  enforceScheduled = true
  const run = (): void => {
    enforceScheduled = false
    enforceWebglBudget()
  }
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 1000 })
  } else {
    setTimeout(run, 0)
  }
}

/** Evict now (see {@link scheduleWebglBudget}). */
export function enforceWebglBudget(max: number = MAX_LIVE_WEBGL_RENDERERS): void {
  for (const entry of pickEvictions(Array.from(live.values()), max, mruRank)) {
    if (!live.has(entry.addon)) continue
    try {
      entry.evict()
    } catch {
      /* terminal disposed mid-eviction — the dispose wrapper already untracked it */
    }
    live.delete(entry.addon)
  }
}

// ---------------------------------------------------------------------------
// Canvas / context lookup without probing
// ---------------------------------------------------------------------------

type GL = WebGL2RenderingContext | WebGLRenderingContext

/**
 * The GL context a live WebGL addon renders with, read from the renderer it owns
 * (xterm internals: `addon._renderer._gl`). Never calls `getContext()`. Null when
 * the shape is not there (other xterm build, disposed renderer, unit-test stub).
 */
export function webglContextOf(addon: WebglAddon): GL | null {
  try {
    const renderer = (addon as unknown as { _renderer?: { _gl?: unknown } })._renderer
    const gl = renderer?._gl
    if (gl && typeof (gl as GL).isContextLost === 'function') return gl as GL
  } catch {
    /* private shape changed */
  }
  return null
}

/**
 * The WebGL render canvas under an xterm element. xterm's WebGL renderer appends
 * one class-less `<canvas>` to `.xterm-screen`, next to its 2D overlay layers
 * (`xterm-*-layer`); the DOM renderer has none. (Other small class-less canvases
 * can sit directly under the root, hence the `.xterm-screen` scope.) Pure DOM
 * lookup — no `getContext()` probing.
 */
export function findWebglCanvasIn(root: Element | null | undefined): HTMLCanvasElement | null {
  if (!root) return null
  for (const c of Array.from(root.querySelectorAll('.xterm-screen > canvas'))) {
    if (!/\bxterm-[\w-]*-layer\b/.test(c.className)) return c as HTMLCanvasElement
  }
  return null
}

/**
 * The GL context for a terminal's WebGL canvas: from the live addon when known,
 * else ONE `getContext` on the render canvas only — which returns the context
 * that canvas already has (it was created with `webgl2`) rather than creating one.
 */
export function webglContextFor(
  root: Element | null | undefined,
  addon?: WebglAddon | null
): { canvas: HTMLCanvasElement | null; gl: GL | null } {
  const canvas = findWebglCanvasIn(root)
  const fromAddon = addon ? webglContextOf(addon) : null
  if (fromAddon) return { canvas: (fromAddon.canvas as HTMLCanvasElement) ?? canvas, gl: fromAddon }
  if (!canvas) return { canvas: null, gl: null }
  try {
    return { canvas, gl: canvas.getContext('webgl2') as WebGL2RenderingContext | null }
  } catch {
    return { canvas, gl: null }
  }
}

/** Test seam. */
export function __resetWebglBudgetForTest(): void {
  live.clear()
  enforceScheduled = false
}
