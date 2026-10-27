import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { ITheme, Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import type { useTRPCClient } from '@slayzone/transport/client'
import { safeRandomUUID } from '@slayzone/ui'
import type { TerminalMode, TerminalState } from '@slayzone/terminal/shared'
import { createXterm } from './xterm-init'
import { loadWebglRenderer, correctAtlas, type DowngradeReason } from './webgl-loader'
import { monitorFrameTime, createScrambleProbe, type ScrambleProbe } from './scramble-detector'
import {
  captureDowngradeSnapshot,
  reportDowngradeSnapshot,
  reportRendererOk,
  shouldReportDowngrade
} from './scramble-telemetry'
import { diag } from './terminal-webgl-diag'
import { startMountTimeline } from './mount-timeline'
import { waitForDimensions } from './Terminal.utils'
import {
  isWebglDisabled,
  markWebglDisabled,
  downgradedSessions,
  rendererOkReportedSessions,
  fakeDowngradeRegistry
} from './terminal-webgl-sessions'
import {
  getTerminal,
  disposeTerminal,
  registerActiveAddon,
  registerActiveTerminal,
  getLiveTerminals
} from './terminal-cache'
import { suppressDeviceStatusReplies, suppressXtVersionReply } from './suppress-device-status'
import { isParked, parkBeforeOpen, parkRenderer, unparkToDom, wakeRenderer } from './renderer-park'
import { isLiveWebglAddon, scheduleWebglBudget, trackWebglAddon } from './webgl-budget'
import { acquireInitSlot } from './terminal-init-scheduler'
import { touchTerminalMru } from './terminal-mru'
import { isMainThreadSettled, overlapsLongTask } from './main-thread-jank'
import { attachPty } from './pty-attach'
import { createInputGate } from './input-gate'
import { takeEarlyInput } from './early-input'
import type { TerminalProps } from './Terminal.types'

// Reopen respawns the CLI with --resume; it re-streams the transcript over the
// next few seconds, during which the terminal would otherwise sit blank (the
// init overlay + 'starting' state both clear in a microtask). We hold a loading
// overlay until the first live output arrives, capped so a no-output resume
// can't hang it.
export const RESUME_OVERLAY_CAP_MS = 10_000

/** What a terminal session needs from its component at (re)init time. */
export interface TerminalInitOptions {
  fontSize: number
  fontFamily: string
  scrollback: number
  theme: ITheme
  variant: string
  supportsSessionId: boolean
}

/**
 * Everything `initTerminalSession` touches on the owning <Terminal>: its refs and
 * state setters (stable for the component's lifetime), the values its init is
 * keyed on, and refs to the latest props it reads without re-initializing.
 */
export interface TerminalInitContext {
  sessionId: string
  cwd: string
  mode: TerminalMode
  trpcClient: ReturnType<typeof useTRPCClient>
  resetTaskState: (sessionId: string) => void
  handleTerminalKeyEvent: (e: KeyboardEvent) => boolean
  clearBufferWithoutRestart: () => Promise<void>
  scheduleAtlasCorrection: (site?: string) => void
  /** Read once per init — later changes are applied by the component's own effects. */
  optionsRef: RefObject<TerminalInitOptions>
  containerRef: RefObject<HTMLDivElement | null>
  terminalRef: RefObject<XTerm | null>
  fitAddonRef: RefObject<FitAddon | null>
  serializeAddonRef: RefObject<SerializeAddon | null>
  searchAddonRef: RefObject<SearchAddon | null>
  webglAddonRef: RefObject<WebglAddon | null>
  webglRafIdRef: RefObject<number | null>
  frameTimeStopRef: RefObject<(() => void) | null>
  scrambleProbeRef: RefObject<ScrambleProbe | null>
  /**
   * Set by init: give this terminal its on-screen renderer (WebGL when allowed,
   * else xterm's DOM renderer). Called by the component when the terminal is
   * revealed — `sync` loads before the next paint so the reveal frame shows
   * content. Null until init has a terminal.
   */
  ensureRendererRef: RefObject<((opts: { sync: boolean }) => void) | null>
  initializedRef: RefObject<boolean>
  lastRenderedSeqRef: RefObject<number>
  resizeDebounceRef: RefObject<ReturnType<typeof setTimeout> | null>
  isResumingRef: RefObject<boolean>
  /** Is this terminal's tab on screen? Read at create: its agent then starts first. */
  isActiveRef: RefObject<boolean>
  resumeCapTimerRef: RefObject<ReturnType<typeof setTimeout> | null>
  hasCalledFirstInputRef: RefObject<boolean>
  lastActivityTimeRef: RefObject<number>
  forceCompatRef: RefObject<boolean>
  onAttachedRef: RefObject<TerminalProps['onAttached']>
  onReadyRef: RefObject<TerminalProps['onReady']>
  onFirstInputRef: RefObject<TerminalProps['onFirstInput']>
  onOpenUrlRef: RefObject<TerminalProps['onOpenUrl']>
  onOpenFileRef: RefObject<TerminalProps['onOpenFile']>
  conversationIdRef: RefObject<TerminalProps['conversationId']>
  existingConversationIdRef: RefObject<TerminalProps['existingConversationId']>
  providerFlagsRef: RefObject<TerminalProps['providerFlags']>
  executionContextRef: RefObject<TerminalProps['executionContext']>
  setIsInitializing: Dispatch<SetStateAction<boolean>>
  setInitError: Dispatch<SetStateAction<string | null>>
  setPtyState: Dispatch<SetStateAction<TerminalState>>
  setIsResuming: Dispatch<SetStateAction<boolean>>
  /** Mirrors `searchAddonRef` into state so the search bar renders from it. */
  setSearchAddon: Dispatch<SetStateAction<SearchAddon | null>>
}

/**
 * Attach a terminal session to its container: re-adopt the cached xterm for this
 * session, or build a fresh one and create/restore its PTY. Imperative xterm + IPC
 * work, kept out of the component so React (and its compiler) only see the wiring.
 */
export async function initTerminalSession(
  ctx: TerminalInitContext,
  signal: AbortSignal
): Promise<void> {
  const {
    sessionId,
    cwd,
    mode,
    trpcClient,
    resetTaskState,
    handleTerminalKeyEvent,
    clearBufferWithoutRestart,
    scheduleAtlasCorrection,
    containerRef,
    terminalRef,
    fitAddonRef,
    serializeAddonRef,
    searchAddonRef,
    webglAddonRef,
    webglRafIdRef,
    frameTimeStopRef,
    scrambleProbeRef,
    ensureRendererRef,
    initializedRef,
    lastRenderedSeqRef,
    resizeDebounceRef,
    isResumingRef,
    isActiveRef,
    resumeCapTimerRef,
    hasCalledFirstInputRef,
    lastActivityTimeRef,
    forceCompatRef,
    onAttachedRef,
    onReadyRef,
    onFirstInputRef,
    onOpenUrlRef,
    onOpenFileRef,
    conversationIdRef,
    existingConversationIdRef,
    providerFlagsRef,
    executionContextRef,
    setIsInitializing,
    setInitError,
    setPtyState,
    setIsResuming,
    setSearchAddon
  } = ctx
  const {
    fontSize: terminalFontSize,
    fontFamily: terminalFontFamily,
    scrollback: terminalScrollback,
    theme: resolvedTerminalTheme,
    variant: resolvedTerminalVariant,
    supportsSessionId
  } = ctx.optionsRef.current
  if (!containerRef.current || initializedRef.current) return
  setIsInitializing(true)
  setInitError(null)
  let didInit = false
  // Releases this init's turn in the hidden-terminal queue (idempotent).
  let releaseSlot: () => void = () => {}
  const timeline = startMountTimeline(sessionId, mode)

  try {
    // Wait for container to have dimensions BEFORE initializing terminal
    try {
      await waitForDimensions(containerRef.current, signal)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      throw e
    }
    timeline.mark('dims_ready')

    const rect = containerRef.current.getBoundingClientRect()

    // Re-check after await (component state might have changed)
    if (!containerRef.current || initializedRef.current || signal.aborted) return

    // Don't initialize if container still has 0 dimensions (not visible).
    // Keep isInitializing=true so spinner stays visible. The ResizeObserver
    // in the resize effect (below, ~line 733) retries initTerminal when the
    // container becomes visible and gets non-zero dimensions.
    if (rect.width === 0 || rect.height === 0) {
      return
    }

    didInit = true
    initializedRef.current = true

    // Renderer-health helpers — shared by both the cached-reattach path and
    // the fresh-allocation path. Defined here so the forceCompat toggle and
    // cache-reattach (which fire long after init returned) keep a live
    // closure on the current session's refs.

    const handleDowngrade = (reason: DowngradeReason): void => {
      // Snapshot first — addon + WebGL canvas must still be live so the
      // GPU info + canvas screenshot capture works (downgradeToDom now
      // fires onDowngrade BEFORE dispose for exactly this reason).
      const liveAddon = webglAddonRef.current
      const liveTerm = terminalRef.current
      if (liveAddon && liveTerm && shouldReportDowngrade(sessionId, reason)) {
        try {
          const snapshot = captureDowngradeSnapshot(liveAddon, liveTerm, reason, sessionId, mode)
          reportDowngradeSnapshot(snapshot)
        } catch {
          // Snapshot capture must never block the downgrade itself.
        }
      }

      // Stop probing against the addon we're about to dispose.
      frameTimeStopRef.current?.()
      frameTimeStopRef.current = null
      scrambleProbeRef.current?.dispose()
      scrambleProbeRef.current = null

      // Test-fake path reaches handleDowngrade directly; production path
      // is downgradeToDom → onDowngrade → here, with downgradeToDom about
      // to dispose right after we return. Disposing here is safe in both
      // paths (idempotent) and ensures the test path also tears down the
      // live addon.
      if (liveAddon && liveTerm) {
        try {
          liveAddon.dispose()
        } catch {
          /* already disposed */
        }
        webglAddonRef.current = null
        try {
          liveTerm.refresh(0, liveTerm.rows - 1)
        } catch {
          /* terminal disposed */
        }
      }

      downgradedSessions.add(sessionId)
    }

    // Make this session's handleDowngrade reachable from the e2e suite.
    // Overwrites any closure from a previous init for the same sessionId.
    fakeDowngradeRegistry.set(sessionId, handleDowngrade)

    const installRendererMonitors = (addon: WebglAddon, terminalInst: XTerm): void => {
      // Tear down any previous monitors before installing fresh — covers
      // the forceCompat re-enable path and cache-reattach where an
      // addon-instance is re-adopted from a now-defunct previous component.
      frameTimeStopRef.current?.()
      scrambleProbeRef.current?.dispose()

      const shared = {
        addon,
        terminal: terminalInst,
        getActiveAddon: () => webglAddonRef.current,
        setActiveAddon: (a: WebglAddon | null) => {
          webglAddonRef.current = a
        },
        isAborted: () => signal.aborted,
        isCurrent: () => webglAddonRef.current === addon,
        onDowngrade: handleDowngrade,
        sessionId
      }
      frameTimeStopRef.current = monitorFrameTime({
        ...shared,
        // The heartbeat measures rAF cadence, which is the WHOLE main thread's:
        // only sample while this terminal is on screen in a visible document
        // after boot has settled, and drop frames a long task overlapped — else
        // a busy boot reads as a slow GPU and latches the session to DOM.
        canSample: () =>
          isActiveRef.current &&
          terminalRef.current === terminalInst &&
          document.visibilityState === 'visible' &&
          isMainThreadSettled(),
        isJanky: overlapsLongTask,
        verdictDelayMs: 250
      })
      scrambleProbeRef.current = createScrambleProbe(shared)
    }

    // A WebGL renderer is used only while worth it: never for a terminal that
    // has not been on screen, and only the most recently used few stay live
    // (webgl-budget.ts). Otherwise a terminal is parked (renderer-park.ts) or,
    // when WebGL is off for it, on xterm's DOM renderer.
    const webglEligible = (): boolean =>
      !forceCompatRef.current && !downgradedSessions.has(sessionId) && !isWebglDisabled()

    // Budget eviction of an off-screen renderer: dispose it and park the
    // terminal; its next reveal loads WebGL again (ensureRenderer).
    const evictWebgl = (addon: WebglAddon, terminalInst: XTerm): void => {
      if (webglAddonRef.current === addon) {
        frameTimeStopRef.current?.()
        frameTimeStopRef.current = null
        scrambleProbeRef.current?.dispose()
        scrambleProbeRef.current = null
        webglAddonRef.current = null
      }
      try {
        addon.dispose()
      } catch {
        /* already disposed */
      }
      parkRenderer(terminalInst)
    }

    const trackAddon = (addon: WebglAddon, terminalInst: XTerm): void => {
      trackWebglAddon({
        sessionId,
        addon,
        // Refs of THIS component: once it unmounts (terminal cached) or a newer
        // component re-adopts the addon (re-tracked there), this reads false.
        isOnScreen: () => isActiveRef.current && terminalRef.current === terminalInst,
        evict: () => evictWebgl(addon, terminalInst)
      })
      scheduleWebglBudget()
    }

    // Load the WebGL renderer now (sync) — then install monitors, or hand a
    // parked terminal back to the DOM renderer when WebGL did not come up.
    const loadWebglNow = (terminalInst: XTerm): void => {
      loadWebglRenderer({
        terminal: terminalInst,
        // `preserveDrawingBuffer: true` keeps the WebGL back buffer
        // valid for readback between rAFs. Required by the Signal C
        // scramble probe in scramble-detector.ts — without it,
        // `gl.readPixels` outside the draw frame returns zeros. Costs
        // a small amount of GPU memory + disables a compositor fast
        // path; trade is necessary because the CPU-side atlas canvas
        // is not where scramble manifests.
        createAddon: () => new WebglAddon({ preserveDrawingBuffer: true }),
        isAborted: () => signal.aborted,
        isCurrentTerminal: () => terminalRef.current === terminalInst,
        isWebglDisabled,
        onWebglDisabled: markWebglDisabled,
        getActiveAddon: () => webglAddonRef.current,
        setActiveAddon: (a) => {
          webglAddonRef.current = a
        },
        requestFrame: (cb) => requestAnimationFrame(cb),
        requestTimeout: (cb, ms) => window.setTimeout(cb, ms),
        onDowngrade: handleDowngrade,
        sessionId,
        // The startup-window corrections repack the SHARED atlas, so a
        // terminal coming up scrambles panes that are already running
        // unless they also get a frame. See correctAtlas.
        getLiveTerminals
      })
      const addon = webglAddonRef.current
      if (addon && terminalRef.current === terminalInst) {
        if (!isLiveWebglAddon(addon)) trackAddon(addon, terminalInst)
        installRendererMonitors(addon, terminalInst)
        // Emit the downgrade-rate denominator once per session: WebGL
        // came up clean. Skipped if this session already downgraded.
        if (!rendererOkReportedSessions.has(sessionId) && !downgradedSessions.has(sessionId)) {
          rendererOkReportedSessions.add(sessionId)
          reportRendererOk(terminalInst, sessionId, mode, addon)
        }
      } else if (isParked(terminalInst)) {
        // WebGL unavailable after all (construction failed / disabled since
        // parking): a parked terminal draws nothing, so give it the DOM renderer.
        unparkToDom(terminalInst)
      }
    }

    // Deferred to the next animation frame so layout (post open()+fit()) has
    // committed before the addon rasterizes its glyph atlas.
    const triggerWebglLoad = (): void => {
      const terminalInst = terminalRef.current
      if (!terminalInst) return
      if (!webglEligible()) {
        if (isParked(terminalInst)) unparkToDom(terminalInst)
        return
      }
      if (webglRafIdRef.current !== null) {
        cancelAnimationFrame(webglRafIdRef.current)
      }
      webglRafIdRef.current = requestAnimationFrame(() => {
        webglRafIdRef.current = null
        loadWebglNow(terminalInst)
      })
    }

    // On-screen renderer for this terminal (see ensureRendererRef). No-op while
    // a live WebGL renderer is attached.
    const ensureRenderer = ({ sync }: { sync: boolean }): void => {
      const terminalInst = terminalRef.current
      if (!terminalInst || signal.aborted) return
      touchTerminalMru(sessionId)
      if (isLiveWebglAddon(webglAddonRef.current)) return
      if (!webglEligible()) {
        if (isParked(terminalInst)) {
          unparkToDom(terminalInst)
          if (sync) wakeRenderer(terminalInst)
        }
        return
      }
      if (!sync) {
        triggerWebglLoad()
        return
      }
      if (webglRafIdRef.current !== null) {
        cancelAnimationFrame(webglRafIdRef.current)
        webglRafIdRef.current = null
      }
      loadWebglNow(terminalInst)
      // The new renderer has drawn nothing yet and xterm still thinks the pane
      // is off screen (its IntersectionObserver reports after the next paint):
      // repaint in the coming frame instead, so the reveal never shows a blank.
      wakeRenderer(terminalInst)
    }

    // DOM-heavy section (open/fit/append, style injection) — take a turn if
    // this terminal is not on screen; see terminal-init-scheduler.ts.
    const slot = await acquireInitSlot(sessionId, {
      immediate: isActiveRef.current,
      signal
    })
    releaseSlot = slot.release
    if (signal.aborted) return

    // Check if we have a cached terminal for this task
    const cached = getTerminal(sessionId)
    if (cached) {
      // If mode changed, dispose cached terminal and kill old PTY to start fresh
      if (cached.mode !== mode) {
        // Reset state FIRST to ignore any in-flight data
        resetTaskState(sessionId)
        disposeTerminal(sessionId)
        // Kill old PTY (any data it sends will be ignored)
        await trpcClient.pty.kill.mutate({ sessionId })
      } else {
        // Reattach existing terminal (container already has dimensions)
        containerRef.current.appendChild(cached.element)
        onAttachedRef.current?.({ sessionId, focus: () => cached.terminal.focus() })
        cached.terminal.options.theme = resolvedTerminalTheme
        cached.terminal.options.minimumContrastRatio = resolvedTerminalVariant === 'light' ? 4.5 : 1
        terminalRef.current = cached.terminal
        fitAddonRef.current = cached.fitAddon
        serializeAddonRef.current = cached.serializeAddon
        searchAddonRef.current = cached.searchAddon
        setSearchAddon(cached.searchAddon)
        // A cached addon may have been evicted by the WebGL budget (or disposed
        // by a downgrade) while detached — only a live one is re-adopted.
        const cachedWebgl = isLiveWebglAddon(cached.webglAddon) ? (cached.webglAddon ?? null) : null
        webglAddonRef.current = cachedWebgl
        ensureRendererRef.current = ensureRenderer
        registerActiveAddon(sessionId, cached.serializeAddon)
        registerActiveTerminal(sessionId, cached.terminal)
        if (cached.lastRenderedSeq !== undefined) {
          lastRenderedSeqRef.current = cached.lastRenderedSeq
        }

        // Re-attach key handler (old closure captured stale setSearchOpen)
        cached.terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent)

        // Simple fit - container is guaranteed to have dimensions
        const prevCols = cached.terminal.cols
        const prevRows = cached.terminal.rows
        cached.fitAddon.fit()
        diag(sessionId, 'fit', { site: 'reattach', terminal: cached.terminal })
        // Only resize PTY if dimensions actually changed (avoids spurious SIGWINCH)
        if (cached.terminal.cols !== prevCols || cached.terminal.rows !== prevRows) {
          void trpcClient.pty.resize.mutate({
            sessionId,
            cols: cached.terminal.cols,
            rows: cached.terminal.rows
          })
        }
        cached.terminal.write('\x1b[0m') // Reset ANSI state on reattach

        // The WebGL atlas was built under the previous container geometry, and
        // possibly a different monitor DPR, while the terminal was detached —
        // rebuild it and repaint so glyphs don't render scrambled after reattach.
        if (cachedWebgl) {
          if (forceCompatRef.current) {
            // User flipped the force-compat setting while this terminal
            // was cached — dispose the cached WebGL addon so the DOM
            // renderer takes over on this reattach. No flicker window
            // because this runs before the first paint of the remounted
            // terminal.
            try {
              cachedWebgl.dispose()
            } catch {
              /* already disposed */
            }
            webglAddonRef.current = null
            try {
              cached.terminal.refresh(0, cached.terminal.rows - 1)
            } catch {
              /* terminal disposed */
            }
            downgradedSessions.add(sessionId)
          } else {
            // Routed through correctAtlas (not an inline clearTextureAtlas)
            // so every atlas mutation goes through one entry point — the
            // atlas is SHARED across terminals via the module-level
            // CharAtlasCache, so each mutation repacks it for every sharing
            // pane and must stay observable in one place.
            correctAtlas(cachedWebgl, cached.terminal, sessionId, 'reattach', getLiveTerminals)
            // Re-own the addon in the WebGL budget with THIS component's refs.
            trackAddon(cachedWebgl, cached.terminal)
            // Install scramble-detector against the re-adopted addon. The
            // previous component's monitors were disposed on unmount; without
            // re-installing here, Signals B+C would be silent for the rest
            // of this session.
            if (!downgradedSessions.has(sessionId)) {
              installRendererMonitors(cachedWebgl, cached.terminal)
            }
          }
        } else if (isActiveRef.current) {
          // On screen without a live renderer (evicted / parked while cached):
          // attach one, a frame from now like a fresh mount.
          ensureRenderer({ sync: false })
        }
        // DOM work done — let the next queued terminal go.
        releaseSlot()

        // Sync state from backend (fixes stuck loading spinner on reattach), and
        // replay any data that arrived while terminal was detached — one round
        // trip. During abort/reinit cycles, terminalRef is null so the subscribe
        // callback's write() is a no-op — this fills that gap.
        // Use lastRenderedSeqRef (tracks xterm writes) not getLastSeq
        // (tracks PtyContext receives — advances even when terminalRef is null).
        const attached = await attachPty(trpcClient, sessionId, lastRenderedSeqRef.current)
        if (signal.aborted) return // Don't setState if unmounted
        if (attached.state) setPtyState(attached.state)
        const missed = attached.buffer
        if (missed && missed.chunks.length > 0) {
          cached.terminal.write('\x1b[0m')
          for (const chunk of missed.chunks) {
            cached.terminal.write(chunk.data)
          }
          cached.terminal.write('\x1b[0m')
          lastRenderedSeqRef.current = missed.currentSeq
        }

        // Expose API for programmatic input and focus
        onReadyRef.current?.({
          sendInput: async (text) => {
            cached.terminal.input(text)
          },
          write: (data) => trpcClient.pty.write.mutate({ sessionId, data }),
          focus: () => cached.terminal.focus(),
          clearBuffer: clearBufferWithoutRestart
        })
        timeline.flush('reattach')
        return
      }
    }

    // Build the xterm instance + addons + link providers + tooltip. The
    // font preload + abort check live inside the factory (font must load
    // before xterm measures the cell). See xterm-init.ts.
    const created = await createXterm({
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      scrollback: terminalScrollback,
      theme: resolvedTerminalTheme,
      minimumContrastRatio: resolvedTerminalVariant === 'light' ? 4.5 : 1,
      cwd,
      sessionId,
      signal,
      getOnOpenUrl: () => onOpenUrlRef.current,
      getOnOpenFile: () => onOpenFileRef.current
    })
    if (!created) return
    timeline.mark('xterm_created')
    const { terminal, fitAddon, serializeAddon, searchAddon } = created

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    serializeAddonRef.current = serializeAddon
    searchAddonRef.current = searchAddon
    setSearchAddon(searchAddon)
    registerActiveAddon(sessionId, serializeAddon)
    registerActiveTerminal(sessionId, terminal)
    // Stop xterm answering cursor-position/status queries — the server is the
    // sole authority, and its replies are indistinguishable from modified-F3
    // keystrokes so they cannot be filtered downstream. Disposed with the
    // terminal.
    suppressDeviceStatusReplies(terminal)
    // Same reason, different owner: the server answers XTVERSION now, so any
    // `CSI > Ps q` xterm still sees came from a REPLAYED buffer and has no
    // asker left. Answering it injects an unsolicited DCS into the live
    // program's stdin, which wedges Claude Code's key handling.
    suppressXtVersionReply(terminal)

    // Open with the parked renderer whenever WebGL is going to be (or may later
    // be) this terminal's renderer: no DOM renderer — and no ~790-rule theme
    // stylesheet in the document — is ever built for it. On screen, WebGL
    // replaces it a frame from now; off screen, it stays parked until revealed.
    if (webglEligible()) parkBeforeOpen(terminal)
    terminal.open(containerRef.current)
    ensureRendererRef.current = ensureRenderer
    onAttachedRef.current?.({ sessionId, focus: () => terminal.focus() })
    terminal.clear() // Ensure terminal starts completely fresh
    // Simple fit - container is guaranteed to have dimensions from waitForDimensions
    fitAddon.fit()
    diag(sessionId, 'fit', { site: 'init', terminal })
    timeline.mark('xterm_opened')

    // Post-init FOUT catch-up. createXterm awaited document.fonts.load, but
    // that resolves once the face is *requested*, not fully rendered — the
    // measured cell can still shift as the webfont swaps in, leaving the
    // init fit's cols sized to the fallback cell and the screen wider/
    // narrower than the container until some later resize corrects it. For a
    // terminal that mounts active and never leaves, nothing else re-fits it.
    // Re-fit once fonts settle, but only if the geometry actually changed
    // (mismatch-gated, same contract as ensureFit) so it's a no-op in the
    // common case. Fire-and-forget; guarded on abort + still-current term.
    void document.fonts.ready.then(() => {
      if (signal.aborted || terminalRef.current !== terminal) return
      const proposed = fitAddon.proposeDimensions()
      if (!proposed || Number.isNaN(proposed.cols) || Number.isNaN(proposed.rows)) return
      if (proposed.cols === terminal.cols && proposed.rows === terminal.rows) return
      fitAddon.fit()
      diag(sessionId, 'fit', { site: 'init-fonts-ready', terminal })
      scheduleAtlasCorrection('fit:init-fonts-ready')
    })

    // WebGL renderer — 5-10x faster than the DOM renderer.
    // Safe because filterBufferData() strips SGR 4 (underline) codes server-side
    // before data reaches the renderer. CSS override kept as safety net.
    // Deferred to the next animation frame inside `triggerWebglLoad` (defined
    // above) so layout (post open()+fit()) has committed before the addon
    // rasterizes its glyph atlas. The forceCompat re-enable toggle re-enters
    // the same path. See webgl-loader.ts + scramble-detector.ts.
    // Only for a terminal on screen: a hidden one stays parked until revealed
    // (the component calls ensureRenderer then) — see webgl-budget.ts.
    if (isActiveRef.current) ensureRenderer({ sync: false })

    // Let Ctrl+Tab and Ctrl+Shift+Tab bubble up for tab switching
    // Intercept Cmd+F / Ctrl+F for terminal search
    terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent)
    // DOM work done — let the next queued terminal go.
    releaseSlot()

    // Input from here on: the xterm is focusable now, but a new session's PTY is a
    // round trip away. Keys typed meanwhile are held and delivered once it is up
    // (`inputGate.open()` below) instead of reaching no handler and being lost.
    //
    // OSC replies (\x1b]...\x07 or \x1b]...\x1b\\) are dropped here: they are
    // ANSWERS to color queries, never user input, and the server is the sole
    // authority for answering (synchronously, see `computeSyncQueryResponse`)
    // — a renderer-side answer is stale by construction and injects escape
    // bytes into the process's stdin. These broke interactive prompts (gh CLI).
    //
    // CSI device-status (CPR / DECXCPR / DSR) is NOT filtered here. It is
    // suppressed at the source instead, via `suppressDeviceStatusReplies` on
    // the parser, because filtering it after the fact is impossible: xterm
    // encodes modified F3 as `ESC[1;<mod>R`, byte-identical to a row-1 cursor
    // report, so a pattern that removes the reply also eats Shift/Ctrl/Alt+F3.
    // Stopping the reply from being generated leaves keystrokes untouched.
    const inputGate = createInputGate((data) => {
      void trpcClient.pty.write.mutate({ sessionId, data })
    })
    // An init abandoned mid-way (unmount) may leave this xterm cached and later
    // reattached: never leave it holding input.
    signal.addEventListener('abort', () => inputGate.open(), { once: true })
    // Keys typed after the user asked for this terminal but before its xterm
    // existed (early-input.ts). Taken here — synchronously with the focus above
    // and the input wiring below — so none is dropped or doubled.
    const early = takeEarlyInput(sessionId)
    if (early) inputGate.input(early)
    terminal.onData((data) => {
      // Mark user activity so the next batcher flush paints at 60fps
      // (echo round-trip has zero added latency from the throttle).
      lastActivityTimeRef.current = performance.now()
      if (!hasCalledFirstInputRef.current) {
        hasCalledFirstInputRef.current = true
        onFirstInputRef.current?.()
      }
      const filtered = data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      if (filtered) inputGate.input(filtered)
    })

    // Check if PTY already exists (e.g., from idle hibernation), and if so its
    // state + full ring buffer — one round trip (pty.attach).
    const attached = await attachPty(trpcClient, sessionId, -1)
    if (signal.aborted) return // Don't continue if unmounted
    timeline.mark('exists_checked')
    const exists = attached.exists
    let createCols = terminal.cols
    let createRows = terminal.rows
    if (exists) {
      // Sync state from main process (fixes stuck loading spinner)
      if (attached.state) setPtyState(attached.state)

      // Restore from backend ring buffer (single source of truth).
      // afterSeq -1 gets all chunks. `prelude` resets
      // SGR/charset/scroll-region state an evicted prefix left behind —
      // it is '' (a no-op write) unless this buffer has actually evicted,
      // so writing it unconditionally is always correct.
      const result = attached.buffer
      if (result) {
        if (result.prelude) terminal.write(result.prelude)
        for (const chunk of result.chunks) {
          terminal.write(chunk.data)
        }
        lastRenderedSeqRef.current = result.currentSeq
      }
      timeline.flush('restored')
    } else {
      // Generate conversation ID for AI modes whose initialCommand uses {id}.
      // Providers without {id} (e.g. codex, gemini) generate their own session
      // IDs internally — storing a client UUID would be bogus.
      //
      // The minted UUID is passed to the CLI as `--session-id {id}` ONLY. We do
      // NOT persist it here: an eager client-side commit (the old
      // onConversationCreated call) wrote the id to the task BEFORE Claude
      // confirmed it, so a session that died before its SessionStart hook left
      // a "phantom" id pointing at a transcript Claude never wrote → reopen
      // resumed nothing → false "session expired". The conversation id is now
      // persisted exclusively by Claude's real SessionStart hook
      // (rest-api/agent-hook.ts persistConversationId), so only confirmed ids
      // are ever stored. See plans/conv-id-robustness-v2.md.
      let newConversationId = conversationIdRef.current
      if (
        mode !== 'terminal' &&
        supportsSessionId &&
        !newConversationId &&
        !existingConversationIdRef.current
      ) {
        newConversationId = safeRandomUUID()
      }

      // Create PTY — plain terminal mode doesn't use conversation IDs
      const isAiMode = mode !== 'terminal'
      const effectiveConversationId = isAiMode ? newConversationId : undefined
      const effectiveExistingConversationId = isAiMode
        ? existingConversationIdRef.current
        : undefined
      // Capture dims before async gap so PTY starts at correct size
      createCols = terminal.cols
      createRows = terminal.rows
      timeline.mark('create_sent')
      const result = await trpcClient.pty.create.mutate({
        sessionId,
        cwd,
        conversationId: effectiveConversationId,
        existingConversationId: effectiveExistingConversationId,
        mode,
        providerFlags: providerFlagsRef.current,
        executionContext: executionContextRef.current,
        cols: createCols,
        rows: createRows,
        // Restoring a workspace starts many agents at once; the computer admits
        // them a few at a time, and the one the user is looking at goes first.
        foreground: isActiveRef.current
      })
      timeline.mark('create_done')
      timeline.flush(result.success ? 'created' : 'create_error')
      if (!result.success) {
        const message = result.error || 'Failed to create terminal process'
        terminal.writeln(`\x1b[31mError: ${message}\x1b[0m`)
        setInitError(message)
        setPtyState('error')
        inputGate.drop()
        return
      }

      // Reopen-after-hibernate: the CLI re-streams the transcript over the
      // next few seconds. Hold the loading overlay until the first live
      // output arrives (cleared in the data subscription) so the terminal
      // shows a spinner, not a blank screen. Cap as a no-output safety net.
      if (effectiveExistingConversationId) {
        isResumingRef.current = true
        setIsResuming(true)
        if (resumeCapTimerRef.current) clearTimeout(resumeCapTimerRef.current)
        resumeCapTimerRef.current = setTimeout(() => {
          isResumingRef.current = false
          setIsResuming(false)
        }, RESUME_OVERLAY_CAP_MS)
      }
    }

    // The session is up: deliver input typed while it was being created.
    inputGate.open()

    // Optimistically clear the 'running' dot when the user interrupts the
    // agent. Mirrors Superset's `useTerminalInterruptClear`: Ctrl+C / Esc
    // interrupt the foreground agent, but Claude Code fires no Stop hook on
    // user interrupt, so the backend (hook-driven, idleTimeoutMs=Infinity)
    // would otherwise stay stuck on 'running'. The backend flip is
    // authoritative; the next lifecycle hook re-asserts 'running' if work
    // actually continues. Use onKey (semantic key) not onData, so kitty /
    // CSI-u input encoding doesn't hide the Esc keypress.
    terminal.onKey(({ domEvent }) => {
      const isInterrupt = domEvent.key === 'Escape' || (domEvent.key === 'c' && domEvent.ctrlKey)
      if (isInterrupt) void trpcClient.pty.interrupt.mutate({ sessionId })
    })

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current)
      resizeDebounceRef.current = setTimeout(() => {
        resizeDebounceRef.current = null
        // Save viewport to scrollback before Codex clears on SIGWINCH,
        // but only if there's substantial content (not just the prompt).
        // Codex idle prompt = ~5 lines; chat history = many more.
        if (mode === 'codex') {
          const buf = terminal.buffer.active
          let nonEmpty = 0
          for (let i = 0; i < terminal.rows; i++) {
            const line = buf.getLine(buf.viewportY + i)
            if (line && line.translateToString(true).trim()) nonEmpty++
          }
          if (nonEmpty > 10) terminal.write('\x1b[2J')
        }
        void trpcClient.pty.resize.mutate({ sessionId, cols, rows })
      }, 150)
    })

    // Sync PTY dimensions. For new PTYs (created with correct dims above),
    // only resize if the container changed during the async gap. For existing
    // PTYs (hibernation resume), always sync since we don't know their state.
    const { cols, rows } = terminal
    if (!exists && cols === createCols && rows === createRows) {
      // PTY was just created with these exact dims — skip redundant SIGWINCH
    } else {
      void trpcClient.pty.resize.mutate({ sessionId, cols, rows })
    }

    // Inject text into terminal in a single write (avoids char-by-char IPC race)
    const injectText = async (text: string): Promise<void> => {
      terminal.input(text)
    }

    // Expose API for programmatic input and focus
    onReadyRef.current?.({
      sendInput: injectText,
      write: (data) => trpcClient.pty.write.mutate({ sessionId, data }),
      focus: () => terminal.focus(),
      clearBuffer: clearBufferWithoutRestart
    })
  } catch (error) {
    if (signal.aborted) return
    const message = error instanceof Error ? error.message : 'Failed to initialize terminal'
    setInitError(message)
    setPtyState('error')
  } finally {
    releaseSlot()
    if (didInit) {
      setIsInitializing(false)
    }
  }
}
