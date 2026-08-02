/**
 * TEMPORARY instrumentation — terminal WebGL atlas-scramble investigation.
 *
 * The WebGL glyph atlas is rasterized from the measured char-cell size. If the
 * cell geometry changes (a `fit()` after a layout reflow) and the atlas is not
 * re-rasterized against the new size, every glyph renders from a stale tile —
 * the whole screen scrambles. `webgl-loader.ts` only corrects the atlas across
 * a fixed startup window (next-frame + 250ms + 750ms); a reflow that lands
 * after that window has no correction.
 *
 * This module records, per session, every WebGL load / atlas correction /
 * `fit()` with the cell geometry + DPR at that moment. When a `fit()` changes
 * the cell size away from what the last atlas correction rasterized against,
 * the event is flagged `dirty` — that is the smoking gun: a stale atlas with
 * no pending correction.
 *
 * Inspect from the renderer devtools: `window.__slayzone_terminalDiag.dump()`.
 * Every event is also mirrored to the console (`[term-diag]`).
 *
 * REMOVE once the scramble root cause is fixed and verified.
 */

/** A geometry snapshot — the inputs the WebGL atlas is rasterized against. */
export interface TermGeom {
  /** Device-pixel cell width — the dimension the atlas tiles are sized to. */
  cellDeviceW: number
  /** Device-pixel cell height. */
  cellDeviceH: number
  /** CSS-pixel cell width. */
  cellCssW: number
  /** CSS-pixel cell height. */
  cellCssH: number
  /** `window.devicePixelRatio` at capture time. */
  dpr: number
  cols: number
  rows: number
}

/** One recorded instrumentation event. */
export interface DiagEvent {
  /** ms since page load (`performance.now()`). */
  t: number
  sessionId: string
  event: 'webgl-load' | 'atlas-correct' | 'fit' | 'webgl-context-loss' | 'reactivate'
  /** For `fit` events — which call site fired it. */
  site?: string
  geom?: TermGeom
  /**
   * True when this `fit` moved the cell geometry away from what the last
   * `atlas-correct` rasterized against — i.e. the atlas is now stale and no
   * correction is scheduled. The scramble signal.
   */
  dirty?: boolean
  /**
   * For `reactivate` events — did the isActive false→true handler actually
   * re-fit? `false` is the healthy steady state (geometry unchanged while
   * hidden, so `ensureFit` correctly no-ops); `true` means real drift was
   * caught and corrected.
   *
   * Recorded because the reactivate handler is only OBSERVABLE via its side
   * effects otherwise, and its main side effect is conditional. A test that
   * gates on "a reactivate fit happened" therefore cannot distinguish "the
   * handler ran and found nothing to do" (correct) from "the handler never
   * ran at all" (the regression worth catching) — so it silently stops
   * protecting anything the moment the no-op path becomes the common one.
   */
  refit?: boolean
}

const RING_CAP = 600
const ring: DiagEvent[] = []

/** Per-session: cell key the most recent `atlas-correct` rasterized against. */
const lastCorrectedCellKey = new Map<string, string>()

/** Compact key identifying a cell rasterization target (device px + DPR). */
function cellKey(g: TermGeom | undefined): string | undefined {
  if (!g) return undefined
  return `${g.cellDeviceW}x${g.cellDeviceH}@${g.dpr}`
}

/**
 * Read the cell/canvas geometry xterm currently measures. Uses xterm internals
 * (`_core._renderService.dimensions`) — defensive: any shape mismatch or a
 * stub terminal (unit tests) yields `undefined` rather than throwing.
 */
export function readTermGeometry(terminal: unknown): TermGeom | undefined {
  try {
    const core = (terminal as { _core?: unknown })._core as
      | { _renderService?: { dimensions?: unknown } }
      | undefined
    const dims = core?._renderService?.dimensions as
      | {
          css?: { cell?: { width?: number; height?: number } }
          device?: { cell?: { width?: number; height?: number } }
        }
      | undefined
    const t = terminal as { cols?: number; rows?: number }
    if (!dims?.device?.cell || !dims?.css?.cell) return undefined
    return {
      cellDeviceW: dims.device.cell.width ?? 0,
      cellDeviceH: dims.device.cell.height ?? 0,
      cellCssW: dims.css.cell.width ?? 0,
      cellCssH: dims.css.cell.height ?? 0,
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      cols: t.cols ?? 0,
      rows: t.rows ?? 0
    }
  } catch {
    return undefined
  }
}

/** Record one instrumentation event into the ring + console. */
export function diag(
  sessionId: string,
  event: DiagEvent['event'],
  opts: { site?: string; terminal?: unknown; refit?: boolean } = {}
): void {
  const geom = opts.terminal !== undefined ? readTermGeometry(opts.terminal) : undefined
  const rec: DiagEvent = {
    t: typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now(),
    sessionId,
    event,
    site: opts.site,
    geom
  }
  if (opts.refit !== undefined) rec.refit = opts.refit

  if (event === 'atlas-correct') {
    const k = cellKey(geom)
    if (k) lastCorrectedCellKey.set(sessionId, k)
  } else if (event === 'fit') {
    // `init` = the first fit after a fresh xterm allocation. Any prior
    // `lastCorrectedCellKey` value belongs to a now-disposed addon (cache miss
    // / restart / mode-change re-init), so comparing it against the new init
    // geometry is noise, not a stale-atlas signal. Reset the baseline and
    // never flag dirty for an init.
    if (opts.site === 'init') {
      lastCorrectedCellKey.delete(sessionId)
      rec.dirty = false
    } else {
      const corrected = lastCorrectedCellKey.get(sessionId)
      const now = cellKey(geom)
      // Dirty only if the atlas was corrected at least once AND this fit moved
      // the cell off that target. A fit before any correction is just startup.
      rec.dirty = corrected !== undefined && now !== undefined && corrected !== now
    }
  }

  ring.push(rec)
  if (ring.length > RING_CAP) ring.shift()

  // Only the dirty case is logged — the actionable one. Every other event is
  // recorded silently in the ring buffer; inspect it via window.__slayzone_terminalDiag.
  if (rec.dirty) {
    const detail = geom
      ? `cell=${geom.cellDeviceW}x${geom.cellDeviceH}dev/${geom.cellCssW}x${geom.cellCssH}css dpr=${geom.dpr} ${geom.cols}x${geom.rows}`
      : 'no-geom'
    const tag = `[term-diag] ${sessionId.slice(0, 8)} ${event}${rec.site ? `:${rec.site}` : ''}`
    console.warn(`${tag} ⚠ DIRTY-ATLAS (cell changed, no correction) — ${detail}`)
  }
}

interface DiagApi {
  dump: (sessionId?: string) => DiagEvent[]
  /** Events flagged `dirty` — the scramble candidates. */
  dirty: () => DiagEvent[]
  clear: () => void
}

if (typeof window !== 'undefined') {
  const api: DiagApi = {
    dump: (sessionId) =>
      sessionId ? ring.filter((e) => e.sessionId.startsWith(sessionId)) : [...ring],
    dirty: () => ring.filter((e) => e.dirty),
    clear: () => {
      ring.length = 0
      lastCorrectedCellKey.clear()
    }
  }
  ;(window as unknown as { __slayzone_terminalDiag: DiagApi }).__slayzone_terminalDiag = api
}
