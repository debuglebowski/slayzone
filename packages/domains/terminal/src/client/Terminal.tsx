// IMPORTANT: Import via `./LazyTerminal` from consumer code, not this file
// directly. This module pulls in xterm + addons + xterm.css (~440KB minified)
// which the LazyTerminal wrapper splits into its own chunk via React.lazy.
// Direct imports from `./Terminal` will land xterm back in the main renderer
// bundle and undo the boot-time split. The package's "./client/Terminal"
// export exists only for the lazy wrapper itself.
import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import {
  electronBootstrap,
  useTRPC,
  useTRPCClient,
  useSubscription
} from '@slayzone/transport/client'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { matchesShortcut, useShortcutStore, PulseGrid } from '@slayzone/ui'
import { SerializeAddon } from '@xterm/addon-serialize'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { createXterm } from './xterm-init'
import { loadWebglRenderer, correctAtlas, type DowngradeReason } from './webgl-loader'
import { monitorFrameTime, createScrambleProbe, type ScrambleProbe } from './scramble-detector'
import { decideThrottle, DEFAULT_THROTTLE_OPTIONS } from './paint-throttle'
import {
  captureDowngradeSnapshot,
  reportDowngradeSnapshot,
  reportRendererOk
} from './scramble-telemetry'
import { diag } from './terminal-webgl-diag'
import { startMountTimeline } from './mount-timeline'
import { trimSelectionTrailingSpaces, waitForDimensions } from './Terminal.utils'
import {
  ensureFocusDiagnostics,
  captureBlurSync,
  settleBlurContext,
  classifyFocusLoss,
  describeEl,
  getFocusTrail,
  getLastInput,
  noteTerminalOutput
} from './focus-loss-diag'
import { TerminalDeadOverlay } from './TerminalDeadOverlay'
import '@xterm/xterm/css/xterm.css'

import {
  isWebglDisabled,
  markWebglDisabled,
  downgradedSessions,
  rendererOkReportedSessions,
  fakeDowngradeRegistry
} from './terminal-webgl-sessions'
import {
  getTerminal,
  setTerminal,
  disposeTerminal,
  updateAllThemes,
  registerActiveAddon,
  unregisterActiveAddon
} from './terminal-cache'
import { usePty } from './PtyContext'
import { useSessionState } from './useTerminalStateStore'
import { useTheme, useAppearance } from '@slayzone/settings/client'
import { getThemeTerminalColors } from '@slayzone/ui'
import { TerminalSearchBar } from './TerminalSearchBar'
import type { TerminalState } from '@slayzone/terminal/shared'
import type { TerminalProps, TerminalHandle } from './Terminal.types'
import { stripUnderlineCodes, KITTY_SHIFT_ENTER, DETECTION_ENGINES } from '@slayzone/terminal/shared'
import { track } from '@slayzone/telemetry/client'

export type { TerminalProps, TerminalHandle } from './Terminal.types'

// Reopen respawns the CLI with --resume; it re-streams the transcript over the
// next few seconds, during which the terminal would otherwise sit blank (the
// init overlay + 'starting' state both clear in a microtask). We hold a loading
// overlay until the first live output arrives, capped so a no-output resume
// can't hang it.
const RESUME_OVERLAY_CAP_MS = 10_000

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  {
    sessionId,
    cwd,
    mode = 'claude-code',
    conversationId,
    existingConversationId,
    supportsSessionId = true,
    initialPrompt,
    providerFlags,
    executionContext,
    isActive = true,
    paused = false,
    onAttached,
    onStartFresh,
    onReady,
    onFirstInput,
    onRetry,
    onOpenUrl,
    onOpenFile
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)

  const fitAddonRef = useRef<FitAddon | null>(null)
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  const webglRafIdRef = useRef<number | null>(null)
  const atlasCorrectionRafRef = useRef<number | null>(null)
  // Signal B (frame-time heartbeat) cleanup handle.
  const frameTimeStopRef = useRef<(() => void) | null>(null)
  // Signal C (WebGL canvas scramble probe) handle.
  const scrambleProbeRef = useRef<ScrambleProbe | null>(null)
  const clearedSeqRef = useRef<number | null>(null)
  const initializedRef = useRef(false)
  const lastRenderedSeqRef = useRef<number>(-1)
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useRef(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchFocusToken, setSearchFocusToken] = useState(0)
  const [isInitializing, setIsInitializing] = useState(true)
  const [isReplaying, setIsReplaying] = useState(false)
  // True from a hibernated-session reopen until the resumed CLI's first live
  // output arrives (or the cap fires). Keeps the loading overlay up instead of
  // flashing a blank terminal during the resume boot gap.
  const [isResuming, setIsResuming] = useState(false)
  const isResumingRef = useRef(false)
  const resumeCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (resumeCapTimerRef.current) clearTimeout(resumeCapTimerRef.current)
    }
  }, [])
  const [initError, setInitError] = useState<string | null>(null)
  const [deadExitCode, setDeadExitCode] = useState<number | null>(null)
  const [deadCrashOutput, setDeadCrashOutput] = useState<string | null>(null)
  // Structured error code from the CLI at exit (e.g. SESSION_NOT_FOUND), carried
  // on `pty:exit`. Drives the error-specific dead overlay (see issue #90).
  const [deadReason, setDeadReason] = useState<string | null>(null)
  const [doctorResults, setDoctorResults] = useState<
    import('@slayzone/terminal/shared').ValidationResult[] | null
  >(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  // Refs for callbacks to prevent initTerminal dependency churn. A callback that
  // updates task state in the parent recreates callback refs, which would
  // abort+restart initTerminal mid-initialization — causing a data loss window
  // where PTY output is silently dropped. Reading through refs breaks that cycle.
  const onStartFreshRef = useRef(onStartFresh)
  onStartFreshRef.current = onStartFresh
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const onAttachedRef = useRef(onAttached)
  onAttachedRef.current = onAttached
  const onFirstInputRef = useRef(onFirstInput)
  onFirstInputRef.current = onFirstInput
  const onOpenUrlRef = useRef(onOpenUrl)
  onOpenUrlRef.current = onOpenUrl
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile
  const hasCalledFirstInputRef = useRef(false)

  // Adaptive paint cadence (see SLOW_DRIP_THRESHOLD_MS etc. at module top).
  // Bumped from both the keystroke `onData` handler and the PTY data
  // subscription so either user activity or fresh data drops the throttle.
  const lastActivityTimeRef = useRef<number>(performance.now())
  const floodScoreRef = useRef<number>(0)
  const skipCounterRef = useRef<number>(0)
  // Throttle for the idle-close "user engaged" report (pty:touch).
  const lastTouchSentRef = useRef<number>(0)
  // Populated by the batcher useEffect with a synchronous flush. The
  // reactivation effect calls this BEFORE the replay path's getBufferSince
  // so any throttled-but-pending chunks land in lastRenderedSeqRef first,
  // preventing replay from re-fetching them and double-writing.
  const forceFlushRef = useRef<(() => void) | null>(null)

  // Refs for creation-only props — these are only read during PTY creation (the
  // !exists branch), never during reattach. Using refs avoids recreating initTerminal
  // (and triggering a detach→reattach cycle + SIGWINCH) when the parent re-renders
  // with new object references (e.g. executionContext from JSON.parse on every loadData).
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const existingConversationIdRef = useRef(existingConversationId)
  existingConversationIdRef.current = existingConversationId
  const initialPromptRef = useRef(initialPrompt)
  initialPromptRef.current = initialPrompt
  const providerFlagsRef = useRef(providerFlags)
  providerFlagsRef.current = providerFlags
  const executionContextRef = useRef(executionContext)
  executionContextRef.current = executionContext

  const trpcClient = useTRPCClient()
  const trpc = useTRPC()
  const {
    subscribe,
    subscribeExit,
    getCrashOutput,
    resetTaskState,
    cleanupTask
  } = usePty()
  const { terminalThemeId, contentVariant } = useTheme()
  const {
    terminalFontSize,
    terminalFontFamily,
    terminalScrollback,
    terminalForceCompatibilityRenderer
  } = useAppearance()
  // Ref so the inline-defined `triggerWebglLoad` + cache-reattach path see
  // the current setting value without closure staleness.
  const forceCompatRef = useRef(terminalForceCompatibilityRenderer)
  forceCompatRef.current = terminalForceCompatibilityRenderer

  const resolvedTerminalTheme = getThemeTerminalColors(terminalThemeId, contentVariant)
  const resolvedTerminalVariant = contentVariant

  // Re-rasterize the WebGL atlas after a post-startup `fit()`. A fit changes the
  // char-cell geometry; webgl-loader only corrects the atlas across the startup
  // window, so a resize / font change after that leaves the atlas built against
  // stale metrics and the screen scrambles. rAF-debounced so a resize drag (many
  // fits per second) coalesces to one correction on the settled frame. No-op when
  // the DOM renderer is active (no addon).
  const scheduleAtlasCorrection = useCallback((): void => {
    if (atlasCorrectionRafRef.current !== null) {
      cancelAnimationFrame(atlasCorrectionRafRef.current)
    }
    atlasCorrectionRafRef.current = requestAnimationFrame(() => {
      atlasCorrectionRafRef.current = null
      const addon = webglAddonRef.current
      const terminal = terminalRef.current
      if (addon && terminal) {
        correctAtlas(addon, terminal, sessionId)
        // The atlas was just intentionally re-rasterized — the scramble probe's
        // current baseline points at the *old* atlas pixels and would now flag
        // every cell as drift. Re-baseline so the probe tracks the new atlas.
        scrambleProbeRef.current?.rebaseline()
      }
    })
  }, [sessionId])

  // Idempotent fit: only calls fit() when the proposed geometry (measured from
  // the current container width + cell size) differs from what the terminal
  // currently renders. Safe to call at any time — a matching geometry is a
  // no-op, so it can back every fit trigger without spurious SIGWINCH/atlas
  // churn. Covers BOTH drift axes: a container-width change (the mount race)
  // and a cell-size change (webfont FOUT swapping the measured cell after the
  // init fit). Returns true when it actually re-fit.
  const ensureFit = useCallback((site: string): boolean => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return false
    const proposed = fitAddon.proposeDimensions()
    if (!proposed || Number.isNaN(proposed.cols) || Number.isNaN(proposed.rows)) return false
    if (proposed.cols === terminal.cols && proposed.rows === terminal.rows) return false
    fitAddon.fit()
    diag(sessionId, 'fit', { site, terminal })
    scheduleAtlasCorrection()
    return true
  }, [sessionId, scheduleAtlasCorrection])

  const wasActiveRef = useRef(isActive)

  // Reactive store value; local ptyState mirrors it but also carries transient
  // watchdog overrides ('dead'/'error') reasserted by the next store change.
  const storeState = useSessionState(sessionId)
  const [ptyState, setPtyState] = useState<TerminalState>(() => storeState)
  // Mirror for non-reactive reads (e.g. the focus-loss diagnostic below) so we
  // can include the current state without re-subscribing the listener effect.
  const ptyStateRef = useRef(ptyState)
  useEffect(() => {
    ptyStateRef.current = ptyState
  }, [ptyState])

  const clearBufferWithoutRestart = useCallback(async (): Promise<void> => {
    const result = await trpcClient.pty.clearBuffer.mutate({ sessionId })
    if (!result.success) return

    clearedSeqRef.current = result.clearedSeq
    terminalRef.current?.clear()
    terminalRef.current?.write('\x1b[0m')
  }, [sessionId, trpcClient])

  useImperativeHandle(ref, () => ({
    focus: () => terminalRef.current?.focus(),
    hasSelection: () => terminalRef.current?.hasSelection() ?? false,
    getSelection: () => trimSelectionTrailingSpaces(terminalRef.current?.getSelection() ?? ''),
    selectAll: () => terminalRef.current?.selectAll(),
    scrollToBottom: () => terminalRef.current?.scrollToBottom(),
    openSearch: () => {
      setSearchOpen(true)
      setSearchFocusToken((t) => t + 1)
    },
    clearBuffer: clearBufferWithoutRestart
  }))

  const handleTerminalKeyEvent = useCallback(
    (e: KeyboardEvent): boolean => {
      if (e.ctrlKey && e.key === 'Tab') return false
      // Shift+Enter in AI modes: send kitty protocol sequence so CLI apps
      // can insert a newline instead of submitting.
      if (mode === 'claude-code' && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (e.type === 'keydown') {
          void trpcClient.pty.write.mutate({ sessionId, data: KITTY_SHIFT_ENTER })
        }
        return false
      }
      if (e.type === 'keydown' && !useShortcutStore.getState().isRecording) {
        if (matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-search'))) {
          setSearchOpen(true)
          setSearchFocusToken((t) => t + 1)
          track('terminal_search_used')
          return false
        }
        if (matchesShortcut(e, useShortcutStore.getState().getKeys('terminal-clear'))) {
          void clearBufferWithoutRestart()
          return false
        }
      }
      // Ctrl+Shift+C/V handled via DOM keydown listener (useEffect below)
      // to work reliably regardless of xterm.js internal event handling.
      if (
        e.ctrlKey &&
        e.shiftKey &&
        (e.code === 'KeyC' || e.code === 'KeyV') &&
        e.type === 'keydown'
      ) {
        return false
      }
      // macOS: Option+Arrow word navigation.
      // xterm.js sends \x1b[1;3D (CSI modifier form) but macOS shells
      // bind \x1bb/\x1bf (Meta-b/f) for word nav. Match iTerm2 behavior.
      if (
        navigator.platform.startsWith('Mac') &&
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        e.type === 'keydown'
      ) {
        if (e.key === 'ArrowLeft') {
          void trpcClient.pty.write.mutate({ sessionId, data: '\x1bb' })
          return false
        }
        if (e.key === 'ArrowRight') {
          void trpcClient.pty.write.mutate({ sessionId, data: '\x1bf' })
          return false
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp' && e.type === 'keydown') {
        terminalRef.current?.scrollToTop()
        return false
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown' && e.type === 'keydown') {
        terminalRef.current?.scrollToBottom()
        return false
      }
      return true
    },
    [mode, sessionId, clearBufferWithoutRestart, trpcClient]
  )

  const initTerminal = useCallback(
    async (signal: AbortSignal) => {
      if (!containerRef.current || initializedRef.current) return
      setIsInitializing(true)
      setInitError(null)
      let didInit = false
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
          if (liveAddon && liveTerm) {
            try {
              const snapshot = captureDowngradeSnapshot(
                liveAddon,
                liveTerm,
                reason,
                sessionId,
                mode
              )
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
          frameTimeStopRef.current = monitorFrameTime(shared)
          scrambleProbeRef.current = createScrambleProbe(shared)
        }

        const triggerWebglLoad = (): void => {
          const terminalInst = terminalRef.current
          if (!terminalInst) return
          if (forceCompatRef.current) return
          if (downgradedSessions.has(sessionId)) return
          if (webglRafIdRef.current !== null) {
            cancelAnimationFrame(webglRafIdRef.current)
          }
          webglRafIdRef.current = requestAnimationFrame(() => {
            webglRafIdRef.current = null
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
              sessionId
            })
            const addon = webglAddonRef.current
            if (addon) {
              installRendererMonitors(addon, terminalInst)
              // Emit the downgrade-rate denominator once per session: WebGL
              // came up clean. Skipped if this session already downgraded.
              if (
                !rendererOkReportedSessions.has(sessionId) &&
                !downgradedSessions.has(sessionId)
              ) {
                rendererOkReportedSessions.add(sessionId)
                reportRendererOk(terminalInst, sessionId, mode)
              }
            }
          })
        }

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
            cached.terminal.options.minimumContrastRatio =
              resolvedTerminalVariant === 'light' ? 4.5 : 1
            terminalRef.current = cached.terminal
            fitAddonRef.current = cached.fitAddon
            serializeAddonRef.current = cached.serializeAddon
            searchAddonRef.current = cached.searchAddon
            webglAddonRef.current = cached.webglAddon ?? null
            registerActiveAddon(sessionId, cached.serializeAddon)
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
            if (cached.webglAddon) {
              if (forceCompatRef.current) {
                // User flipped the force-compat setting while this terminal
                // was cached — dispose the cached WebGL addon so the DOM
                // renderer takes over on this reattach. No flicker window
                // because this runs before the first paint of the remounted
                // terminal.
                try {
                  cached.webglAddon.dispose()
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
                try {
                  cached.webglAddon.clearTextureAtlas()
                  cached.terminal.refresh(0, cached.terminal.rows - 1)
                  diag(sessionId, 'atlas-correct', {
                    site: 'reattach',
                    terminal: cached.terminal
                  })
                } catch {
                  /* terminal disposed */
                }
                // Install scramble-detector against the re-adopted addon. The
                // previous component's monitors were disposed on unmount; without
                // re-installing here, Signals B+C would be silent for the rest
                // of this session.
                if (!downgradedSessions.has(sessionId)) {
                  installRendererMonitors(cached.webglAddon, cached.terminal)
                }
              }
            }

            // Sync state from backend (fixes stuck loading spinner on reattach)
            const actualState = await trpcClient.pty.getState.query({ sessionId })
            if (signal.aborted) return // Don't setState if unmounted
            if (actualState) setPtyState(actualState)

            // Replay any data that arrived while terminal was detached.
            // During abort/reinit cycles, terminalRef is null so the subscribe
            // callback's write() is a no-op — this fills that gap.
            // Use lastRenderedSeqRef (tracks xterm writes) not getLastSeq
            // (tracks PtyContext receives — advances even when terminalRef is null).
            const missed = await trpcClient.pty.getBufferSince.query({
              sessionId,
              afterSeq: lastRenderedSeqRef.current
            })
            if (signal.aborted) return
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
        registerActiveAddon(sessionId, serializeAddon)

        terminal.open(containerRef.current)
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
          scheduleAtlasCorrection()
        })

        // WebGL renderer — 5-10x faster than the DOM renderer.
        // Safe because filterBufferData() strips SGR 4 (underline) codes server-side
        // before data reaches the renderer. CSS override kept as safety net.
        // Deferred to the next animation frame inside `triggerWebglLoad` (defined
        // above) so layout (post open()+fit()) has committed before the addon
        // rasterizes its glyph atlas. The forceCompat re-enable toggle re-enters
        // the same path. See webgl-loader.ts + scramble-detector.ts.
        triggerWebglLoad()

        // Let Ctrl+Tab and Ctrl+Shift+Tab bubble up for tab switching
        // Intercept Cmd+F / Ctrl+F for terminal search
        terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent)

        // Check if PTY already exists (e.g., from idle hibernation)
        const exists = await trpcClient.pty.exists.query({ sessionId })
        if (signal.aborted) return // Don't continue if unmounted
        timeline.mark('exists_checked')
        let createCols = terminal.cols
        let createRows = terminal.rows
        if (exists) {
          // Sync state from main process (fixes stuck loading spinner)
          const actualState = await trpcClient.pty.getState.query({ sessionId })
          if (signal.aborted) return // Don't setState if unmounted
          if (actualState) setPtyState(actualState)

          // Restore from backend ring buffer (single source of truth).
          // Use getBufferSince with -1 to get all chunks.
          const result = await trpcClient.pty.getBufferSince.query({ sessionId, afterSeq: -1 })
          if (signal.aborted) return
          if (result) {
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
            newConversationId = crypto.randomUUID()
          }

          // Create PTY — plain terminal mode doesn't use conversation IDs
          // Note: Don't pass initialPrompt - we'll inject it after terminal is ready
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
            rows: createRows
          })
          timeline.mark('create_done')
          timeline.flush(result.success ? 'created' : 'create_error')
          if (!result.success) {
            const message = result.error || 'Failed to create terminal process'
            terminal.writeln(`\x1b[31mError: ${message}\x1b[0m`)
            setInitError(message)
            setPtyState('error')
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

        // Handle terminal input - pass through to PTY.
        // Filter out OSC sequences (\x1b]...\x07 or \x1b]...\x1b\\) that xterm.js
        // generates as responses to color queries. These would inject stale escape
        // bytes into the process stdin, breaking interactive prompts (e.g. gh CLI).
        // User keystrokes and paste data never contain OSC sequences.
        terminal.onData((data) => {
          // Mark user activity so the next batcher flush paints at 60fps
          // (echo round-trip has zero added latency from the throttle).
          lastActivityTimeRef.current = performance.now()
          if (!hasCalledFirstInputRef.current) {
            hasCalledFirstInputRef.current = true
            onFirstInputRef.current?.()
          }
          const filtered = data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
          if (filtered) void trpcClient.pty.write.mutate({ sessionId, data: filtered })
        })

        // Optimistically clear the 'running' dot when the user interrupts the
        // agent. Mirrors Superset's `useTerminalInterruptClear`: Ctrl+C / Esc
        // interrupt the foreground agent, but Claude Code fires no Stop hook on
        // user interrupt, so the backend (hook-driven, idleTimeoutMs=Infinity)
        // would otherwise stay stuck on 'running'. The backend flip is
        // authoritative; the next lifecycle hook re-asserts 'running' if work
        // actually continues. Use onKey (semantic key) not onData, so kitty /
        // CSI-u input encoding doesn't hide the Esc keypress.
        terminal.onKey(({ domEvent }) => {
          const isInterrupt =
            domEvent.key === 'Escape' || (domEvent.key === 'c' && domEvent.ctrlKey)
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
        // Inject initial prompt if provided (after a delay for terminal to be ready)
        if (initialPromptRef.current) {
          setTimeout(async () => {
            if (signal.aborted) return // Don't inject if unmounted
            try {
              // For plan mode, prefix with /plan
              const textToInject = initialPromptRef.current!
              await injectText(textToInject)
            } catch {
              // Terminal may have been disposed, ignore
            }
          }, 500)
        }
      } catch (error) {
        if (signal.aborted) return
        const message = error instanceof Error ? error.message : 'Failed to initialize terminal'
        setInitError(message)
        setPtyState('error')
      } finally {
        if (didInit) {
          setIsInitializing(false)
        }
      }
    },
    [
      sessionId,
      cwd,
      mode,
      resetTaskState,
      handleTerminalKeyEvent,
      clearBufferWithoutRestart,
      trpcClient,
      scheduleAtlasCorrection
    ]
  )

  // Initialize terminal
  useEffect(() => {
    const controller = new AbortController()
    initTerminal(controller.signal)

    return () => {
      controller.abort()
      if (resizeDebounceRef.current) {
        clearTimeout(resizeDebounceRef.current)
        resizeDebounceRef.current = null
      }
      // Cancel a pending WebGL load if the component unmounts before its rAF fires.
      if (webglRafIdRef.current !== null) {
        cancelAnimationFrame(webglRafIdRef.current)
        webglRafIdRef.current = null
      }
      // Cancel a pending post-fit atlas correction.
      if (atlasCorrectionRafRef.current !== null) {
        cancelAnimationFrame(atlasCorrectionRafRef.current)
        atlasCorrectionRafRef.current = null
      }
      // Dispose scramble-detector handles. The cached addon stays in the
      // module cache, but its monitors die with this component — the
      // re-mounting component re-installs them via `installRendererMonitors`.
      frameTimeStopRef.current?.()
      frameTimeStopRef.current = null
      scrambleProbeRef.current?.dispose()
      scrambleProbeRef.current = null
      fakeDowngradeRegistry.delete(sessionId)
      unregisterActiveAddon(sessionId)
      // Serialize state before caching
      let serializedState: string | undefined
      if (serializeAddonRef.current && terminalRef.current) {
        try {
          serializedState = serializeAddonRef.current.serialize()
        } catch {
          // Serialize failed, continue without it
        }
      }

      // Detach terminal from DOM and cache it (don't dispose)
      if (
        terminalRef.current &&
        fitAddonRef.current &&
        serializeAddonRef.current &&
        searchAddonRef.current
      ) {
        const element = terminalRef.current.element
        if (element && element.parentNode) {
          element.parentNode.removeChild(element)
          setTerminal(sessionId, {
            terminal: terminalRef.current,
            fitAddon: fitAddonRef.current,
            serializeAddon: serializeAddonRef.current,
            searchAddon: searchAddonRef.current,
            webglAddon: webglAddonRef.current ?? undefined,
            element,
            serializedState,
            mode,
            lastRenderedSeq: lastRenderedSeqRef.current
          })
        }
      }
      terminalRef.current = null
      fitAddonRef.current = null
      serializeAddonRef.current = null
      searchAddonRef.current = null
      webglAddonRef.current = null
      initializedRef.current = false

      // Clean up test helper reference
      const wClean = window as unknown as Record<string, Record<string, unknown> | undefined>
      if (wClean.__slayzone_terminalLinks) {
        delete wClean.__slayzone_terminalLinks[sessionId]
      }
    }
  }, [initTerminal, sessionId])

  // Subscribe to PTY events via context (survives view switches)
  // Batch writes with rAF to avoid per-chunk canvas repaints during fast output.
  // On slow-drip output the batcher additionally throttles to ~20fps — see the
  // adaptive cadence constants at the top of this module.
  useEffect(() => {
    let pendingChunks: string[] = []
    let pendingSeq = -1
    let rafId: number | null = null

    const flush = (): void => {
      rafId = null
      if (pendingChunks.length === 0) return
      if (!terminalRef.current) return

      // Second-pass underline strip — catches split sequences across chunks
      // (now joined) and any codes the server filter missed. Required for
      // the WebGL renderer which ignores CSS overrides.
      const joined = stripUnderlineCodes(pendingChunks.join(''))

      const decision = decideThrottle(
        performance.now(),
        joined.length,
        {
          lastActivityTime: lastActivityTimeRef.current,
          floodScore: floodScoreRef.current,
          skipCounter: skipCounterRef.current
        },
        DEFAULT_THROTTLE_OPTIONS
      )
      floodScoreRef.current = decision.nextFloodScore
      skipCounterRef.current = decision.nextSkipCounter
      if (decision.skip) {
        // Re-arm one rAF, do NOT write. Chunks stay queued; the next
        // (or eventually un-throttled) flush drains them in one write.
        rafId = requestAnimationFrame(flush)
        return
      }

      terminalRef.current.write(joined)
      noteTerminalOutput() // breadcrumb for the focus-loss output-correlation field
      lastRenderedSeqRef.current = pendingSeq
      pendingChunks = []
      pendingSeq = -1
    }

    // Synchronous flush for the reactivation effect — drains any throttled
    // chunks BEFORE the replay path calls getBufferSince(lastRenderedSeq),
    // otherwise replay re-fetches them and double-writes.
    forceFlushRef.current = (): void => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      skipCounterRef.current = 0
      lastActivityTimeRef.current = performance.now()
      flush()
    }

    const unsubData = subscribe(sessionId, (data, seq) => {
      const cutoff = clearedSeqRef.current
      if (cutoff !== null && seq <= cutoff) return
      // Skip chunks already covered by the initial archive snapshot replay.
      // Archive writes are sync-mirrored to disk before pty:data fires, so any
      // chunk with seq <= lastRenderedSeqRef is guaranteed to be in the tail
      // we just wrote — re-writing here would duplicate output.
      if (seq <= lastRenderedSeqRef.current) return
      if (!terminalRef.current) return
      // First live output of a resume → the boot gap is over; drop the overlay.
      if (isResumingRef.current) {
        isResumingRef.current = false
        if (resumeCapTimerRef.current) {
          clearTimeout(resumeCapTimerRef.current)
          resumeCapTimerRef.current = null
        }
        setIsResuming(false)
      }
      lastActivityTimeRef.current = performance.now()
      pendingChunks.push(data)
      pendingSeq = seq
      if (rafId === null) {
        rafId = requestAnimationFrame(flush)
      }
    })

    const unsubExit = subscribeExit(sessionId, (exitCode, reason) => {
      // Resume died before any output — stop the overlay so the dead overlay shows.
      if (isResumingRef.current) {
        isResumingRef.current = false
        if (resumeCapTimerRef.current) {
          clearTimeout(resumeCapTimerRef.current)
          resumeCapTimerRef.current = null
        }
        setIsResuming(false)
      }
      terminalRef.current?.writeln(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m`)
      // Capture crash output before cleanupTask deletes context state
      const raw = getCrashOutput(sessionId)
      // Clean up cached terminal and context state on exit
      disposeTerminal(sessionId)
      cleanupTask(sessionId)
      // Show dead overlay for AI modes. `reason` (e.g. SESSION_NOT_FOUND) drives
      // an error-specific message instead of the generic exit-code line.
      setDeadExitCode(exitCode)
      setDeadReason(reason ?? null)
      if (raw) setDeadCrashOutput(raw)
    })

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      // Drain through one final synchronous flush. Reset skip counter so the
      // shutdown flush is unconditional and any pending chunks land before
      // tear-down (matches the previous behavior — no chunks deferred past
      // unmount).
      skipCounterRef.current = 0
      lastActivityTimeRef.current = performance.now()
      flush()
      forceFlushRef.current = null
      unsubData()
      unsubExit()
    }
  }, [sessionId, subscribe, subscribeExit, getCrashOutput, cleanupTask])

  // Replay missed PTY data when task becomes active
  useEffect(() => {
    if (!isActive || !terminalRef.current) return
    // Drain any throttled-but-pending chunks synchronously so
    // lastRenderedSeqRef reflects the true rendered seq before getBufferSince
    // captures it — otherwise the in-queue chunks come back via the missed[]
    // array and get double-written.
    forceFlushRef.current?.()
    let cancelled = false
    const replay = async () => {
      try {
        const missed = await trpcClient.pty.getBufferSince.query({
          sessionId,
          afterSeq: lastRenderedSeqRef.current
        })
        if (cancelled || !missed || missed.chunks.length === 0) return
        // Only show overlay when there's actually data to write
        setIsReplaying(true)
        for (const chunk of missed.chunks) {
          const cutoff = clearedSeqRef.current
          if (cutoff !== null && chunk.seq <= cutoff) continue
          terminalRef.current?.write(chunk.data)
          lastRenderedSeqRef.current = chunk.seq
        }
        // Wait for xterm to finish processing all queued writes
        if (terminalRef.current) {
          await new Promise<void>((resolve) => terminalRef.current!.write('', resolve))
        }
      } finally {
        if (!cancelled) setIsReplaying(false)
      }
    }
    replay()
    return () => {
      cancelled = true
    }
  }, [isActive, sessionId, trpcClient])

  // Sync the loading-indicator state from the reactive store. Local overrides
  // (watchdog 'dead'/'error') are transient — the next store change reasserts,
  // same as the old subscribeState path. Don't regress a settled state back to
  // 'starting' on a late store seed.
  useEffect(() => {
    setPtyState((prev) => (storeState === 'starting' && prev !== 'starting' ? prev : storeState))
  }, [storeState])

  // Re-fit + re-rasterize on isActive false→true. A task switch is a CSS
  // visibility:hidden flip — no ResizeObserver fires on its own — so a panel
  // width change made while this tab was hidden (or a cell-metric change) can
  // leave stale cols/rows by the time the user returns. NOT gated on the WebGL
  // addon: DOM-renderer terminals (no addon) need the re-fit too, and
  // ensureFit's mismatch check makes it a no-op when nothing changed.
  // scheduleAtlasCorrection() inside ensureFit already no-ops without an addon.
  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      ensureFit('reactivate')
    }
    wasActiveRef.current = isActive
  }, [isActive, ensureFit])

  // Re-fit terminal when PTY dimensions need resync (e.g., after floating agent
  // reattach). Server fan-out is global; filter by sessionId. The follow-up
  // resize uses the tRPC mutation.
  useSubscription(
    trpc.pty.onResizeNeeded.subscriptionOptions(undefined, {
      onData: ({ sessionId: sid }) => {
        if (sid !== sessionId || !fitAddonRef.current || !terminalRef.current) return
        fitAddonRef.current.fit()
        diag(sessionId, 'fit', { site: 'resize-needed', terminal: terminalRef.current })
        scheduleAtlasCorrection()
        void trpcClient.pty.resize.mutate({
          sessionId,
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows
        })
      }
    })
  )

  // Safety net: prevent permanent 'starting' state after init completes.
  // If the backend dies or IPC events are lost, this watchdog transitions
  // to 'dead' so the user sees the retry overlay instead of infinite loading.
  useEffect(() => {
    if (isInitializing || initError || ptyState !== 'starting') return
    const timer = setTimeout(async () => {
      const exists = await trpcClient.pty.exists.query({ sessionId })
      const actual = await trpcClient.pty.getState.query({ sessionId })
      if (actual && actual !== 'starting' && actual !== 'dead') {
        setPtyState(actual)
        return
      }
      if (!exists || !actual || actual === 'starting') {
        console.warn(
          `[terminal] watchdog: ${sessionId} stuck in 'starting' for 20s, transitioning to dead`
        )
        setPtyState('dead')
        setDeadExitCode(-1)
      }
    }, 20_000)
    return () => clearTimeout(timer)
  }, [isInitializing, initError, ptyState, sessionId, trpcClient])

  // Sync terminal theme with app theme / terminal theme settings
  useEffect(() => {
    const contrastRatio = resolvedTerminalVariant === 'light' ? 4.5 : 1
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolvedTerminalTheme
      terminalRef.current.options.minimumContrastRatio = contrastRatio
    }
    updateAllThemes(resolvedTerminalTheme, contrastRatio)
    // Keep main process in sync so it can respond to OSC 10/11/12/4 color
    // queries synchronously (async renderer response arrives too late once
    // readline is active). ansi[0..15] mirrors xterm.js ITheme order so OSC 4
    // palette queries return what is actually rendered.
    const t = resolvedTerminalTheme
    const ansi = [
      t.black,
      t.red,
      t.green,
      t.yellow,
      t.blue,
      t.magenta,
      t.cyan,
      t.white,
      t.brightBlack,
      t.brightRed,
      t.brightGreen,
      t.brightYellow,
      t.brightBlue,
      t.brightMagenta,
      t.brightCyan,
      t.brightWhite
    ].filter((c): c is string => typeof c === 'string')
    void trpcClient.pty.setTheme.mutate({
      foreground: t.foreground ?? '#ffffff',
      background: t.background ?? '#000000',
      cursor: t.cursor ?? '#ffffff',
      ansi: ansi.length === 16 ? ansi : undefined
    })
  }, [terminalThemeId, contentVariant, trpcClient])

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      // Mid panel-resize: the terminal is covered by an opaque overlay and its
      // width churns every frame. Skip the fit now — a single fit runs when
      // `paused` clears (effect below). Keeps the terminal mounted (focus +
      // active group preserved) without per-frame reflow/atlas churn.
      if (pausedRef.current) return
      // Don't fit when container is hidden (0 dimensions from CSS display:none)
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0 || rect.height === 0) {
        return
      }

      // If terminal is missing and not currently initializing, reinit
      // DO NOT set initializedRef here - initTerminal manages its own flag
      // (setting it here caused initTerminal to return early at line 118)
      if (!terminalRef.current && !initializedRef.current) {
        const controller = new AbortController()
        initTerminal(controller.signal)
        return
      }

      ensureFit('resize-observer')
    }

    window.addEventListener('resize', handleResize)
    const observer = new ResizeObserver(handleResize)
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      observer.disconnect()
    }
  }, [initTerminal, ensureFit])

  // Panel resize just ended (`paused` true → false): the ResizeObserver fits
  // were skipped during the drag, so the container now has its final width but
  // stale cols/rows. Do one fit to catch up. xterm's `onResize` propagates the
  // new size to the PTY, so no manual pty.resize here. Initial mount (false) and
  // entering a resize (→ true) are no-ops.
  const wasPausedRef = useRef(paused)
  useEffect(() => {
    const justResumed = wasPausedRef.current && !paused
    wasPausedRef.current = paused
    if (!justResumed || !terminalRef.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    ensureFit('resize-end')
  }, [paused, ensureFit])

  // Update font size at runtime when setting changes.
  // Await the font at the NEW size before fitting — otherwise fit() measures
  // a fallback face's cell metrics, the WebGL atlas tiles freeze at those
  // dimensions, and FOUT swap-in produces smeared adjacent tiles. Bounded so
  // a slow/missing font cannot block the fit indefinitely. Mirrors the
  // cold-start await at the top of initTerminal.
  useEffect(() => {
    const t = terminalRef.current
    if (!t) return
    t.options.fontSize = terminalFontSize
    let cancelled = false
    void (async () => {
      await Promise.race([
        document.fonts
          .load(`${terminalFontSize}px ${terminalFontFamily}`)
          .catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ])
      if (cancelled) return
      if (!terminalRef.current) return
      ensureFit('font-size')
    })()
    return () => {
      cancelled = true
    }
  }, [terminalFontSize, terminalFontFamily, ensureFit])

  // Update font family at runtime.
  // Same FOUT race as font-size: await the new face before fit() so the
  // atlas rasterizes against the correct cell metrics.
  useEffect(() => {
    const t = terminalRef.current
    if (!t) return
    t.options.fontFamily = terminalFontFamily
    let cancelled = false
    void (async () => {
      await Promise.race([
        document.fonts
          .load(`${terminalFontSize}px ${terminalFontFamily}`)
          .catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ])
      if (cancelled) return
      if (!terminalRef.current) return
      ensureFit('font-family')
    })()
    return () => {
      cancelled = true
    }
  }, [terminalFontFamily, terminalFontSize, ensureFit])

  // Fit-independent atlas correction.
  //
  // The WebGL glyph atlas can go stale with no JS-visible signal: macOS / Metal
  // (and other compositors) evict the atlas texture during long GPU idle, and
  // xterm exposes no event when this happens. The fit-triggered corrections in
  // the four useEffects above never fire for a terminal that sits visible-but-
  // idle, so the next paint reads dead tiles and the screen renders mangled
  // glyphs over correct layout — the v0.32.2 fix does not catch this.
  //
  // Re-correct on real return-to-foreground signals (visibility, focus) plus a
  // low-frequency heartbeat that catches the silent-eviction-while-visible
  // case. Render-only (`clearTextureAtlas` + `refresh`), no SIGWINCH. Gated on
  // active tab + visible document + WebGL addon present so hidden / DOM-renderer
  // terminals cost nothing. See working-notes/terminal-webgl-scramble.md.
  useEffect(() => {
    const tryCorrect = (): void => {
      if (!webglAddonRef.current) return
      if (!isActiveRef.current) return
      if (document.visibilityState !== 'visible') return
      scheduleAtlasCorrection()
      // Also nudge the scramble probe — return-to-foreground is the moment
      // a silently-evicted atlas first becomes user-visible, and waiting for
      // the next 5s probe tick leaves a window of visible scramble.
      scrambleProbeRef.current?.probe()
    }

    // Callback has its own `visibilityState !== 'visible'` early-return; the
    // timer also acts as a heartbeat that must coexist with focus +
    // visibilitychange listeners.
    // eslint-disable-next-line no-restricted-syntax
    const interval = window.setInterval(tryCorrect, 30_000)
    document.addEventListener('visibilitychange', tryCorrect)
    window.addEventListener('focus', tryCorrect)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', tryCorrect)
      window.removeEventListener('focus', tryCorrect)
    }
  }, [scheduleAtlasCorrection])

  // Respond to live `forceCompatibilityRenderer` toggles. The setting is also
  // honoured at terminal creation via `forceCompatRef.current` inside
  // `triggerWebglLoad`; this effect handles the case where the user flips it
  // while a terminal is already running.
  //
  // ON  → dispose the live WebGL addon + monitors, latch the session so any
  //       subsequent WebGL re-load stays a no-op until the setting flips back
  //       off.
  // OFF → clear the session latch so the *next* terminal mount can re-enable
  //       WebGL. The current already-DOM terminal stays DOM until next mount;
  //       reopening the tab brings WebGL back. Conservative choice: avoids
  //       silently re-loading WebGL behind the user's back.
  useEffect(() => {
    if (terminalForceCompatibilityRenderer) {
      const addon = webglAddonRef.current
      const terminal = terminalRef.current
      if (addon && terminal) {
        try {
          addon.dispose()
        } catch {
          /* already disposed */
        }
        webglAddonRef.current = null
        try {
          terminal.refresh(0, terminal.rows - 1)
        } catch {
          /* terminal disposed */
        }
        frameTimeStopRef.current?.()
        frameTimeStopRef.current = null
        scrambleProbeRef.current?.dispose()
        scrambleProbeRef.current = null
      }
      downgradedSessions.add(sessionId)
    } else {
      downgradedSessions.delete(sessionId)
    }
  }, [terminalForceCompatibilityRenderer, sessionId])

  // Update scrollback buffer at runtime.
  useEffect(() => {
    const t = terminalRef.current
    if (!t) return
    t.options.scrollback = terminalScrollback
  }, [terminalScrollback])

  // Handle Ctrl+Shift+C/V at the DOM level for reliable copy/paste on Linux/Windows.
  // Uses a capture-phase listener on the container so it fires before xterm.js
  // processes the key event. macOS uses Cmd+C/V natively via xterm.js.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleCopyPaste = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey) return

      if (e.code === 'KeyC') {
        e.preventDefault()
        e.stopPropagation()
        const sel = terminalRef.current?.getSelection()
        if (sel) void navigator.clipboard.writeText(trimSelectionTrailingSpaces(sel))
      }

      if (e.code === 'KeyV') {
        e.preventDefault()
        e.stopPropagation()
        void navigator.clipboard.readText().then((text) => {
          if (text) void trpcClient.pty.write.mutate({ sessionId, data: text })
        })
      }
    }

    container.addEventListener('keydown', handleCopyPaste, true)
    return () => container.removeEventListener('keydown', handleCopyPaste, true)
  }, [sessionId, trpcClient])

  // Report GENUINE user interaction to main — the "user engaged" axis of the
  // idle-close (hibernation) gate. Real DOM events only (keydown/mouse/wheel/
  // paste/focus), never PTY bytes (which carry focus/cursor protocol noise that
  // used to keep agents perpetually "active"). Throttled to ~once/4s so a draft
  // being typed keeps the agent alive without flooding IPC; focus always reports.
  // Hidden tabs (display:none) fire no events, so visibility is handled for free.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const TOUCH_THROTTLE_MS = 4000
    const report = (force: boolean): void => {
      const now = performance.now()
      if (!force && now - lastTouchSentRef.current < TOUCH_THROTTLE_MS) return
      lastTouchSentRef.current = now
      void trpcClient.pty.touch.mutate({ sessionId })
    }
    const onInteract = (): void => report(false)
    const onFocus = (): void => report(true)

    container.addEventListener('keydown', onInteract, true)
    container.addEventListener('mousedown', onInteract, true)
    container.addEventListener('wheel', onInteract, { capture: true, passive: true })
    container.addEventListener('paste', onInteract, true)
    container.addEventListener('focusin', onFocus, true)
    return () => {
      container.removeEventListener('keydown', onInteract, true)
      container.removeEventListener('mousedown', onInteract, true)
      container.removeEventListener('wheel', onInteract, true)
      container.removeEventListener('paste', onInteract, true)
      container.removeEventListener('focusin', onFocus, true)
    }
  }, [sessionId, trpcClient])

  // DIAGNOSTIC (gated by the diagnostics config in main; off → no-op): catch the
  // intermittent focus-theft regression where the xterm helper textarea blurs
  // and focus does NOT return shortly after, while the OS window is still
  // focused — i.e. an in-app steal, not the user switching apps. Records WHERE
  // focus landed so a prod repro names the culprit. Self-healed blurs (focus
  // returns to this terminal) and window-blur (alt-tab) are ignored; throttled.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // App-wide focus trail + last-input breadcrumb (install-once). Powers the
    // root-cause attribution attached to the report below.
    ensureFocusDiagnostics()

    const REPORT_THROTTLE_MS = 3000
    let lastReportAt = 0
    let lastHealAt = 0

    const ownsHelperTextarea = (el: EventTarget | null): boolean =>
      el instanceof Element &&
      el.classList.contains('xterm-helper-textarea') &&
      !!terminalRef.current?.element?.contains(el)

    const onFocusOut = (e: FocusEvent): void => {
      if (!ownsHelperTextarea(e.target)) return
      const textarea = e.target as Element
      const immediate = e.relatedTarget as Element | null
      // Cheap synchronous capture (stack + isConnected only). Runs on every
      // blur, so it does no layout work and self-guards. The 300ms gate then
      // decides if this blur was actually the failure worth the heavy walk.
      let sync
      try {
        sync = captureBlurSync(textarea)
      } catch {
        return // capture itself failed — nothing safe to report
      }
      // FAST self-heal. Clicking non-focusable app chrome (tree status headers,
      // layout divs, bare icons) clears focus to <body> via Chromium's focus-fixup,
      // leaving the terminal unfocused until the user clicks back in — the actual
      // bug behind the reports. Reclaim it on the next task: sub-frame, no
      // perceptible blur, no lost keystrokes. Gated hard so legitimate moves are
      // untouched — only when focus went NOWHERE (a move to a real control is
      // intentional) and the window still has focus (not alt-tab). terminalRef
      // .focus() no-ops on a hidden/inert/detached textarea, so genuine
      // "can't refocus" failures still fall through to the 300ms reporter below.
      window.setTimeout(() => {
        try {
          const active = document.activeElement
          if (ownsHelperTextarea(active)) return // already healed natively
          if (!document.hasFocus()) return // alt-tab / window blur
          const wentNowhere =
            active == null || active === document.body || active === document.documentElement
          if (!wentNowhere) return // focus moved to a real control — leave it
          if (!textarea.isConnected) return // torn down — let the reporter classify it
          const landedBefore = describeEl(active)
          terminalRef.current?.focus()
          if (!ownsHelperTextarea(document.activeElement)) return // hidden/inert → real failure
          const now = performance.now()
          if (now - lastHealAt < REPORT_THROTTLE_MS) return
          lastHealAt = now
          void trpcClient.diagnostics.recordClientEvent
            .mutate({
              event: 'terminal.focus_self_healed',
              level: 'info',
              sessionId,
              message: `xterm focus reclaimed after stray blur to <body> (mode=${mode})`,
              payload: {
                mode,
                ptyState: ptyStateRef.current,
                landedBefore,
                lastInput: getLastInput()
              }
            })
            .catch(() => {})
        } catch {
          /* self-heal must never break the terminal */
        }
      }, 0)
      window.setTimeout(() => {
        // Wrap the whole confirm+report path: a capture bug must never throw on
        // a timer (lost signal + noisy console) — degrade to a marker event.
        try {
          const active = document.activeElement
          if (ownsHelperTextarea(active)) return // self-healed → not a failure
          if (!document.hasFocus()) return // alt-tab / window blur → not in-app
          // Only the observed failure signature: focus went NOWHERE (body/root)
          // → the user "must click again". Intentional moves to another control
          // (editor, sidebar, dialog input) land on a real focusable and are NOT
          // this bug — skip them to keep the signal clean.
          const wentNowhere =
            active == null ||
            active === document.body ||
            active === document.documentElement
          if (!wentNowhere) return
          const now = performance.now()
          if (now - lastReportAt < REPORT_THROTTLE_MS) return
          lastReportAt = now
          // Heavy DOM walk happens HERE — only for confirmed failures.
          const ctx = settleBlurContext(textarea, terminalRef.current?.element, container, sync)
          const cause = classifyFocusLoss(ctx)
          void trpcClient.diagnostics.recordClientEvent
            .mutate({
              event: 'terminal.focus_lost_no_refocus',
              level: 'warn',
              sessionId,
              message: `xterm lost focus and did not refocus within 300ms (mode=${mode}, cause=${cause})`,
              payload: {
                mode,
                ptyState: ptyStateRef.current,
                // Automatic root-cause classification + the evidence behind it.
                cause,
                blurStack: ctx.blurStack,
                // Connectivity at the blur instant (cheap, blur-time signal).
                domAtBlur: { textareaConnected: ctx.textareaConnectedAtBlur },
                // Settled DOM state at +300ms — what decides "why couldn't it
                // refocus": teardown / tab-hide / inert-or-disabled / in-place.
                dom: {
                  textareaConnected: ctx.textareaConnected,
                  terminalConnected: ctx.terminalConnected,
                  containerConnected: ctx.containerConnected,
                  hiddenAncestor: ctx.hiddenAncestor,
                  focusBlocker: ctx.focusBlocker
                },
                // How recently the terminal painted — confirms/refutes the
                // output-correlation the earlier CDP run observed.
                sinceOutputMs: ctx.sinceOutputMs,
                // Was a real user action close before the steal? No recent input
                // → spurious/programmatic navigation, not the user leaving.
                lastInput: {
                  key: ctx.lastKey,
                  sinceKeyMs: ctx.sinceKeyMs,
                  pointerTarget: ctx.lastPointerTarget,
                  sincePointerMs: ctx.sincePointerMs
                },
                focusTrail: getFocusTrail(),
                landedOn: describeEl(active),
                immediateRelated: describeEl(immediate),
                visibility: document.visibilityState,
                // hibernate-warn countdown overlay (Moon icon) lives in the
                // TerminalStarter wrapper (sibling of <Terminal>), so look up to
                // the nearest positioned ancestor, not inside our own container.
                countdownVisible: !!(container.closest('div.relative') ?? container.parentElement)?.querySelector(
                  '.animate-pulse'
                )
              }
            })
            .catch(() => {})
        } catch (err) {
          // Never lose the signal to a capture bug — emit a minimal marker so
          // the failure itself is visible in the diagnostics stream.
          try {
            void trpcClient.diagnostics.recordClientEvent
              .mutate({
                event: 'terminal.focus_lost_no_refocus',
                level: 'warn',
                sessionId,
                message: `focus-loss capture failed (mode=${mode})`,
                payload: {
                  mode,
                  cause: 'capture-error',
                  captureError: String((err as Error)?.message ?? err),
                  blurStack: sync.blurStack
                }
              })
              .catch(() => {})
          } catch {
            /* give up silently — diagnostics must never break the terminal */
          }
        }
      }, 300)
    }

    container.addEventListener('focusout', onFocusOut, true)
    return () => container.removeEventListener('focusout', onFocusOut, true)
  }, [sessionId, mode, trpcClient])

  // Intercept Cmd+C / right-click Copy (xterm's native path writes raw
  // selection text, which includes trailing spaces from rendered padding).
  // Override clipboard payload with right-trimmed lines.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onCopy = (e: ClipboardEvent): void => {
      const sel = terminalRef.current?.getSelection()
      if (!sel) return
      const cleaned = trimSelectionTrailingSpaces(sel)
      if (cleaned === sel) return
      e.clipboardData?.setData('text/plain', cleaned)
      e.preventDefault()
    }

    container.addEventListener('copy', onCopy, true)
    return () => container.removeEventListener('copy', onCopy, true)
  }, [])

  // Handle paste and drag-drop for files/images
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Convert File to base64
    const fileToBase64 = (file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          resolve(result.split(',')[1]) // Remove data:...;base64, prefix
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
    }

    // Insert path into terminal (escape if has spaces).
    // Route through xterm paste() so bracketed-paste wraps the payload when
    // the foreground app enabled ?2004h (e.g. Claude Code) — required for
    // CC's image-from-path detection. Plain shells without bracketed paste
    // get raw bytes, same as a direct PTY write.
    const insertPath = (path: string) => {
      const escaped = path.includes(' ') ? `"${path}"` : path
      terminalRef.current?.paste(escaped)
    }

    // Process a single file. Electron 32+ removed File.path; real disk paths
    // must come from webUtils.getPathForFile, which only works in preload —
    // pass the pre-extracted path in for drop events.
    const processFile = async (
      file: File,
      mimeType?: string,
      droppedPath?: string
    ): Promise<string | null> => {
      if (droppedPath) return droppedPath
      if (mimeType?.startsWith('image/') || file.type.startsWith('image/')) {
        // Image from clipboard (screenshot, browser copy) - save to temp
        const base64 = await fileToBase64(file)
        const result = await trpcClient.app.files.saveTempImage.mutate({
          base64,
          mimeType: mimeType || file.type
        })
        if (result.success && result.path) {
          return result.path
        }
      }
      return null
    }

    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      // Symmetric with handleDrop: preload's capture-phase paste listener
      // already resolved any filesystem paths (Finder-pasted files) via
      // webUtils. Zip by index with file items. This is a synchronous preload-
      // native call (webUtils.getPathForFile) with NO tRPC router procedure —
      // it stays on the IPC bridge.
      const pastedPaths = electronBootstrap.getPastePaths()

      const paths: string[] = []
      let fileIdx = 0

      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (!file) {
            fileIdx++
            continue
          }

          e.preventDefault()
          const path = await processFile(file, item.type, pastedPaths[fileIdx])
          if (path) paths.push(path)
          fileIdx++
        }
      }

      if (paths.length > 0) {
        insertPath(paths.join(' '))
        terminalRef.current?.focus()
      }
    }

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragOver(false)
      terminalRef.current?.focus()

      const files = e.dataTransfer?.files
      if (!files?.length) return

      // Preload's capture-phase drop listener already extracted real disk
      // paths via webUtils.getPathForFile; zip by index with the File list.
      // Synchronous preload-native call (no tRPC router procedure) — stays on
      // the IPC bridge.
      const droppedPaths = electronBootstrap.getDropPaths()

      try {
        const paths: string[] = []
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          const path = await processFile(file, undefined, droppedPaths[i])
          if (path) paths.push(path)
        }

        if (paths.length > 0) {
          insertPath(paths.join(' '))
        }
      } finally {
        terminalRef.current?.focus()
      }
    }

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragOver(true)
      }
      terminalRef.current?.focus()
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragOver(false)
      }
    }

    container.addEventListener('paste', handlePaste)
    container.addEventListener('dragenter', handleDragEnter)
    container.addEventListener('drop', handleDrop)
    container.addEventListener('dragover', handleDragOver)
    container.addEventListener('dragleave', handleDragLeave)

    return () => {
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('dragenter', handleDragEnter)
      container.removeEventListener('drop', handleDrop)
      container.removeEventListener('dragover', handleDragOver)
      container.removeEventListener('dragleave', handleDragLeave)
    }
  }, [sessionId, trpcClient])

  const isLoading =
    !initError && (isInitializing || isReplaying || isResuming || ptyState === 'starting')

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    try {
      searchAddonRef.current?.clearDecorations()
    } catch {
      /* */
    }
    terminalRef.current?.focus()
  }, [])

  const handleRetry = useCallback(() => {
    setDeadExitCode(null)
    setDeadCrashOutput(null)
    setDeadReason(null)
    setDoctorResults(null)
    onRetry?.()
  }, [onRetry])

  // "Start fresh" on a stale (auto-cleaned) session: clear the dead overlay and
  // ask the parent to start a brand-new session (clears the stored conversation
  // id + remounts). See issue #90.
  const handleStartFresh = useCallback(() => {
    setDeadExitCode(null)
    setDeadCrashOutput(null)
    setDeadReason(null)
    setDoctorResults(null)
    onStartFreshRef.current?.()
  }, [])

  const handleDoctor = useCallback(async () => {
    setDoctorLoading(true)
    setDoctorResults(null)
    try {
      const results = await trpcClient.pty.validate.query({ mode })
      setDoctorResults(results)
    } catch {
      setDoctorResults([{ check: 'Validation', ok: false, detail: 'Failed to run checks' }])
    } finally {
      setDoctorLoading(false)
    }
  }, [mode, trpcClient])

  const showDeadOverlay =
    ptyState === 'dead' && !isInitializing && deadExitCode !== null && mode !== 'terminal'

  // Stale-session case (issue #90): the CLI's stored conversation id was
  // auto-cleaned by the provider, so `--resume` failed. Show a friendly,
  // provider-named message + a single "Start fresh" action instead of the
  // generic exit-code overlay.
  const isStaleSession = deadReason === 'SESSION_NOT_FOUND'
  const providerLabel = DETECTION_ENGINES.find((e) => e.type === mode)?.label ?? 'The agent'

  return (
    <div className="relative h-full w-full">
      {searchOpen && searchAddonRef.current && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current}
          onClose={handleSearchClose}
          focusToken={searchFocusToken}
        />
      )}
      <div
        tabIndex={0}
        className={`h-full w-full rounded-lg outline-none overflow-hidden transition-colors ${
          isDragOver ? 'ring-2 ring-blue-500/50 ring-inset' : ''
        }`}
        style={{ padding: '8px', backgroundColor: resolvedTerminalTheme.background ?? '#0a0a0a' }}
        onClick={() => terminalRef.current?.focus()}
      >
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
        {isLoading && (
          <div
            className="absolute inset-0 z-10"
            style={{ backgroundColor: resolvedTerminalTheme.background ?? '#0a0a0a' }}
          >
            <PulseGrid />
          </div>
        )}
        {initError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background dark:bg-surface-0 z-10 p-4">
            <div className="text-red-400 text-sm text-center">
              Failed to start terminal: {initError}
            </div>
          </div>
        )}
        {showDeadOverlay && (
          <TerminalDeadOverlay
            isStaleSession={isStaleSession}
            providerLabel={providerLabel}
            deadCrashOutput={deadCrashOutput}
            deadExitCode={deadExitCode}
            onRetry={onRetry}
            onStartFresh={handleStartFresh}
            onRetryClick={handleRetry}
            onDoctor={() => void handleDoctor()}
            doctorLoading={doctorLoading}
            doctorResults={doctorResults}
          />
        )}
      </div>
    </div>
  )
})
