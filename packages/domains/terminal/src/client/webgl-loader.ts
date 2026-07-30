import type { Terminal as XTerm } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { diag } from './terminal-webgl-diag'

/**
 * Why the WebGL renderer was swapped out for the DOM renderer. Each value
 * corresponds to a distinct detection signal in scramble-detector.ts.
 *
 * - `context-loss`  — GPU context dropped (`webglcontextlost` event). System
 *                     suspend / driver reset / OOM. The signal xterm exposes
 *                     natively via `WebglAddon.onContextLoss`.
 * - `frame-time`    — Startup heartbeat measured first ~N rAF deltas and the
 *                     average exceeded the threshold (VS Code's
 *                     `gpuAcceleration: auto` pattern).
 * - `canary`        — Canary glyph probe read back pixels diverging from the
 *                     baseline hash — the atlas scrambled.
 * - `manual`        — User flipped the `forceCompatibilityRenderer` setting.
 */
export type DowngradeReason = 'context-loss' | 'frame-time' | 'canary' | 'manual'

/**
 * Dependencies for {@link loadWebglRenderer}. Everything the routine touches is
 * injected so the lifecycle logic can be unit-tested without a GPU or a real xterm.
 */
export interface LoadWebglOptions {
  /** The xterm instance the renderer attaches to (minimal surface used). */
  terminal: Pick<XTerm, 'loadAddon' | 'refresh' | 'rows'>
  /** Constructs the WebGL addon. Throws if WebGL is unavailable. */
  createAddon: () => WebglAddon
  /** True once the owning component has unmounted. */
  isAborted: () => boolean
  /** True while this terminal is still the active instance for its session. */
  isCurrentTerminal: () => boolean
  /** True once WebGL construction has failed once (process-wide latch). */
  isWebglDisabled: () => boolean
  /** Latches WebGL off for every subsequent terminal. */
  onWebglDisabled: () => void
  /** Current addon stored for this terminal (so context-loss / replacement is detectable). */
  getActiveAddon: () => WebglAddon | null
  setActiveAddon: (addon: WebglAddon | null) => void
  /** Schedules a post-load atlas correction for the next frame (production: `requestAnimationFrame`). */
  requestFrame: (cb: () => void) => void
  /** Schedules a delayed post-load atlas correction (production: `setTimeout`). */
  requestTimeout: (cb: () => void, ms: number) => void
  /**
   * Invoked after a successful downgrade to the DOM renderer (`downgradeToDom`).
   * Lets the React component show a toast and persist a session-scoped flag so
   * a follow-up WebGL load is not re-attempted on the next mount.
   */
  onDowngrade?: (reason: DowngradeReason) => void
  /** Session id — diagnostics only (TEMPORARY, see terminal-webgl-diag.ts). */
  sessionId?: string
  /**
   * Every live terminal that may share this one's glyph atlas, forwarded to
   * {@link correctAtlas} for the startup-window corrections. The atlas is shared
   * process-wide, so a cold-start repack invalidates panes that are already
   * running — see `correctAtlas`.
   */
  getLiveTerminals?: () => Iterable<Pick<XTerm, 'refresh' | 'rows'>>
}

/** Delays (ms after load) of the straggler atlas corrections — see {@link loadWebglRenderer}. */
const CORRECTION_DELAYS_MS = [250, 750]

/**
 * Tear down the WebGL renderer and let xterm fall back to its built-in DOM
 * renderer. Shared by every detection signal (context loss, frame-time
 * heartbeat, canary probe) and the manual settings flag — so the disposal
 * sequence stays identical regardless of who triggered it.
 *
 * After this returns, no `WebglAddon` is attached to the terminal and xterm
 * paints subsequent frames via its built-in DOM renderer. Idempotent: a second
 * call against the same addon is a no-op (the addon already had `dispose`
 * called and the active-addon slot is null).
 *
 * Render path: visible rows are repainted so DOM cells do not inherit stale
 * pixels left over from the last WebGL frame. The `addon.dispose()` throw is
 * swallowed for the same reason `correctAtlas` does — the terminal may have
 * been disposed between the signal firing and this call.
 */
export function downgradeToDom(
  addon: WebglAddon,
  terminal: Pick<XTerm, 'refresh' | 'rows'>,
  opts: {
    setActiveAddon: (addon: WebglAddon | null) => void
    getActiveAddon: () => WebglAddon | null
    onDowngrade?: (reason: DowngradeReason) => void
    sessionId?: string
  },
  reason: DowngradeReason
): void {
  // onDowngrade fires *before* the addon is disposed so the renderer's
  // canvas + GL context are still valid for the caller's snapshot capture
  // (GPU info, screenshot via toDataURL — preserveDrawingBuffer=true on the
  // addon makes the canvas readable here). After this returns we drop the
  // addon and hand the terminal back to xterm's built-in DOM renderer.
  const sid = opts.sessionId ?? 'unknown'
  try {
    opts.onDowngrade?.(reason)
  } catch {
    /* snapshot capture must never block the downgrade itself */
  }
  try {
    addon.dispose()
  } catch {
    /* addon already disposed */
  }
  // Only clear the active-addon slot if it still points to *this* addon — a
  // newer one may have replaced it (e.g. a manual retry between detection +
  // downgrade) and clobbering would orphan the live renderer.
  if (opts.getActiveAddon() === addon) opts.setActiveAddon(null)
  try {
    terminal.refresh(0, terminal.rows - 1)
  } catch {
    /* terminal disposed */
  }
  diag(sid, 'webgl-context-loss', { terminal })
}

/**
 * Re-rasterize the WebGL glyph atlas against the terminal's current cell metrics
 * and repaint every visible row.
 *
 * The atlas is rasterized from the measured char-cell size. Any time that size
 * can have moved — a `fit()` after a layout reflow, a font change, a DPR change —
 * the atlas built against the old size renders every glyph from a stale tile and
 * the screen scrambles. The startup window in {@link loadWebglRenderer} only
 * covers the first ~750ms; callers that resize the terminal *after* that window
 * must call this so the atlas tracks the new geometry.
 *
 * Render-only: `clearTextureAtlas()` + `refresh()`, no resize, so the PTY never
 * sees a SIGWINCH. Safe to call when the atlas is already correct (the next paint
 * simply re-rasterizes identical tiles). Swallows the post-dispose throw.
 *
 * THE single atlas-mutation entry point. `CharAtlasCache` is module-level, so
 * every terminal with matching font/size/DPR/theme shares ONE `TextureAtlas` —
 * clearing it here repacks the atlas for every sharing terminal, not just this
 * one. Routing all mutations through this function keeps that blast radius
 * observable in one place (one `atlas-correct` diag event per mutation, tagged
 * with its call site). Do not call `addon.clearTextureAtlas()` directly; add a
 * `site` label and call this instead.
 *
 * Because the repack is shared, the repaint must be too — see `getLiveTerminals`.
 *
 * @param site Optional call-site label recorded on the diag event, so a
 * correction's origin (startup window, resize, heartbeat, reattach) is
 * distinguishable when reading the ring buffer.
 * @param getLiveTerminals Every live terminal that may share this atlas. xterm
 * rebuilds a renderer's vertex data only on that renderer's next FRAME
 * (`GlyphRenderer.beginFrame()` is reached solely from
 * `WebglRenderer.renderRows`), so a pane that is not painting keeps texcoords
 * pointing into the pre-repack atlas and renders garbage glyphs over a correct
 * layout until something makes it paint. Repainting only the mutating pane
 * therefore *causes* sibling scramble. Measured live (7 panes, 1 shared atlas):
 * siblings sat 52 repacks behind at 0% correct glyphs and did NOT recover across
 * multiple 30s heartbeat ticks — the heartbeat is gated on `isActive`, so it
 * repacks the shared atlas while skipping the panes it invalidates. One
 * `refresh()` each took all seven back to 100%.
 *
 * Broadcast to every live terminal rather than only same-atlas owners: the atlas
 * cache is module-private in `@xterm/addon-webgl` (`CharAtlasCache` exports no
 * reader), so "who shares this atlas" is not answerable through public API, and
 * a non-sharing pane is a genuine no-op — xterm's per-renderer
 * `_lastSeenPageLayoutVersion` compare means an already-current renderer just
 * re-runs `_updateModel` over unchanged rows. Measured cost for a whole 7-pane
 * fleet at 185x95, two rAFs included: 9-14ms, against a 30s heartbeat.
 *
 * Omitting it preserves the old single-pane behaviour (used by call sites that
 * have no registry, and by the unit tests).
 */
export function correctAtlas(
  addon: WebglAddon,
  terminal: Pick<XTerm, 'refresh' | 'rows'>,
  sessionId = 'unknown',
  site?: string,
  getLiveTerminals?: () => Iterable<Pick<XTerm, 'refresh' | 'rows'>>
): void {
  try {
    addon.clearTextureAtlas()
  } catch {
    // Addon disposed — the atlas was never repacked, so nothing went stale and
    // there is nothing to broadcast.
    return
  }

  // Repaint every pane that could be sharing the repacked atlas. Tracked by
  // identity so the mutating terminal is painted exactly once whether or not it
  // is in the registry (a pane mid-mount is not registered yet, but its atlas
  // was still just repacked).
  const painted = new Set<unknown>()
  const paint = (t: Pick<XTerm, 'refresh' | 'rows'>): void => {
    if (painted.has(t)) return
    painted.add(t)
    try {
      t.refresh(0, t.rows - 1)
    } catch {
      // Terminal disposed between registration and this frame. Swallow per
      // terminal, never per broadcast — one stale registry entry must not
      // strand the panes after it in iteration order.
    }
  }

  paint(terminal)

  if (getLiveTerminals) {
    try {
      for (const t of getLiveTerminals()) paint(t)
    } catch {
      /* registry unavailable — the mutating pane is already repainted */
    }
  }

  diag(sessionId, 'atlas-correct', { terminal, site })
}

/**
 * Load the WebGL renderer onto an already-opened terminal, then re-rasterize its
 * glyph atlas across a short startup window so the first paint is not scrambled.
 *
 * Must be called a frame after `open()`+`fit()` so layout has committed — the addon
 * rasterizes its glyph atlas from the measured char-cell size, and building it against
 * stale geometry produces scrambled/overlapping glyphs.
 *
 * Even after `open()`+`fit()` the atlas can be rasterized against not-yet-settled DPR /
 * container geometry — the first paint then shows scrambled glyphs or blank tiles. A
 * plain re-render with settled metrics fixes it (confirmed: scrolling clears the
 * corruption). Since there is no signal for "metrics have settled", the correction —
 * `clearTextureAtlas()` + `refresh()` — runs once next frame and again at each
 * {@link CORRECTION_DELAYS_MS} so a late settle is still caught. It is render-only: no
 * resize, so the PTY never sees a SIGWINCH. It cannot fix a wrong *cell measurement*
 * (only xterm re-measuring does — font correctness stays the caller's responsibility,
 * see Terminal.tsx); it does fix an atlas rasterized against stale DPR/geometry.
 *
 * This window only covers startup. A `fit()` after a later reflow / font / DPR
 * change re-rasterizes the atlas against geometry that may not have settled, and
 * has no correction here — the caller must invoke {@link correctAtlas} after every
 * post-startup `fit()` (see Terminal.tsx).
 *
 * Failure handling:
 * - construction throwing latches WebGL off for all future terminals (DOM fallback);
 * - a lost GPU context disposes the addon and forces a full repaint so the DOM
 *   renderer does not inherit stale WebGL pixels.
 */
export function loadWebglRenderer(opts: LoadWebglOptions): void {
  if (opts.isAborted() || opts.isWebglDisabled() || !opts.isCurrentTerminal()) return
  // A renderer is already attached (e.g. a duplicate rAF) — never load twice.
  if (opts.getActiveAddon()) return

  let addon: WebglAddon
  try {
    addon = opts.createAddon()
  } catch {
    // WebGL unavailable (driver blocklist etc.) — DOM renderer for all terminals.
    opts.onWebglDisabled()
    return
  }

  const sid = opts.sessionId ?? 'unknown'

  addon.onContextLoss(() => {
    console.warn('[terminal] WebGL context lost, falling back to DOM renderer')
    downgradeToDom(
      addon,
      opts.terminal,
      {
        setActiveAddon: opts.setActiveAddon,
        getActiveAddon: opts.getActiveAddon,
        onDowngrade: opts.onDowngrade,
        sessionId: sid
      },
      'context-loss'
    )
  })

  opts.terminal.loadAddon(addon)
  opts.setActiveAddon(addon)
  diag(sid, 'webgl-load', { terminal: opts.terminal })

  // Cold-start correction — re-rasterize the atlas across a short startup window
  // so a paint made before DPR/geometry settled does not stay scrambled. The
  // terminal may have unmounted, been replaced, or lost its context between
  // schedules, so re-check liveness on every run. Render-only — no SIGWINCH.
  const correct = (): void => {
    if (opts.isAborted() || !opts.isCurrentTerminal() || opts.getActiveAddon() !== addon) {
      return
    }
    correctAtlas(addon, opts.terminal, sid, 'startup', opts.getLiveTerminals)
  }
  opts.requestFrame(correct)
  for (const ms of CORRECTION_DELAYS_MS) opts.requestTimeout(correct, ms)
}
