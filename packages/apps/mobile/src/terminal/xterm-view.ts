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
 */
import {
  suppressDeviceStatusReplies,
  suppressXtVersionReply
} from '@slayzone/terminal/suppress-device-status'
import type { TerminalThemeColors } from '@slayzone/theme-tokens'
import type { Terminal as XTerm } from '@xterm/xterm'
import { clampZoom, fitFontSize, readableZoom } from './terminal-scale'

/** The xterm.js surface this view uses. */
export interface TerminalLike {
  cols: number
  rows: number
  options: { fontSize?: number; theme?: unknown }
  modes: { applicationCursorKeysMode: boolean }
  parser: Pick<XTerm['parser'], 'registerCsiHandler'>
  open(element: HTMLElement): void
  write(data: string, callback?: () => void): void
  reset(): void
  resize(cols: number, rows: number): void
  dispose(): void
}

/** Where the terminal is shown, and the two widths the fit needs. */
export interface XtermHost {
  element: HTMLElement
  /** The width available to the terminal (the web view's). */
  viewportWidth(): number
  /** The rendered width of the terminal's columns at the current font size. */
  screenWidth(): number
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
    this.term.open(host.element)
    this.refit()
  }

  write(data: string): void {
    this.term.write(data, () => this.checkModes())
  }

  reset(): void {
    this.term.reset()
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
    this.fitFont = fitFontSize(current, this.host.screenWidth(), this.host.viewportWidth())
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

  dispose(): void {
    this.term.dispose()
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
