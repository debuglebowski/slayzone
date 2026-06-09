import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { SearchAddon } from '@xterm/addon-search'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { getTrpcClient } from '@slayzone/transport/client'
import { WebLinkProvider, FileLinkProvider } from './web-link-provider'

// Override xterm underline styles - Claude Code outputs these and they persist incorrectly
// This is a definitive fix that works regardless of ANSI code filtering
const underlineOverride = document.createElement('style')
underlineOverride.textContent = `
  .xterm-underline-1, .xterm-underline-2, .xterm-underline-3,
  .xterm-underline-4, .xterm-underline-5 {
    text-decoration: none !important;
  }
`
document.head.appendChild(underlineOverride)

export interface CreateXtermOptions {
  fontSize: number
  fontFamily: string
  scrollback: number
  theme: ITheme
  /** Precomputed: `variant === 'light' ? 4.5 : 1`. */
  minimumContrastRatio: number
  cwd: string
  sessionId: string
  signal: AbortSignal
  /** Read at click time, never snapshotted — keeps the no-staleness contract. */
  getOnOpenUrl: () => ((url: string) => void) | undefined
  getOnOpenFile: () => (
    (filePath: string, options?: { position?: { line: number; col?: number } }) => void
  ) | undefined
}

export interface CreatedXterm {
  terminal: XTerm
  fitAddon: FitAddon
  serializeAddon: SerializeAddon
  searchAddon: SearchAddon
  linkProvider: WebLinkProvider
}

// Build the xterm instance + addons + link providers + hover tooltip. Pure
// construction: no ref wiring, no open()/fit(), no PTY. The caller owns those.
// Returns null if the abort signal fired during the font preload.
export async function createXterm(opts: CreateXtermOptions): Promise<CreatedXterm | null> {
  const {
    fontSize,
    fontFamily,
    scrollback,
    theme,
    minimumContrastRatio,
    cwd,
    sessionId,
    signal,
    getOnOpenUrl,
    getOnOpenFile
  } = opts

  // Link tooltip — shown on hover for all link types (URLs, files, OSC 8).
  // Uses xterm-hover class so mouse events don't fall through to other links.
  // Positioned at initial hover point (doesn't follow cursor).
  let tooltipEl: HTMLDivElement | null = null
  const getTooltip = () => {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div')
      tooltipEl.className = 'xterm-hover'
      tooltipEl.style.cssText =
        'display:none;position:fixed;z-index:50;padding:2px 6px;border-radius:3px;font-size:11px;line-height:1.3;max-width:600px;white-space:normal;word-break:break-all;pointer-events:none;opacity:0.85;background:#1e1e1e;color:#aaa;border:1px solid #333'
    }
    return tooltipEl
  }
  let tooltipShown = false
  const showTooltip = (event: MouseEvent, text: string, hint: string) => {
    if (tooltipShown) return // Don't reposition on subsequent mousemove events
    tooltipShown = true
    const el = getTooltip()
    if (!el.parentNode && terminal.element) {
      terminal.element.appendChild(el)
    }
    el.textContent = `${text}  ${hint}`
    el.style.display = 'block'
    el.style.left = `${event.clientX}px`
    el.style.top = `${event.clientY - el.offsetHeight - 2}px`
  }
  const hideTooltip = () => {
    tooltipShown = false
    if (tooltipEl) tooltipEl.style.display = 'none'
  }

  const urlHint = '— ⌘+Click open · ⌘⇧+Click external'
  const fileHint = '— ⌘+Click open'

  // xterm measures the character cell from whatever font is loaded when
  // open() runs. If the terminal webfont has not loaded yet (cold start)
  // it measures a fallback face and bakes in the wrong cell size — the
  // WebGL glyph atlas then renders scrambled, and only a panel resize
  // (which forces xterm to re-measure) corrects it. `document.fonts.ready`
  // is not sufficient: it resolves early when the font has not been
  // requested. Explicitly request the face and wait for it, bounded so a
  // missing/slow font cannot block terminal creation.
  await Promise.race([
    document.fonts.load(`${fontSize}px ${fontFamily}`).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ])
  if (signal.aborted) return null

  // Create new terminal
  const terminal = new XTerm({
    allowProposedApi: true,
    macOptionIsMeta: true,
    cursorBlink: false,
    fontSize,
    fontFamily,
    scrollback,
    scrollOnEraseInDisplay: true,
    theme,
    minimumContrastRatio,
    // OSC 8 hyperlinks — explicit links from CLI tools (gh, cargo, ls --hyperlink).
    // Same Cmd+Click routing as WebLinkProvider. Without this, xterm shows
    // a confirm() dialog + window.open().
    linkHandler: {
      activate: (event: MouseEvent, uri: string) => {
        const onOpenUrl = getOnOpenUrl()
        if (event.metaKey && event.shiftKey) {
          void getTrpcClient().app.shell.openExternal.mutate({ url: uri })
        } else if (event.metaKey && onOpenUrl) {
          onOpenUrl(uri)
        } else if (event.metaKey) {
          void getTrpcClient().app.shell.openExternal.mutate({ url: uri })
        }
      },
      hover: (e: MouseEvent, text: string) => showTooltip(e, text, urlHint),
      leave: () => hideTooltip()
    }
  })

  const fitAddon = new FitAddon()
  const serializeAddon = new SerializeAddon()
  const searchAddon = new SearchAddon()

  terminal.loadAddon(fitAddon)
  terminal.loadAddon(serializeAddon)
  terminal.loadAddon(searchAddon)

  // xterm defaults to Unicode v6 widths — modern glyphs in TUIs (Claude Code
  // box-draw, emoji, combining marks) desync cursor → overlapping redraws.
  terminal.loadAddon(new UnicodeGraphemesAddon())
  terminal.unicode.activeVersion = '15-graphemes'

  // Clickable URLs — pointer cursor on hover, no underline decoration.
  // Underline disabled to avoid persistent-underline bugs with WebGL LinkRenderLayer.
  // Cmd+Click → browser panel, Cmd+Shift+Click → external browser
  const linkProvider = new WebLinkProvider(
    terminal,
    (event, uri) => {
      const onOpenUrl = getOnOpenUrl()
      if (event.metaKey && event.shiftKey) {
        void getTrpcClient().app.shell.openExternal.mutate({ url: uri })
      } else if (event.metaKey && onOpenUrl) {
        onOpenUrl(uri)
      } else if (event.metaKey) {
        void getTrpcClient().app.shell.openExternal.mutate({ url: uri })
      }
    },
    (e, text) => showTooltip(e, text, urlHint),
    hideTooltip
  )
  terminal.registerLinkProvider(linkProvider)

  // Clickable file paths — Cmd+Click → editor (in-project) or Finder (external).
  // Shift+Click is consumed by xterm for text selection, so no Shift variant.
  terminal.registerLinkProvider(
    new FileLinkProvider(
      terminal,
      (event, filePath, line, col) => {
        if (!event.metaKey) return
        // Resolve relative paths against terminal cwd
        const resolved = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
        const isInProject = resolved.startsWith(cwd + '/') || resolved === cwd
        const onOpenFile = getOnOpenFile()
        if (!isInProject) {
          void getTrpcClient().worktrees.revealInFinder.mutate({ path: resolved })
        } else if (onOpenFile) {
          // Pass relative path to editor panel
          const relative = resolved.startsWith(cwd + '/')
            ? resolved.slice(cwd.length + 1)
            : filePath
          // Terminal file links use 1-based col; normalize to 0-based
          onOpenFile(
            relative,
            line != null
              ? { position: { line, col: col != null ? col - 1 : undefined } }
              : undefined
          )
        } else {
          void getTrpcClient().worktrees.revealInFinder.mutate({ path: resolved })
        }
      },
      (e, text) => showTooltip(e, text, fileHint),
      hideTooltip
    )
  )

  // Test helper — allows e2e tests to trigger link activation without mouse coordinates
  const w = window as unknown as Record<string, unknown>
  w.__slayzone_terminalLinks = {
    ...(w.__slayzone_terminalLinks as object),
    [sessionId]: linkProvider
  }

  return { terminal, fitAddon, serializeAddon, searchAddon, linkProvider }
}
