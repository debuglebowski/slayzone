import type { Terminal as XTerm } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'

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
  /** Schedules the post-load atlas correction (production: `requestAnimationFrame`). */
  requestFrame: (cb: () => void) => void
}

/**
 * Load the WebGL renderer onto an already-opened terminal, then re-rasterize its
 * glyph atlas one frame later so the first paint is not scrambled.
 *
 * Must be called a frame after `open()`+`fit()` so layout has committed — the addon
 * rasterizes its glyph atlas from the measured char-cell size, and building it against
 * stale geometry produces scrambled/overlapping glyphs.
 *
 * Even one frame after `open()`+`fit()` the atlas can be rasterized against not-yet-
 * settled DPR / container geometry. `requestFrame` schedules a render-only correction
 * — `clearTextureAtlas()` + `refresh()` — once more layout has committed. It does not
 * resize, so no SIGWINCH reaches the PTY. It re-rasterizes an atlas built against stale
 * DPR/geometry; it cannot fix a wrong *cell measurement* (only xterm re-measuring does
 * that — font correctness stays the caller's responsibility, see Terminal.tsx).
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

  addon.onContextLoss(() => {
    console.warn('[terminal] WebGL context lost, falling back to DOM renderer')
    addon.dispose()
    if (opts.getActiveAddon() === addon) opts.setActiveAddon(null)
    // Repaint every visible row — the DOM renderer takes over but won't redraw
    // cells last painted by WebGL, leaving stale glyphs on screen.
    try {
      opts.terminal.refresh(0, opts.terminal.rows - 1)
    } catch {
      /* terminal disposed */
    }
  })

  opts.terminal.loadAddon(addon)
  opts.setActiveAddon(addon)

  // Cold-start correction: the atlas was just rasterized from whatever DPR /
  // container geometry was resolved this instant. Re-rasterize it one frame
  // later, after layout has settled, so the first paint is not scrambled.
  // Render-only — no resize, so the PTY never sees a SIGWINCH.
  opts.requestFrame(() => {
    // The terminal may have unmounted, been replaced, or lost its context
    // between frames — only correct the atlas if this addon is still live.
    if (opts.isAborted() || !opts.isCurrentTerminal() || opts.getActiveAddon() !== addon) {
      return
    }
    try {
      addon.clearTextureAtlas()
      opts.terminal.refresh(0, opts.terminal.rows - 1)
    } catch {
      /* terminal disposed between frames */
    }
  })
}
