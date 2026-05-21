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
  /** Resolves when webfonts have settled (`document.fonts.ready` in production). */
  fontsReady: Promise<unknown>
  /** Upper bound on the font-settle wait — a missing font must not hang the renderer. */
  fontsReadyTimeoutMs?: number
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
}

/**
 * Load the WebGL renderer onto an already-opened terminal, then correct its glyph
 * atlas once webfonts settle.
 *
 * Must be called a frame after `open()`+`fit()` so layout has committed — the addon
 * rasterizes its atlas from the measured char-cell size, and building it against stale
 * geometry or unsettled font metrics produces scrambled/overlapping glyphs.
 *
 * Failure handling:
 * - construction throwing latches WebGL off for all future terminals (DOM fallback);
 * - a lost GPU context disposes the addon and forces a full repaint so the DOM
 *   renderer does not inherit stale WebGL pixels;
 * - after fonts settle the atlas is cleared and the screen repainted with correct
 *   cell metrics.
 */
export async function loadWebglRenderer(opts: LoadWebglOptions): Promise<void> {
  if (opts.isAborted() || opts.isWebglDisabled() || !opts.isCurrentTerminal()) return

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

  // Font-settle: the atlas was just built with whatever font metrics were resolved
  // at open() time. Once webfonts finish loading, rebuild it so glyph cell sizes
  // match the final font. Bounded — a missing/slow font must not hang the renderer.
  await Promise.race([
    opts.fontsReady,
    new Promise((resolve) => setTimeout(resolve, opts.fontsReadyTimeoutMs ?? 1500))
  ])

  // The terminal may have unmounted, been replaced, or lost its context while we
  // awaited fonts — only correct the atlas if this addon is still the live one.
  if (opts.isAborted() || !opts.isCurrentTerminal() || opts.getActiveAddon() !== addon) {
    return
  }
  try {
    addon.clearTextureAtlas()
    opts.terminal.refresh(0, opts.terminal.rows - 1)
  } catch {
    /* terminal disposed */
  }
}
