/**
 * The terminal inside the phone's web view (`TerminalDom.tsx`): xterm.js showing a
 * session the phone only WATCHES. Plain class over a terminal factory, so its rules
 * are tested without a browser.
 *
 * - Read-only: `disableStdin` — xterm generates no input at all, so it never answers
 *   a program's queries (colour, mode, cursor reports). The hub answers those for
 *   every client; a second client's answer would land in the agent's stdin as typed
 *   bytes. The device-status / XTVERSION reply suppression desktop installs
 *   (`@slayzone/terminal/suppress-device-status`) is installed too, as a second line.
 *   Keys come from the native key bar and text field instead.
 * - Session size: `resize(cols, rows)` takes the hub's size for the session (the
 *   phone never resizes the agent's terminal) and fits it to the screen by font size
 *   (`terminal-scale.ts`); a pinch zooms, a double tap toggles fit ↔ readable.
 * - Reports the cursor-key mode (DECCKM) when it changes, so the key bar's arrows send
 *   what xterm would.
 * - Touch scroll the PROGRAM takes (mouse wheel reports, or the alternate screen):
 *   xterm would send it as input, which read-only drops — so the view encodes it
 *   (`touch-scroll.ts`) and hands it to `onInput`. Scrollback scrolling stays xterm's.
 *   The mouse encoding is not public in xterm: the view follows the same DECSET /
 *   DECRST / RIS sequences xterm does, without consuming them.
 */
import {
  suppressDeviceStatusReplies,
  suppressXtVersionReply
} from '@slayzone/terminal/suppress-device-status'
import type { TerminalThemeColors } from '@slayzone/theme-tokens'
import type { Terminal as XTerm } from '@xterm/xterm'
import { clampZoom, fitFontSize, readableZoom } from './terminal-scale'
import {
  type MouseEncoding,
  type MouseTracking,
  ScrollAccumulator,
  type ScrollModes,
  scrollGoesToProgram,
  touchScrollBytes
} from './touch-scroll'

type CsiParams = (number | number[])[]

/** The xterm.js surface this view uses. */
export interface TerminalLike {
  cols: number
  rows: number
  options: { fontSize?: number; theme?: unknown }
  modes: { applicationCursorKeysMode: boolean; mouseTrackingMode: MouseTracking }
  buffer: { active: { type: 'normal' | 'alternate' } }
  parser: Pick<XTerm['parser'], 'registerCsiHandler' | 'registerEscHandler'>
  open(element: HTMLElement): void
  write(data: string, callback?: () => void): void
  reset(): void
  resize(cols: number, rows: number): void
  dispose(): void
}

/** A rectangle in the web view's viewport (`getBoundingClientRect`). */
export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/** Where the terminal is shown, and what the fit and touch scroll measure. */
export interface XtermHost {
  element: HTMLElement
  /** The width available to the terminal (the web view's). */
  viewportWidth(): number
  /** The terminal's rendered cells (all columns × rows) at the current font size. */
  screenRect(): ScreenRect
}

export interface XtermOptions {
  cols: number
  rows: number
  fontSize: number
  fontFamily: string
  disableStdin: true
  cursorBlink: false
  scrollback: number
  theme?: TerminalThemeColors
}

export interface XtermEvents {
  onModes?: (modes: { applicationCursorKeys: boolean }) => void
  /** Bytes for the program from a gesture (touch scroll), as xterm would send them. */
  onInput?: (data: string) => void
}

const BASE_FONT = 14
const FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'
/** Lines kept above the screen to scroll back through. */
const SCROLLBACK = 5_000

export class XtermView {
  private readonly term: TerminalLike
  private fitFont = BASE_FONT
  private zoom = 1
  private pinchZoom = 1
  private applicationCursorKeys = false
  private mouseEncoding: MouseEncoding = 'default'
  private readonly scroll = new ScrollAccumulator()

  constructor(
    create: (options: XtermOptions) => TerminalLike,
    private readonly host: XtermHost,
    private readonly events: XtermEvents,
    theme?: TerminalThemeColors
  ) {
    this.term = create({
      cols: 80,
      rows: 24,
      fontSize: BASE_FONT,
      fontFamily: FONT_FAMILY,
      disableStdin: true,
      cursorBlink: false,
      scrollback: SCROLLBACK,
      ...(theme ? { theme } : {})
    })
    const parserOwner = this.term as unknown as Pick<XTerm, 'parser'>
    suppressDeviceStatusReplies(parserOwner)
    suppressXtVersionReply(parserOwner)
    this.followMouseEncoding()
    this.term.open(host.element)
    this.refit()
  }

  write(data: string): void {
    this.term.write(data, () => this.checkModes())
  }

  reset(): void {
    this.term.reset()
    this.mouseEncoding = 'default'
    this.checkModes()
  }

  /** The session's size (from the hub); the font follows so every column fits. */
  resize(cols: number, rows: number): void {
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows)
    this.refit()
  }

  /** The screen changed (rotation, split view): fit again, keeping the zoom. */
  refit(): void {
    const current = this.term.options.fontSize ?? BASE_FONT
    this.fitFont = fitFontSize(current, this.host.screenRect().width, this.host.viewportWidth())
    this.zoom = clampZoom(this.zoom, this.fitFont)
    this.applyFont()
  }

  setTheme(theme: TerminalThemeColors): void {
    this.term.options.theme = theme
  }

  pinchStart(): void {
    this.pinchZoom = this.zoom
  }

  /** `scale`: the pinch's distance now ÷ at its start. */
  pinchMove(scale: number): void {
    this.zoom = clampZoom(this.pinchZoom * scale, this.fitFont)
    this.applyFont()
  }

  /** Double tap: readable size, or back to the fit. */
  toggleZoom(): void {
    this.zoom = this.zoom > 1 ? 1 : clampZoom(readableZoom(this.fitFont), this.fitFont)
    this.applyFont()
  }

  /**
   * A one-finger drag starts: true if the program takes it (the caller then keeps it
   * from xterm and feeds `touchScrollMove`), false if it scrolls xterm's scrollback.
   */
  touchScrollStart(): boolean {
    this.scroll.reset()
    return scrollGoesToProgram(this.scrollModes())
  }

  /** The finger moved `dy` px down, now at (`clientX`, `clientY`) in the viewport. */
  touchScrollMove(dy: number, clientX: number, clientY: number): void {
    const rect = this.host.screenRect()
    const { cols, rows } = this.term
    const lines = this.scroll.lines(dy, rect.height / rows)
    if (lines === 0) return
    const x = clientX - rect.left
    const y = clientY - rect.top
    const cell = (offset: number, size: number, count: number): number =>
      Math.min(count, Math.max(1, Math.floor(offset / size) + 1))
    const data = touchScrollBytes(lines, this.scrollModes(), {
      col: cell(x, rect.width / cols, cols),
      row: cell(y, rect.height / rows, rows),
      x: Math.max(0, Math.floor(x)),
      y: Math.max(0, Math.floor(y))
    })
    if (data) this.events.onInput?.(data)
  }

  dispose(): void {
    this.term.dispose()
  }

  private scrollModes(): ScrollModes {
    return {
      mouseTracking: this.term.modes.mouseTrackingMode,
      mouseEncoding: this.mouseEncoding,
      alternateScreen: this.term.buffer.active.type === 'alternate',
      applicationCursorKeys: this.term.modes.applicationCursorKeysMode
    }
  }

  /** xterm's own encoding switches (InputHandler setModePrivate/resetModePrivate, RIS). */
  private followMouseEncoding(): void {
    const modes = (params: CsiParams): number[] =>
      params.map((p) => (Array.isArray(p) ? p[0] : p)).filter((p) => p !== undefined)
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      for (const mode of modes(params)) {
        if (mode === 1006) this.mouseEncoding = 'sgr'
        else if (mode === 1016) this.mouseEncoding = 'sgr-pixels'
      }
      return false
    })
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (modes(params).some((m) => m === 1006 || m === 1016)) this.mouseEncoding = 'default'
      return false
    })
    this.term.parser.registerEscHandler({ final: 'c' }, () => {
      this.mouseEncoding = 'default'
      return false
    })
  }

  private applyFont(): void {
    const font = this.fitFont * this.zoom
    if (this.term.options.fontSize !== font) this.term.options.fontSize = font
  }

  private checkModes(): void {
    const now = this.term.modes.applicationCursorKeysMode
    if (now === this.applicationCursorKeys) return
    this.applicationCursorKeys = now
    this.events.onModes?.({ applicationCursorKeys: now })
  }
}
