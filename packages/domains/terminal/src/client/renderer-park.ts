/**
 * "Parked" xterm renderer: a renderer that draws nothing, for a terminal nobody
 * can see.
 *
 * Why: xterm always builds a renderer on `open()`. Without WebGL that is the DOM
 * renderer, which injects a theme stylesheet of ~790 rules per terminal (plus a
 * dimensions sheet) into the document. ~50 restored hidden terminals carried
 * ~38k CSS rules that every style recalc in the app paid for, and each injection
 * invalidated the whole document's style during boot. A hidden terminal must keep
 * PARSING output (buffer, modes, scroll position) but needs no pixels until it is
 * revealed — and on reveal it gets WebGL anyway (see webgl-budget.ts).
 *
 * The parked renderer reports the same cell metrics the WebGL renderer computes
 * (device-pixel-floored cell width), so `fit()` on a parked terminal sizes the
 * PTY exactly as it will be once WebGL attaches on reveal: no resize, no SIGWINCH
 * on first reveal. Any renderer swap (`loadAddon(webgl)`, {@link unparkToDom})
 * disposes it.
 *
 * Uses xterm internals (`_core`, `_renderService`, `_createRenderer`) — the same
 * ones `@xterm/addon-webgl` itself uses to swap renderers. Every entry point is
 * defensive: if the shape is not there, nothing is parked and xterm behaves as
 * before (DOM renderer).
 */
import type { Terminal as XTerm } from '@xterm/xterm'

interface Disposable {
  dispose: () => void
}

interface RenderDimensions {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } }
  device: {
    canvas: { width: number; height: number }
    cell: { width: number; height: number }
    char: { width: number; height: number; left: number; top: number }
  }
}

interface RenderServiceLike {
  hasRenderer: () => boolean
  setRenderer: (r: unknown) => void
  handleResize: (cols: number, rows: number) => void
  _isPaused?: boolean
  _handleIntersectionChange?: (entry: {
    isIntersecting: boolean
    intersectionRatio: number
  }) => void
}

interface CoreLike {
  element?: HTMLElement
  onWillOpen?: (listener: (el: HTMLElement) => void) => Disposable
  _renderService?: RenderServiceLike
  _charSizeService?: { width: number; height: number }
  _coreBrowserService?: { dpr: number }
  optionsService?: { rawOptions: { lineHeight: number; letterSpacing: number } }
  _createRenderer?: () => unknown
  cols: number
  rows: number
}

const parked = new WeakSet<object>()

function coreOf(terminal: XTerm): CoreLike | null {
  const core = (terminal as unknown as { _core?: CoreLike })._core
  return core && typeof core === 'object' ? core : null
}

function emptyDimensions(): RenderDimensions {
  return {
    css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
    device: {
      canvas: { width: 0, height: 0 },
      cell: { width: 0, height: 0 },
      char: { width: 0, height: 0, left: 0, top: 0 }
    }
  }
}

/**
 * Cell metrics exactly as `@xterm/addon-webgl`'s `WebglRenderer._updateDimensions`
 * computes them (char width floored to whole device pixels, height ceiled), so a
 * parked terminal fits to the geometry WebGL will render at. Exported for tests.
 */
export function webglCellDimensions(
  charWidth: number,
  charHeight: number,
  dpr: number,
  lineHeight: number,
  letterSpacing: number,
  cols: number,
  rows: number,
  out: RenderDimensions = emptyDimensions()
): RenderDimensions {
  if (!charWidth || !charHeight) return out
  const d = out.device
  d.char.width = Math.floor(charWidth * dpr)
  d.char.height = Math.ceil(charHeight * dpr)
  d.cell.height = Math.floor(d.char.height * lineHeight)
  d.char.top = lineHeight === 1 ? 0 : Math.round((d.cell.height - d.char.height) / 2)
  d.cell.width = d.char.width + Math.round(letterSpacing)
  d.char.left = Math.floor(letterSpacing / 2)
  d.canvas.height = rows * d.cell.height
  d.canvas.width = cols * d.cell.width
  out.css.canvas.height = Math.round(d.canvas.height / dpr)
  out.css.canvas.width = Math.round(d.canvas.width / dpr)
  out.css.cell.height = d.cell.height / dpr
  out.css.cell.width = d.cell.width / dpr
  return out
}

/** Implements xterm's `IRenderer` and draws nothing. */
class ParkedRenderer {
  readonly dimensions: RenderDimensions = emptyDimensions()

  constructor(
    private readonly core: CoreLike,
    private readonly owner: object
  ) {
    parked.add(owner)
    this.update()
  }

  readonly onRequestRedraw = (): Disposable => ({
    dispose: () => {
      // Never fires a redraw request: nothing to unsubscribe.
    }
  })

  private update(): void {
    const cs = this.core._charSizeService
    const opts = this.core.optionsService?.rawOptions
    webglCellDimensions(
      cs?.width ?? 0,
      cs?.height ?? 0,
      this.core._coreBrowserService?.dpr ?? 1,
      opts?.lineHeight ?? 1,
      opts?.letterSpacing ?? 0,
      this.core.cols,
      this.core.rows,
      this.dimensions
    )
  }

  dispose(): void {
    parked.delete(this.owner)
  }
  handleDevicePixelRatioChange(): void {
    this.update()
  }
  handleResize(): void {
    this.update()
  }
  handleCharSizeChanged(): void {
    this.update()
  }
  // Parked: draws nothing, so every paint-related hook below is a deliberate no-op.
  handleBlur(): void {
    // No-op: parked.
  }
  handleFocus(): void {
    // No-op: parked.
  }
  handleSelectionChanged(): void {
    // No-op: parked.
  }
  handleCursorMove(): void {
    // No-op: parked.
  }
  clear(): void {
    // No-op: parked.
  }
  renderRows(): void {
    // No-op: parked.
  }
  clearTextureAtlas(): void {
    // No-op: parked (no atlas).
  }
}

/**
 * Make `terminal` (not yet opened) open with the parked renderer instead of
 * building a DOM renderer. Returns false if xterm's shape is not as expected —
 * then `open()` builds the DOM renderer as usual.
 */
export function parkBeforeOpen(terminal: XTerm): boolean {
  const core = coreOf(terminal)
  if (!core || core.element || typeof core.onWillOpen !== 'function') return false
  const sub = core.onWillOpen(() => {
    sub.dispose()
    const rs = core._renderService
    if (!rs || rs.hasRenderer()) return
    try {
      rs.setRenderer(new ParkedRenderer(core, terminal))
    } catch {
      /* leave it to open() to build the DOM renderer */
    }
  })
  return true
}

/** Swap an opened terminal's current renderer for the parked one. */
export function parkRenderer(terminal: XTerm): boolean {
  const core = coreOf(terminal)
  const rs = core?._renderService
  if (!core || !rs || !core.element) return false
  if (parked.has(terminal)) return true
  try {
    rs.setRenderer(new ParkedRenderer(core, terminal))
    return true
  } catch {
    return false
  }
}

/** True while `terminal` renders with the parked renderer. */
export function isParked(terminal: XTerm | null | undefined): boolean {
  return !!terminal && parked.has(terminal)
}

/**
 * Give a parked terminal xterm's own DOM renderer back — the path for when WebGL
 * is not used after all (disabled, force-compat, load failed). Mirrors what
 * `WebglAddon.dispose()` does. No-op unless parked.
 */
export function unparkToDom(terminal: XTerm): void {
  if (!parked.has(terminal)) return
  const core = coreOf(terminal)
  const rs = core?._renderService
  if (!core || !rs || typeof core._createRenderer !== 'function') return
  try {
    rs.setRenderer(core._createRenderer())
    rs.handleResize(terminal.cols, terminal.rows)
  } catch {
    /* terminal disposed */
  }
}

/**
 * The terminal was just revealed: run xterm's own "became visible" handling now
 * instead of when its IntersectionObserver reports it (a task AFTER the next
 * paint). A renderer attached on reveal has drawn nothing yet, so without this the
 * first frame after the switch shows an empty terminal. Requests a full refresh
 * that lands in the next animation frame, before that paint. If the terminal is
 * in fact still off screen, the observer re-pauses it on its next report.
 */
export function wakeRenderer(terminal: XTerm): void {
  const rs = coreOf(terminal)?._renderService
  if (!rs || !rs._isPaused || typeof rs._handleIntersectionChange !== 'function') return
  try {
    rs._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 })
    terminal.refresh(0, terminal.rows - 1)
  } catch {
    /* terminal disposed */
  }
}
