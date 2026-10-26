// IMPORTANT: Import via `./LazyTerminal` from consumer code, not this file
// directly. This module pulls in xterm + addons + xterm.css (~440KB minified)
// which the LazyTerminal wrapper splits into its own chunk via React.lazy.
// Direct imports from `./Terminal` will land xterm back in the main renderer
// bundle and undo the boot-time split. The package's "./client/Terminal"
// export exists only for the lazy wrapper itself.
import {
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useState,
  forwardRef,
  useImperativeHandle
} from 'react'
import { useTRPC, useTRPCClient, useSubscription } from '@slayzone/transport/client'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  matchesShortcut,
  useShortcutStore,
  useStableCallback,
  PulseGrid,
  safeClipboardWriteText,
  safeClipboardReadText
} from '@slayzone/ui'
import { SerializeAddon } from '@xterm/addon-serialize'
import { SearchAddon } from '@xterm/addon-search'
import type { WebglAddon } from '@xterm/addon-webgl'
import { initTerminalSession, type TerminalInitOptions } from './terminal-session-init'
import { watchTerminalFocusLoss } from './terminal-focus-watch'
import { installTerminalFileInput } from './terminal-file-input'
import { correctAtlas } from './webgl-loader'
import { isParked, unparkToDom } from './renderer-park'
import { promoteInitSlot } from './terminal-init-scheduler'
import { noteTerminalMounted } from './open-trace'
import { touchTerminalMru } from './terminal-mru'
import type { ScrambleProbe } from './scramble-detector'
import { decideThrottle, DEFAULT_THROTTLE_OPTIONS } from './paint-throttle'
import { diag } from './terminal-webgl-diag'
import { trimSelectionTrailingSpaces } from './Terminal.utils'
import { noteTerminalOutput } from './focus-loss-diag'
import { TerminalDeadOverlay } from './TerminalDeadOverlay'
import '@xterm/xterm/css/xterm.css'

import { downgradedSessions, fakeDowngradeRegistry } from './terminal-webgl-sessions'
import {
  setTerminal,
  disposeTerminal,
  updateAllThemes,
  unregisterActiveAddon,
  unregisterActiveTerminal,
  getLiveTerminals
} from './terminal-cache'
import { usePty } from './PtyContext'
import { useSessionState } from './useTerminalStateStore'
import { useTheme, useAppearance } from '@slayzone/settings/client'
import { getThemeTerminalColors } from '@slayzone/ui'
import { TerminalSearchBar } from './TerminalSearchBar'
import type { TerminalState } from '@slayzone/terminal/shared'
import { startingWatchdogVerdict, STARTING_WATCHDOG_INTERVAL_MS } from './starting-watchdog'
import type { TerminalProps, TerminalHandle } from './Terminal.types'
import {
  stripUnderlineCodes,
  KITTY_SHIFT_ENTER,
  DETECTION_ENGINES
} from '@slayzone/terminal/shared'
import { track } from '@slayzone/telemetry/client'

export type { TerminalProps, TerminalHandle } from './Terminal.types'

/** Host style for a terminal nobody can see — see the host `<div>` below. */
const HIDDEN_HOST_STYLE = { contentVisibility: 'hidden' } as const

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
  // Set by init: attach this terminal's on-screen renderer (see the reveal effect).
  const ensureRendererRef = useRef<((opts: { sync: boolean }) => void) | null>(null)
  const clearedSeqRef = useRef<number | null>(null)
  const initializedRef = useRef(false)
  const lastRenderedSeqRef = useRef<number>(-1)
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useRef(0)
  const [searchOpen, setSearchOpen] = useState(false)
  // The search bar renders from state, not from searchAddonRef (a ref read during render).
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null)
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
    noteTerminalMounted(sessionId)
  }, [sessionId])
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
  /** Why the session ended, when the exit code can't say (see exit-description.ts). */
  const [deadExitReason, setDeadExitReason] = useState<string | null>(null)
  const [doctorResults, setDoctorResults] = useState<
    import('@slayzone/terminal/shared').ValidationResult[] | null
  >(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  // Refs for callbacks to prevent initTerminal dependency churn. A callback that
  // updates task state in the parent recreates callback refs, which would
  // abort+restart initTerminal mid-initialization — causing a data loss window
  // where PTY output is silently dropped. Reading through refs breaks that cycle.
  const onStartFreshRef = useRef(onStartFresh)
  const onReadyRef = useRef(onReady)
  const isActiveRef = useRef(isActive)
  const pausedRef = useRef(paused)
  const onAttachedRef = useRef(onAttached)
  const onFirstInputRef = useRef(onFirstInput)
  const onOpenUrlRef = useRef(onOpenUrl)
  const onOpenFileRef = useRef(onOpenFile)
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
  const existingConversationIdRef = useRef(existingConversationId)
  const initialPromptRef = useRef(initialPrompt)
  const providerFlagsRef = useRef(providerFlags)
  const executionContextRef = useRef(executionContext)

  const trpcClient = useTRPCClient()
  const trpc = useTRPC()
  const { subscribe, subscribeExit, getCrashOutput, resetTaskState, cleanupTask } = usePty()
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

  const resolvedTerminalTheme = getThemeTerminalColors(terminalThemeId, contentVariant)
  const resolvedTerminalVariant = contentVariant
  // Values a (re)init reads without re-initializing when they change — font,
  // theme and scrollback changes are applied to the live terminal by the
  // effects below.
  const initOptionsRef = useRef<TerminalInitOptions>({
    fontSize: terminalFontSize,
    fontFamily: terminalFontFamily,
    scrollback: terminalScrollback,
    theme: resolvedTerminalTheme,
    variant: resolvedTerminalVariant,
    supportsSessionId
  })

  // Commit the latest props/settings into the refs above. Written here (not
  // during render) and before any layout/passive effect of the same commit, so
  // initTerminal and the xterm handlers always read what was last committed.
  useInsertionEffect(() => {
    onStartFreshRef.current = onStartFresh
    onReadyRef.current = onReady
    isActiveRef.current = isActive
    pausedRef.current = paused
    onAttachedRef.current = onAttached
    onFirstInputRef.current = onFirstInput
    onOpenUrlRef.current = onOpenUrl
    onOpenFileRef.current = onOpenFile
    conversationIdRef.current = conversationId
    existingConversationIdRef.current = existingConversationId
    initialPromptRef.current = initialPrompt
    providerFlagsRef.current = providerFlags
    executionContextRef.current = executionContext
    forceCompatRef.current = terminalForceCompatibilityRenderer
    initOptionsRef.current = {
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      scrollback: terminalScrollback,
      theme: resolvedTerminalTheme,
      variant: resolvedTerminalVariant,
      supportsSessionId
    }
  })

  // Re-rasterize the WebGL atlas after a post-startup `fit()`. A fit changes the
  // char-cell geometry; webgl-loader only corrects the atlas across the startup
  // window, so a resize / font change after that leaves the atlas built against
  // stale metrics and the screen scrambles. rAF-debounced so a resize drag (many
  // fits per second) coalesces to one correction on the settled frame. No-op when
  // the DOM renderer is active (no addon).
  const scheduleAtlasCorrection = useCallback(
    (site = 'fit'): void => {
      if (atlasCorrectionRafRef.current !== null) {
        cancelAnimationFrame(atlasCorrectionRafRef.current)
      }
      atlasCorrectionRafRef.current = requestAnimationFrame(() => {
        atlasCorrectionRafRef.current = null
        const addon = webglAddonRef.current
        const terminal = terminalRef.current
        if (addon && terminal) {
          // getLiveTerminals: the atlas is SHARED across panes, so the repack
          // invalidates every one of them — each needs a frame or it keeps
          // painting stale texcoords. See correctAtlas.
          correctAtlas(addon, terminal, sessionId, site, getLiveTerminals)
          // The atlas was just intentionally re-rasterized — the scramble probe's
          // current baseline points at the *old* atlas pixels and would now flag
          // every cell as drift. Re-baseline so the probe tracks the new atlas.
          scrambleProbeRef.current?.rebaseline()
        }
      })
    },
    [sessionId]
  )

  // Idempotent fit: only calls fit() when the proposed geometry (measured from
  // the current container width + cell size) differs from what the terminal
  // currently renders. Safe to call at any time — a matching geometry is a
  // no-op, so it can back every fit trigger without spurious SIGWINCH/atlas
  // churn. Covers BOTH drift axes: a container-width change (the mount race)
  // and a cell-size change (webfont FOUT swapping the measured cell after the
  // init fit). Returns true when it actually re-fit.
  const ensureFit = useCallback(
    (site: string): boolean => {
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      if (!terminal || !fitAddon) return false
      const proposed = fitAddon.proposeDimensions()
      if (!proposed || Number.isNaN(proposed.cols) || Number.isNaN(proposed.rows)) return false
      if (proposed.cols === terminal.cols && proposed.rows === terminal.rows) return false
      fitAddon.fit()
      diag(sessionId, 'fit', { site, terminal })
      scheduleAtlasCorrection(`fit:${site}`)
      return true
    },
    [sessionId, scheduleAtlasCorrection]
  )

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
      // Task-tab switching (⌘⌥←/→, Ctrl+PgUp/PgDn off macOS) belongs to the app even
      // from a focused terminal — xterm would send the keys to the shell instead.
      const { getKeys } = useShortcutStore.getState()
      if (
        matchesShortcut(e, getKeys('next-task-tab')) ||
        matchesShortcut(e, getKeys('prev-task-tab'))
      )
        return false
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
    (signal: AbortSignal) =>
      initTerminalSession(
        {
          sessionId,
          cwd,
          mode,
          trpcClient,
          resetTaskState,
          handleTerminalKeyEvent,
          clearBufferWithoutRestart,
          scheduleAtlasCorrection,
          optionsRef: initOptionsRef,
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
          initialPromptRef,
          providerFlagsRef,
          executionContextRef,
          setIsInitializing,
          setInitError,
          setPtyState,
          setIsResuming,
          setSearchAddon
        },
        signal
      ),
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
      ensureRendererRef.current = null
      unregisterActiveAddon(sessionId)
      // Drop the mounted-terminal registration. The instance stays reachable for
      // the atlas broadcast via the module cache below (setTerminal) when it is
      // cached; if it is disposed instead, it must not be broadcast to at all.
      unregisterActiveTerminal(sessionId)
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
      setSearchAddon(null)
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

    const unsubExit = subscribeExit(sessionId, (exitCode, reason, exitReason) => {
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
      setDeadExitReason(exitReason ?? null)
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
    }
    void replay().finally(() => {
      if (!cancelled) setIsReplaying(false)
    })
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

  // Revealed: this terminal now needs pixels. A terminal that was never on
  // screen (or whose WebGL renderer the budget evicted) is parked — attach its
  // renderer before this commit paints, so the reveal frame shows the buffer
  // (see renderer-park.ts / webgl-budget.ts). One still waiting in the boot init
  // queue initialises right away instead of in its turn.
  useLayoutEffect(() => {
    if (!isActive) return
    touchTerminalMru(sessionId)
    if (promoteInitSlot(sessionId)) return
    ensureRendererRef.current?.({ sync: true })
  }, [isActive, sessionId])

  // Re-fit + re-rasterize on isActive false→true. A task switch is a CSS
  // visibility:hidden flip — no ResizeObserver fires on its own — so a panel
  // width change made while this tab was hidden (or a cell-metric change) can
  // leave stale cols/rows by the time the user returns. NOT gated on the WebGL
  // addon: DOM-renderer terminals (no addon) need the re-fit too, and
  // ensureFit's mismatch check makes it a no-op when nothing changed.
  // scheduleAtlasCorrection() inside ensureFit already no-ops without an addon.
  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      // Record that the handler RAN, with whether it had to re-fit. `ensureFit`
      // is idempotent, so on an unchanged panel it emits no `fit` event at all —
      // which leaves this reveal path with no trace of having executed. The
      // marker is the observable seam a test can gate on; asserting on the
      // conditional `fit` instead cannot tell a healthy no-op from a handler
      // that was never wired up.
      const refit = ensureFit('reactivate')
      diag(sessionId, 'reactivate', { terminal: terminalRef.current, refit })
    }
    wasActiveRef.current = isActive
  }, [isActive, ensureFit, sessionId])

  // Re-fit terminal when PTY dimensions need resync (e.g., after floating agent
  // reattach). Server fan-out is global; filter by sessionId. The follow-up
  // resize uses the tRPC mutation.
  const handleResizeNeeded = useStableCallback(({ sessionId: sid }: { sessionId: string }) => {
    if (sid !== sessionId || !fitAddonRef.current || !terminalRef.current) return
    fitAddonRef.current.fit()
    diag(sessionId, 'fit', { site: 'resize-needed', terminal: terminalRef.current })
    scheduleAtlasCorrection('fit:resize-needed')
    void trpcClient.pty.resize.mutate({
      sessionId,
      cols: terminalRef.current.cols,
      rows: terminalRef.current.rows
    })
  })
  useSubscription(
    trpc.pty.onResizeNeeded.subscriptionOptions(undefined, { onData: handleResizeNeeded })
  )

  // Safety net: prevent permanent 'starting' state after init completes.
  // If the backend dies or IPC events are lost, this watchdog transitions
  // to 'dead' so the user sees the retry overlay instead of infinite loading.
  // A session the backend still holds as starting is waited on, not judged —
  // it may be queued for an agent-start slot (see starting-watchdog.ts).
  useEffect(() => {
    if (isInitializing || initError || ptyState !== 'starting') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const armedAt = Date.now()
    const check = async (): Promise<void> => {
      const exists = await trpcClient.pty.exists.query({ sessionId })
      const actual = await trpcClient.pty.getState.query({ sessionId })
      if (cancelled) return
      const verdict = startingWatchdogVerdict({ exists, actual, waitedMs: Date.now() - armedAt })
      if (verdict.kind === 'adopt') {
        setPtyState(verdict.state)
      } else if (verdict.kind === 'wait') {
        timer = setTimeout(() => void check(), STARTING_WATCHDOG_INTERVAL_MS)
      } else if (verdict.kind === 'dead') {
        console.warn(
          `[terminal] watchdog: ${sessionId} stuck in 'starting' for ${String(Date.now() - armedAt)}ms, transitioning to dead`
        )
        setPtyState('dead')
        setDeadExitCode(-1)
        setDeadExitReason('no-response')
      }
    }
    timer = setTimeout(() => void check(), STARTING_WATCHDOG_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isInitializing, initError, ptyState, sessionId, trpcClient])

  // Revealed while its agent is still starting: it may be waiting for an
  // agent-start slot behind other tabs' agents (workspace restore), so ask for it
  // to go next. A no-op for a session that has already started.
  useEffect(() => {
    if (!isActive || isInitializing || ptyState !== 'starting') return
    trpcClient.pty.prioritize.mutate({ sessionId }).catch(() => {
      // Best-effort ordering hint: an older hub without it just keeps FIFO order.
    })
  }, [isActive, isInitializing, ptyState, sessionId, trpcClient])

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
        document.fonts.load(`${terminalFontSize}px ${terminalFontFamily}`).catch(() => undefined),
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
        document.fonts.load(`${terminalFontSize}px ${terminalFontFamily}`).catch(() => undefined),
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
    // `site` distinguishes the three triggers in the diag ring — the heartbeat
    // is the one that repacks a SHARED atlas on a pane the user never touched,
    // so telling it apart from a genuine return-to-foreground matters when
    // reading a scramble timeline.
    const tryCorrect = (site: string) => (): void => {
      if (!webglAddonRef.current) return
      if (!isActiveRef.current) return
      if (document.visibilityState !== 'visible') return
      scheduleAtlasCorrection(site)
      // Also nudge the scramble probe — return-to-foreground is the moment
      // a silently-evicted atlas first becomes user-visible, and waiting for
      // the next 5s probe tick leaves a window of visible scramble.
      scrambleProbeRef.current?.probe()
    }
    const onVisibility = tryCorrect('visibilitychange')
    const onFocus = tryCorrect('focus')

    // Callback has its own `visibilityState !== 'visible'` early-return; the
    // timer also acts as a heartbeat that must coexist with focus +
    // visibilitychange listeners.
    // eslint-disable-next-line no-restricted-syntax
    const interval = window.setInterval(tryCorrect('heartbeat'), 30_000)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
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
      // A parked terminal (never shown, or evicted from the WebGL budget) draws
      // nothing — it needs xterm's DOM renderer now.
      if (terminal && isParked(terminal)) unparkToDom(terminal)
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
        if (sel) void safeClipboardWriteText(trimSelectionTrailingSpaces(sel))
      }

      if (e.code === 'KeyV') {
        e.preventDefault()
        e.stopPropagation()
        void safeClipboardReadText().then((text) => {
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

  // DIAGNOSTIC: in-app focus theft from the xterm textarea (see watchTerminalFocusLoss).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return watchTerminalFocusLoss({
      container,
      terminalRef,
      ptyStateRef,
      sessionId,
      mode,
      trpcClient
    })
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
    return installTerminalFileInput({
      container,
      terminalRef,
      dragCounter,
      setIsDragOver,
      trpcClient
    })
  }, [sessionId, trpcClient])

  const isLoading =
    !initError && (isInitializing || isReplaying || isResuming || ptyState === 'starting')

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    const addon = searchAddonRef.current
    if (addon) {
      try {
        addon.clearDecorations()
      } catch {
        /* */
      }
    }
    terminalRef.current?.focus()
  }, [])

  const handleRetry = useCallback(() => {
    setDeadExitCode(null)
    setDeadCrashOutput(null)
    setDeadReason(null)
    setDeadExitReason(null)
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
    setDeadExitReason(null)
    setDoctorResults(null)
    onStartFreshRef.current?.()
  }, [])

  const handleDoctor = useCallback(async () => {
    setDoctorLoading(true)
    setDoctorResults(null)
    const results = await trpcClient.pty.validate
      .query({ mode })
      .catch(() => [{ check: 'Validation', ok: false, detail: 'Failed to run checks' }])
    setDoctorResults(results)
    setDoctorLoading(false)
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
      {searchOpen && searchAddon && (
        <TerminalSearchBar
          searchAddon={searchAddon}
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
        {/* Hidden terminal: keep parsing output, stop painting it. A hidden tab is
            `visibility: hidden`, which still intersects the viewport, so xterm's
            IntersectionObserver never paused its renderer and every hidden terminal
            painted every output chunk — main-thread work that lands on a tab switch.
            `content-visibility: hidden` skips the subtree, so the observer reports
            it off-screen and xterm pauses (buffer, modes and scroll position stay
            live); on reveal xterm repaints the whole viewport. The host box keeps
            its size, so the ResizeObserver above never sees a resize. */}
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden"
          style={isActive ? undefined : HIDDEN_HOST_STYLE}
        />
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
            deadExitReason={deadExitReason}
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
