import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
// import { WebLinksAddon } from '@xterm/addon-web-links' // Disabled - causes persistent underlines
import { SerializeAddon } from '@xterm/addon-serialize'
import { SearchAddon } from '@xterm/addon-search'
// import { WebglAddon } from '@xterm/addon-webgl' // Disabled - bypasses CSS underline fix
import '@xterm/xterm/css/xterm.css'

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

import { getTerminal, setTerminal, disposeTerminal, updateAllThemes } from './terminal-cache'
import { usePty } from './PtyContext'
import { useTheme, useAppearance } from '@slayzone/settings/client'
import { getTerminalTheme } from './terminal-themes'
import { TerminalSearchBar } from './TerminalSearchBar'
import type { TerminalMode, TerminalState } from '@slayzone/terminal/shared'

// Wait for container to have non-zero dimensions before opening terminal
function waitForDimensions(
  container: HTMLElement,
  signal: AbortSignal,
  timeoutMs = 3000
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Already has dimensions? Resolve immediately
    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      resolve()
      return
    }

    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      observer.disconnect()
      signal.removeEventListener('abort', onAbort)
    }

    // Timeout to prevent hanging forever
    const timeoutId = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    // Otherwise wait for ResizeObserver
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        cleanup()
        resolve()
      }
    })

    // Handle abort (component unmount)
    const onAbort = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort)

    observer.observe(container)
  })
}

interface TerminalProps {
  sessionId: string
  cwd: string
  mode?: TerminalMode
  conversationId?: string | null
  existingConversationId?: string | null
  initialPrompt?: string | null
  providerFlags?: string | null
  executionContext?: import('@slayzone/terminal/shared').ExecutionContext | null
  isActive?: boolean
  onAttached?: (api: { focus: () => void }) => void
  onConversationCreated?: (conversationId: string) => void
  onSessionInvalid?: () => void
  onReady?: (api: {
    sendInput: (text: string) => Promise<void>
    write: (data: string) => Promise<boolean>
    focus: () => void
    clearBuffer: () => Promise<void>
  }) => void
  onFirstInput?: () => void
  onRetry?: () => void
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
}

export interface TerminalHandle {
  focus: () => void
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({
  sessionId,
  cwd,
  mode = 'claude-code',
  conversationId,
  existingConversationId,
  initialPrompt,
  providerFlags,
  executionContext,
  isActive = true,
  onAttached,
  onConversationCreated,
  onSessionInvalid,
  onReady,
  onFirstInput,
  onRetry
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)

  useImperativeHandle(ref, () => ({
    focus: () => terminalRef.current?.focus()
  }))
  const fitAddonRef = useRef<FitAddon | null>(null)
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const clearedSeqRef = useRef<number | null>(null)
  const initializedRef = useRef(false)
  const lastRenderedSeqRef = useRef<number>(-1)
  const [isDragOver, setIsDragOver] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [isInitializing, setIsInitializing] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)
  const [deadExitCode, setDeadExitCode] = useState<number | null>(null)
  const [deadCrashOutput, setDeadCrashOutput] = useState<string | null>(null)
  const [doctorResults, setDoctorResults] = useState<import('@slayzone/terminal/shared').ValidationResult[] | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(false)

  // Refs for callbacks to prevent initTerminal dependency churn.
  // When onConversationCreated fires (saving conversation ID), it updates task state
  // in the parent, which recreates callback refs, which would abort+restart initTerminal
  // mid-initialization — causing a data loss window where PTY output is silently dropped.
  const onConversationCreatedRef = useRef(onConversationCreated)
  onConversationCreatedRef.current = onConversationCreated
  const onSessionInvalidRef = useRef(onSessionInvalid)
  onSessionInvalidRef.current = onSessionInvalid
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const onAttachedRef = useRef(onAttached)
  onAttachedRef.current = onAttached
  const onFirstInputRef = useRef(onFirstInput)
  onFirstInputRef.current = onFirstInput
  const hasCalledFirstInputRef = useRef(false)

  const { subscribe, subscribeExit, subscribeSessionInvalid, subscribeAttention, subscribeState, getState, getCrashOutput, resetTaskState, cleanupTask } = usePty()
  const { theme } = useTheme()
  const { terminalFontSize, terminalFontFamily, terminalScrollback } = useAppearance()

  const [ptyState, setPtyState] = useState<TerminalState>(() => getState(sessionId))

  const clearBufferWithoutRestart = useCallback(async (): Promise<void> => {
    const result = await window.api.pty.clearBuffer(sessionId)
    if (!result.success) return

    clearedSeqRef.current = result.clearedSeq
    terminalRef.current?.clear()
    terminalRef.current?.write('\x1b[0m')
  }, [sessionId])

  const handleTerminalKeyEvent = useCallback((e: KeyboardEvent): boolean => {
    if (e.ctrlKey && e.key === 'Tab') return false
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && e.type === 'keydown') {
      setSearchOpen(true)
      return false
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k' && e.type === 'keydown') {
      void clearBufferWithoutRestart()
      return false
    }
    return true
  }, [clearBufferWithoutRestart])

  const initTerminal = useCallback(async (signal: AbortSignal) => {
    if (!containerRef.current || initializedRef.current) return
    setIsInitializing(true)
    setInitError(null)
    let didInit = false

    try {
      // Wait for container to have dimensions BEFORE initializing terminal
      try {
        await waitForDimensions(containerRef.current, signal)
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        throw e
      }

      const rect = containerRef.current.getBoundingClientRect()

      // Re-check after await (component state might have changed)
      if (!containerRef.current || initializedRef.current || signal.aborted) return

      // Don't initialize if container still has 0 dimensions (not visible).
      // Keep isInitializing=true so spinner stays visible — ResizeObserver will
      // retry initTerminal when the container becomes visible.
      if (rect.width === 0 || rect.height === 0) {
        return
      }

      didInit = true
      initializedRef.current = true

      // Check if we have a cached terminal for this task
      const cached = getTerminal(sessionId)
      if (cached) {
        // If mode changed, dispose cached terminal and kill old PTY to start fresh
        if (cached.mode !== mode) {
          // Reset state FIRST to ignore any in-flight data
          resetTaskState(sessionId)
          disposeTerminal(sessionId)
          // Kill old PTY (any data it sends will be ignored)
          await window.api.pty.kill(sessionId)
        } else {
          // Reattach existing terminal (container already has dimensions)
          containerRef.current.appendChild(cached.element)
          onAttachedRef.current?.({ focus: () => cached.terminal.focus() })
          cached.terminal.options.theme = getTerminalTheme(theme)
          cached.terminal.options.minimumContrastRatio = theme === 'light' ? 4.5 : 1
          terminalRef.current = cached.terminal
          fitAddonRef.current = cached.fitAddon
          serializeAddonRef.current = cached.serializeAddon
          searchAddonRef.current = cached.searchAddon

          // Re-attach key handler (old closure captured stale setSearchOpen)
          cached.terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent)

          // Simple fit - container is guaranteed to have dimensions
          cached.fitAddon.fit()
          window.api.pty.resize(sessionId, cached.terminal.cols, cached.terminal.rows)
          cached.terminal.write('\x1b[0m') // Reset ANSI state on reattach

          // Sync state from backend (fixes stuck loading spinner on reattach)
          const actualState = await window.api.pty.getState(sessionId)
          if (signal.aborted) return // Don't setState if unmounted
          if (actualState) setPtyState(actualState)

          // Replay any data that arrived while terminal was detached.
          // During abort/reinit cycles, terminalRef is null so the subscribe
          // callback's write() is a no-op — this fills that gap.
          // Use lastRenderedSeqRef (tracks xterm writes) not getLastSeq
          // (tracks PtyContext receives — advances even when terminalRef is null).
          const missed = await window.api.pty.getBufferSince(sessionId, lastRenderedSeqRef.current)
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
              for (const char of text) {
                cached.terminal.input(char)
                await new Promise(r => setTimeout(r, 1))
              }
            },
            write: (data) => window.api.pty.write(sessionId, data),
            focus: () => cached.terminal.focus(),
            clearBuffer: clearBufferWithoutRestart
          })
          return
        }
      }

      // Create new terminal
      const terminal = new XTerm({
        allowProposedApi: true,
        cursorBlink: true,
        fontSize: terminalFontSize,
        fontFamily: terminalFontFamily,
        scrollback: terminalScrollback,
        theme: getTerminalTheme(theme),
        minimumContrastRatio: theme === 'light' ? 4.5 : 1
      })

      const fitAddon = new FitAddon()
      // const webLinksAddon = new WebLinksAddon() // Disabled - causes persistent underlines
      const serializeAddon = new SerializeAddon()
      const searchAddon = new SearchAddon()

      terminal.loadAddon(fitAddon)
      // terminal.loadAddon(webLinksAddon) // Disabled - causes persistent underlines
      terminal.loadAddon(serializeAddon)
      terminal.loadAddon(searchAddon)

      // WebGL addon DISABLED - renders underlines directly to canvas, bypassing CSS override
      // Canvas 2D renderer uses DOM elements that respect our .xterm-underline-* CSS fix
      // try {
      //   const webglAddon = new WebglAddon()
      //   webglAddon.onContextLoss(() => {
      //     webglAddon.dispose()
      //   })
      //   terminal.loadAddon(webglAddon)
      // } catch {
      //   // WebGL not available, continue with canvas renderer
      // }

      terminalRef.current = terminal
      fitAddonRef.current = fitAddon
      serializeAddonRef.current = serializeAddon
      searchAddonRef.current = searchAddon

      terminal.open(containerRef.current)
      onAttachedRef.current?.({ focus: () => terminal.focus() })
      terminal.clear() // Ensure terminal starts completely fresh
      // Simple fit - container is guaranteed to have dimensions from waitForDimensions
      fitAddon.fit()

      // Let Ctrl+Tab and Ctrl+Shift+Tab bubble up for tab switching
      // Intercept Cmd+F / Ctrl+F for terminal search
      terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent)

      // Check if PTY already exists (e.g., from idle hibernation)
      const exists = await window.api.pty.exists(sessionId)
      if (signal.aborted) return // Don't continue if unmounted
      if (exists) {
        // Sync state from main process (fixes stuck loading spinner)
        const actualState = await window.api.pty.getState(sessionId)
        if (signal.aborted) return // Don't setState if unmounted
        if (actualState) setPtyState(actualState)

        // Restore from backend buffer (single source of truth)
        // Use getBufferSince with -1 to get all chunks
        const result = await window.api.pty.getBufferSince(sessionId, -1)
        if (result && result.chunks.length > 0) {
          terminal.write('\x1b[0m') // Reset ANSI state before buffer replay
          for (const chunk of result.chunks) {
            terminal.write(chunk.data)
          }
          terminal.write('\x1b[0m') // Reset ANSI state after buffer replay
          lastRenderedSeqRef.current = result.currentSeq
        }
      } else {

        // Generate conversation ID for AI modes (used as {id} in templates)
        let newConversationId = conversationId
        if (mode !== 'terminal' && !newConversationId && !existingConversationId) {
          newConversationId = crypto.randomUUID()
          onConversationCreatedRef.current?.(newConversationId)
        }

        // Create PTY — plain terminal mode doesn't use conversation IDs
        // Note: Don't pass initialPrompt - we'll inject it after terminal is ready
        const isAiMode = mode !== 'terminal'
        const effectiveConversationId = isAiMode ? newConversationId : undefined
        const effectiveExistingConversationId = isAiMode ? existingConversationId : undefined
        const result = await window.api.pty.create({
          sessionId, cwd,
          conversationId: effectiveConversationId,
          existingConversationId: effectiveExistingConversationId,
          mode, providerFlags, executionContext
        })
        if (!result.success) {
          const message = result.error || 'Failed to create terminal process'
          terminal.writeln(`\x1b[31mError: ${message}\x1b[0m`)
          setInitError(message)
          setPtyState('error')
          return
        }
      }

      // Handle terminal input - pass through to PTY
      terminal.onData((data) => {
        if (!hasCalledFirstInputRef.current) {
          hasCalledFirstInputRef.current = true
          onFirstInputRef.current?.()
        }
        window.api.pty.write(sessionId, data)
      })

      // Handle resize
      terminal.onResize(({ cols, rows }) => {
        window.api.pty.resize(sessionId, cols, rows)
      })

      // Initial resize
      const { cols, rows } = terminal
      window.api.pty.resize(sessionId, cols, rows)

      // Helper to inject text char-by-char
      const injectText = async (text: string): Promise<void> => {
        for (const char of text) {
          terminal.input(char)
          await new Promise(r => setTimeout(r, 1))
        }
      }

      // Expose API for programmatic input and focus
      onReadyRef.current?.({
        sendInput: injectText,
        write: (data) => window.api.pty.write(sessionId, data),
        focus: () => terminal.focus(),
        clearBuffer: clearBufferWithoutRestart
      })
      // Inject initial prompt if provided (after a delay for terminal to be ready)
      if (initialPrompt) {
        setTimeout(async () => {
          if (signal.aborted) return // Don't inject if unmounted
          try {
            // For plan mode, prefix with /plan
            const textToInject = initialPrompt
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
      if (!signal.aborted && didInit) {
        setIsInitializing(false)
      }
    }
  }, [sessionId, cwd, mode, conversationId, existingConversationId, initialPrompt, providerFlags, executionContext, resetTaskState, handleTerminalKeyEvent, clearBufferWithoutRestart])

  // Initialize terminal
  useEffect(() => {
    const controller = new AbortController()
    initTerminal(controller.signal)

    return () => {
      controller.abort()
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
      if (terminalRef.current && fitAddonRef.current && serializeAddonRef.current && searchAddonRef.current) {
        const element = terminalRef.current.element
        if (element && element.parentNode) {
          element.parentNode.removeChild(element)
          setTerminal(sessionId, {
            terminal: terminalRef.current,
            fitAddon: fitAddonRef.current,
            serializeAddon: serializeAddonRef.current,
            searchAddon: searchAddonRef.current,
            element,
            serializedState,
            mode
          })
        }
      }
      terminalRef.current = null
      fitAddonRef.current = null
      serializeAddonRef.current = null
      searchAddonRef.current = null
      initializedRef.current = false
    }
  }, [initTerminal, sessionId])

  // Subscribe to PTY events via context (survives view switches)
  useEffect(() => {
    const unsubData = subscribe(sessionId, (data, seq) => {
      const cutoff = clearedSeqRef.current
      if (cutoff !== null && seq <= cutoff) return
      if (terminalRef.current && isActiveRef.current) {
        terminalRef.current.write(data)
        lastRenderedSeqRef.current = seq
      }
    })

    const unsubExit = subscribeExit(sessionId, (exitCode) => {
      terminalRef.current?.writeln(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m`)
      // Capture crash output before cleanupTask deletes context state
      const raw = getCrashOutput(sessionId)
      // Clean up cached terminal and context state on exit
      disposeTerminal(sessionId)
      cleanupTask(sessionId)
      // Show dead overlay for AI modes
      setDeadExitCode(exitCode)
      if (raw) setDeadCrashOutput(raw)
    })

    const unsubSessionInvalid = subscribeSessionInvalid(sessionId, () => {
      onSessionInvalidRef.current?.()
    })

    const unsubAttention = subscribeAttention(sessionId, () => {
      // Hibernation disabled - caused sync loss when returning to tab
      // (terminalRef became null but nothing triggered reinit)
      // Memory tradeoff: ~5-20MB per inactive terminal, worth it for reliability
    })

    return () => {
      unsubData()
      unsubExit()
      unsubSessionInvalid()
      unsubAttention()
    }
  }, [sessionId, subscribe, subscribeExit, subscribeSessionInvalid, subscribeAttention, getCrashOutput, cleanupTask])

  // Replay missed PTY data when task becomes active
  useEffect(() => {
    if (!isActive || !terminalRef.current) return
    const replay = async () => {
      const missed = await window.api.pty.getBufferSince(sessionId, lastRenderedSeqRef.current)
      if (!missed || missed.chunks.length === 0) return
      for (const chunk of missed.chunks) {
        const cutoff = clearedSeqRef.current
        if (cutoff !== null && chunk.seq <= cutoff) continue
        terminalRef.current?.write(chunk.data)
        lastRenderedSeqRef.current = chunk.seq
      }
    }
    replay()
  }, [isActive, sessionId])


  // Subscribe to PTY state changes for loading indicator
  useEffect(() => {
    setPtyState(getState(sessionId))
    return subscribeState(sessionId, (newState) => setPtyState(newState))
  }, [sessionId, getState, subscribeState])

  // Sync terminal theme with app theme
  useEffect(() => {
    const xtermTheme = getTerminalTheme(theme)
    const contrastRatio = theme === 'light' ? 4.5 : 1
    if (terminalRef.current) {
      terminalRef.current.options.theme = xtermTheme
      terminalRef.current.options.minimumContrastRatio = contrastRatio
    }
    updateAllThemes(xtermTheme, contrastRatio)
    // Keep main process in sync so it can respond to OSC 10/11/12 color queries
    // synchronously (async renderer response arrives too late once readline is active).
    void window.api.pty.setTheme({
      foreground: xtermTheme.foreground ?? '#ffffff',
      background: xtermTheme.background ?? '#000000',
      cursor: xtermTheme.cursor ?? '#ffffff',
    })
  }, [theme])

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
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

      fitAddonRef.current?.fit()
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
  }, [initTerminal])

  // Update font size at runtime when setting changes
  useEffect(() => {
    const t = terminalRef.current
    if (!t) return
    t.options.fontSize = terminalFontSize
    fitAddonRef.current?.fit()
  }, [terminalFontSize])

  // Update font family at runtime
  useEffect(() => {
    const t = terminalRef.current
    if (!t) return
    t.options.fontFamily = terminalFontFamily
    fitAddonRef.current?.fit()
  }, [terminalFontFamily])

  // Update scrollback buffer at runtime
  useEffect(() => {
    const t = terminalRef.current
    if (!t) return
    t.options.scrollback = terminalScrollback
  }, [terminalScrollback])

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

    // Insert path into terminal (escape if has spaces)
    const insertPath = (path: string) => {
      const escaped = path.includes(' ') ? `"${path}"` : path
      window.api.pty.write(sessionId, escaped)
    }

    // Process a single file
    const processFile = async (file: File, mimeType?: string): Promise<string | null> => {
      const filePath = (file as File & { path?: string }).path
      if (filePath) {
        return filePath
      } else if (mimeType?.startsWith('image/') || file.type.startsWith('image/')) {
        // Image from clipboard (screenshot, browser copy) - save to temp
        const base64 = await fileToBase64(file)
        const result = await window.api.files.saveTempImage(base64, mimeType || file.type)
        if (result.success && result.path) {
          return result.path
        }
      }
      return null
    }

    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      const paths: string[] = []

      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (!file) continue

          e.preventDefault()
          const path = await processFile(file, item.type)
          if (path) paths.push(path)
        }
      }

      if (paths.length > 0) {
        insertPath(paths.join(' '))
      }
    }

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      const files = e.dataTransfer?.files
      if (!files?.length) return

      const paths: string[] = []
      for (const file of files) {
        const path = await processFile(file)
        if (path) paths.push(path)
      }

      if (paths.length > 0) {
        insertPath(paths.join(' '))
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(true)
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
    }

    container.addEventListener('paste', handlePaste)
    container.addEventListener('drop', handleDrop)
    container.addEventListener('dragover', handleDragOver)
    container.addEventListener('dragleave', handleDragLeave)

    return () => {
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('drop', handleDrop)
      container.removeEventListener('dragover', handleDragOver)
      container.removeEventListener('dragleave', handleDragLeave)
    }
  }, [sessionId])

  const isLoading = !initError && (isInitializing || ptyState === 'starting')

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    try { searchAddonRef.current?.clearDecorations() } catch { /* */ }
    terminalRef.current?.focus()
  }, [])

  const handleRetry = useCallback(() => {
    setDeadExitCode(null)
    setDeadCrashOutput(null)
    setDoctorResults(null)
    onRetry?.()
  }, [onRetry])

  const handleDoctor = useCallback(async () => {
    setDoctorLoading(true)
    setDoctorResults(null)
    try {
      const results = await window.api.pty.validate(mode)
      setDoctorResults(results)
    } catch {
      setDoctorResults([{ check: 'Validation', ok: false, detail: 'Failed to run checks' }])
    } finally {
      setDoctorLoading(false)
    }
  }, [mode])

  const showDeadOverlay = ptyState === 'dead' && !isInitializing && deadExitCode !== null && mode !== 'terminal'

  return (
    <div className="relative h-full w-full">
      {searchOpen && searchAddonRef.current && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current}
          onClose={handleSearchClose}
        />
      )}
      <div
        ref={containerRef}
        tabIndex={0}
        className={`h-full w-full bg-white dark:bg-[#0a0a0a] rounded-lg outline-none overflow-hidden transition-colors ${
          isDragOver ? 'ring-2 ring-blue-500/50 ring-inset' : ''
        }`}
        style={{ padding: '8px' }}
        onClick={() => terminalRef.current?.focus()}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-[#0a0a0a] z-10">
            <div className="flex items-center gap-2 text-neutral-500">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-sm">Starting terminal...</span>
            </div>
          </div>
        )}
        {initError && (
          <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-[#0a0a0a] z-10 p-4">
            <div className="text-red-400 text-sm text-center">Failed to start terminal: {initError}</div>
          </div>
        )}
        {showDeadOverlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white dark:bg-[#0a0a0a] z-10 p-6 gap-4 overflow-y-auto">
            {deadCrashOutput && (
              <pre className="text-xs text-neutral-500 dark:text-neutral-400 max-h-32 overflow-y-auto w-full max-w-lg bg-neutral-50 dark:bg-neutral-900 rounded p-3 font-mono whitespace-pre-wrap break-all">
                {stripAnsi(deadCrashOutput).split('\n').slice(-20).join('\n')}
              </pre>
            )}
            <p className="text-sm text-neutral-500">Process exited with code {deadExitCode}</p>
            <div className="flex gap-2">
              {onRetry && (
                <button
                  onClick={handleRetry}
                  className="px-3 py-1.5 text-sm rounded-md bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 transition-colors"
                >
                  Retry
                </button>
              )}
              <button
                onClick={() => void handleDoctor()}
                disabled={doctorLoading}
                className="px-3 py-1.5 text-sm rounded-md bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {doctorLoading
                  ? <><Loader2 className="size-3.5 animate-spin" />Checking…</>
                  : 'Doctor'
                }
              </button>
            </div>
            {doctorResults && (
              <div className="w-full max-w-sm space-y-2">
                {doctorResults.map((r) => (
                  <div
                    key={r.check}
                    className={`rounded-lg border p-3 space-y-1.5 ${r.ok ? 'border-green-500/20 bg-green-50/40 dark:bg-green-950/20' : 'border-red-500/20 bg-red-50/40 dark:bg-red-950/20'}`}
                  >
                    <div className="flex items-start gap-2">
                      {r.ok
                        ? <CheckCircle2 className="size-3.5 text-green-600 dark:text-green-400 shrink-0 mt-px" />
                        : <XCircle className="size-3.5 text-red-500 dark:text-red-400 shrink-0 mt-px" />
                      }
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-xs font-medium leading-none">{r.check}</p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">{r.detail}</p>
                      </div>
                    </div>
                    {!r.ok && r.fix && (
                      <div className="ml-5">
                        <code className="text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 rounded px-2 py-1 font-mono block">
                          {r.fix}
                        </code>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})
