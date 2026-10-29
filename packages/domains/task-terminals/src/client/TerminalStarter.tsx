import { useState, useEffect, forwardRef, useRef, useImperativeHandle } from 'react'
import { Play, Moon } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import {
  Terminal,
  type TerminalHandle,
  type TerminalProps
} from '@slayzone/terminal/client/LazyTerminal'
import { isSessionKnownUnspawned, markSkipCache } from '@slayzone/terminal/client'
import {
  agentStartsOnOpen,
  AGENT_STARTUP_SETTING,
  nextAgentStartupMode,
  parseAgentStartupMode,
  type AgentStartupMode,
  type AgentState
} from '@slayzone/terminal-contracts'
import { useTheme } from '@slayzone/ui'
import { getThemeTerminalColors, useVisibleInterval } from '@slayzone/ui'
import { MODE_ICONS } from './TerminalTabBar'
import { getModeLabel } from './get-tab-label'

// Sessions whose next TerminalStarter mount should skip the Start gate
// unconditionally. Explicit restart/reset kill the PTY then remount ~100ms
// later; the remount must respawn whatever the startup mode says about a
// `stopped` agent — and the kill's exit handler records `agent_state='stopped'`
// server-side, so without this the remount would land on "Open <mode>". Callers
// that just killed a PTY on purpose call `markForceStart` first so this mount
// starts regardless of the decision rule.
const forceStartSet = new Set<string>()
const forceStartTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

export function markForceStart(sessionId: string): void {
  const existing = forceStartTimeouts.get(sessionId)
  if (existing) clearTimeout(existing)
  forceStartSet.add(sessionId)
  // Safety net: if no remount consumes the flag (e.g. restart aborted), don't
  // leak it into an unrelated future mount.
  forceStartTimeouts.set(
    sessionId,
    setTimeout(() => {
      forceStartSet.delete(sessionId)
      forceStartTimeouts.delete(sessionId)
    }, 5000)
  )
}

// Mounted starters, by session, so an explicit start request (CLI `slay pty`
// cold-start → ensure-alive) reaches one already showing the Start gate.
const startListeners = new Map<string, () => void>()

/**
 * Start this session's agent now: an explicit request, so it wins over the
 * startup mode (a `manual` user who runs a CLI start still gets their agent). A
 * mounted starter starts at once; otherwise the next mount does.
 */
export function requestAgentStart(sessionId: string): void {
  const listener = startListeners.get(sessionId)
  if (listener) listener()
  else markForceStart(sessionId)
}

export interface TerminalStarterProps extends TerminalProps {
  /**
   * How this tab's agent last ended (`terminal_tabs.agent_state`). With the
   * `terminal_agent_startup` setting it decides, once per mount, whether the agent
   * starts or the Start gate shows (`agentStartsOnOpen`). `auto_stopped` (idle
   * timeout) shows the "Reopen … (resumes)" variant of the gate. Missing → `stopped`.
   */
  agentState?: AgentState
  /**
   * The owning task is temporary (ephemeral terminal tab). A temp task always
   * starts. Reattach to a live PTY also bypasses the gate.
   */
  isTemporary?: boolean
  /**
   * Hydration gate for an auto-start. `false` → the task's conversation id isn't
   * loaded yet (boot window, before parseAndColorTasks); hold the spawn so we
   * don't spawn with a null hint and clobber the real conversation.
   * `true`/`undefined` → spawn normally. Bounded by a 5s fallback so a task that
   * never hydrates still starts (main resolver is the backstop).
   */
  conversationHydrated?: boolean
}

// Lazy-spawn wrapper: hold off mounting <Terminal> (and thus PTY creation)
// until the startup mode or the user says to start. Reattach to an already-alive
// PTY skips the gate so multi-window / hibernation flows are unchanged. The
// decision is made once per mount ("when you open a task") — a later state change
// (the agent exits, the idle timeout closes it) must not restart it.
export const TerminalStarter = forwardRef<TerminalHandle, TerminalStarterProps>(
  function TerminalStarter(props, ref) {
    const {
      sessionId,
      mode = 'claude-code',
      agentState = 'stopped',
      isTemporary,
      conversationHydrated,
      ...terminalProps
    } = props
    // Task view on screen. `isActive` is also passed through to <Terminal>.
    const shown = terminalProps.isActive ?? true
    // Snapshot at mount: the decision is made once per mount ("when you open a
    // task"), so later prop changes must not re-run it.
    const [openState] = useState(() => ({ agentState, isTemporary: !!isTemporary }))
    // A pending explicit start (`requestAgentStart` / `markForceStart` — e.g. the
    // terminal-first pane handing over its running agent) mounts the terminal on
    // the FIRST render, so a live xterm is reattached without a blank frame. The
    // decision effect below still consumes the mark.
    const [started, setStarted] = useState(() => forceStartSet.has(sessionId))
    const [existsChecked, setExistsChecked] = useState(() => forceStartSet.has(sessionId))
    // Set when the decision is "start" but the spawn waits for hydration.
    const [startPending, setStartPending] = useState(false)
    // Set when the decision is "start once the task is shown": mounted off screen
    // (tab-bar restore on reload/restart) in a mode that only starts on a real open.
    const [startWhenShown, setStartWhenShown] = useState(false)
    const [dontShowAgain, setDontShowAgain] = useState(false)
    // Why the Start screen is showing: 'initial' (never started / stopped) vs
    // 'hibernated' (idle-close killed it). Drives copy + the "Don't show again"
    // checkbox semantics.
    const [reason, setReason] = useState<'initial' | 'hibernated'>('initial')
    // The startup mode read for this mount's decision; the "Don't show again"
    // checkbox steps it one notch more automatic.
    const [startupMode, setStartupMode] = useState<AgentStartupMode | null>(null)
    // Seconds left in the idle-close countdown (null = not counting down).
    const [countdown, setCountdown] = useState<number | null>(null)
    const innerRef = useRef<TerminalHandle | null>(null)
    // The Start gate's button stands in for the terminal until it starts: it is
    // what `focus()` focuses, and its mount is reported as the pane attaching —
    // so the container's focus handoff (tab activation, claims, typing guard)
    // decides when it takes focus, exactly as it does for a live terminal.
    const gateButtonRef = useRef<HTMLButtonElement | null>(null)
    const gateShown = existsChecked && !started
    const { onAttached } = terminalProps
    useEffect(() => {
      if (!gateShown) return
      onAttached?.({ sessionId, focus: () => gateButtonRef.current?.focus() })
      // An idle close swaps the gate in for a live terminal the user may have been
      // in; unmounting its xterm left focus nowhere, so Reopen inherits it.
      if (reason === 'hibernated' && shown && document.activeElement === document.body) {
        gateButtonRef.current?.focus()
      }
    }, [gateShown, sessionId, onAttached, reason, shown])
    const { terminalThemeId, contentVariant } = useTheme()
    const themeColors = getThemeTerminalColors(terminalThemeId, contentVariant)

    const trpc = useTRPC()
    const trpcClient = useTRPCClient()
    const ptyTouchMutation = useMutation(trpc.pty.touch.mutationOptions())
    const settingsSetMutation = useMutation(trpc.settings.set.mutationOptions())

    // Explicit start requests (`requestAgentStart`) for this mounted session.
    useEffect(() => {
      const start = (): void => {
        setReason('initial')
        setStartPending(false)
        setStartWhenShown(false)
        setStarted(true)
        setExistsChecked(true)
      }
      startListeners.set(sessionId, start)
      return () => {
        if (startListeners.get(sessionId) === start) startListeners.delete(sessionId)
      }
    }, [sessionId])

    useEffect(() => {
      let cancelled = false
      // Explicit restart/reset intent wins over everything else — see
      // `markForceStart`. Consume it so it only applies to this one mount.
      if (forceStartSet.has(sessionId)) {
        forceStartSet.delete(sessionId)
        setReason('initial')
        setStarted(true)
        setExistsChecked(true)
        return () => {
          cancelled = true
        }
      }
      // A temporary task always starts (`agentStartsOnOpen`), and a session this
      // renderer just created has no PTY to reattach to — nothing to ask the hub.
      if (openState.isTemporary && isSessionKnownUnspawned(sessionId)) {
        setStartPending(true)
        return () => {
          cancelled = true
        }
      }
      void Promise.all([
        trpcClient.pty.exists.query({ sessionId }),
        trpcClient.settings.get.query({ key: AGENT_STARTUP_SETTING })
      ]).then(([exists, rawMode]) => {
        if (cancelled) return
        const startup = parseAgentStartupMode(rawMode)
        setStartupMode(startup)
        // Reattaching to a live PTY always starts (nothing is spawned).
        if (exists) {
          setStarted(true)
          setExistsChecked(true)
          return
        }
        const rule = {
          mode: startup,
          state: openState.agentState,
          isTemporary: openState.isTemporary
        }
        if (agentStartsOnOpen({ ...rule, shown: false })) {
          // Spawns now, or once the conversation id hydrates (effect below).
          setStartPending(true)
        } else if (agentStartsOnOpen({ ...rule, shown: true })) {
          // Starts when the task is shown (effect below) — at once if it already is.
          setStartWhenShown(true)
        } else {
          // Persisted idle-close shows the "Reopen … (resumes)" screen — survives
          // reload/restart so a stale agent stays distinct from a stopped one.
          setReason(openState.agentState === 'auto_stopped' ? 'hibernated' : 'initial')
          setExistsChecked(true)
        }
      })
      return () => {
        cancelled = true
      }
    }, [sessionId, openState, trpcClient])

    // The agent was started elsewhere (another window, an agent tab claim) while
    // this one shows the gate: attach to it. Fires only on a transition INTO
    // `running`, and only when the PTY exists — so it never re-decides a start, and
    // never re-attaches to an agent the idle timeout is still killing (its state
    // is still `running` when the hibernated event swaps to the Reopen screen).
    const prevAgentStateRef = useRef(agentState)
    useEffect(() => {
      const prev = prevAgentStateRef.current
      prevAgentStateRef.current = agentState
      if (started || agentState !== 'running' || prev === 'running') return
      let cancelled = false
      void trpcClient.pty.exists.query({ sessionId }).then((exists) => {
        if (cancelled || !exists) return
        setReason('initial')
        setStartPending(false)
        setStarted(true)
        setExistsChecked(true)
      })
      return () => {
        cancelled = true
      }
    }, [agentState, started, sessionId, trpcClient])

    // Deferred open-start: the task is now on screen.
    useEffect(() => {
      if (!startWhenShown || !shown) return
      setStartWhenShown(false)
      setStartPending(true)
    }, [startWhenShown, shown])

    // Hydration gate for an auto-start: hold the spawn while the conversation id
    // is still un-hydrated (boot window). Spawning now would pass a null hint and,
    // if the main-side ledger resolver also misses, mint a fresh session that
    // clobbers the real conversation (the restart bug). Re-runs when
    // `conversationHydrated` flips true. Bounded by a 5s fallback so a
    // never-hydrating task still starts — the main resolver remains the backstop.
    useEffect(() => {
      if (!startPending) return
      const start = (): void => {
        setStartPending(false)
        setStarted(true)
        setExistsChecked(true)
      }
      if (conversationHydrated !== false) {
        start()
        return
      }
      const fallback = setTimeout(start, 5000)
      return () => clearTimeout(fallback)
    }, [startPending, conversationHydrated])

    // Idle-close (hibernation) signals from main. `warn` arms a visual
    // countdown; `cancelled` aborts it; `hibernated` means main killed the PTY
    // → swap to the Start screen (reopen resumes via conversation id). Server
    // fan-out is global; filter by sessionId in onData.
    useSubscription(
      trpc.pty.onHibernateWarn.subscriptionOptions(undefined, {
        onData: ({ sessionId: sid, graceSecs }) => {
          if (sid !== sessionId) return
          setCountdown(graceSecs)
        }
      })
    )
    useSubscription(
      trpc.pty.onHibernateCancelled.subscriptionOptions(undefined, {
        onData: ({ sessionId: sid }) => {
          if (sid !== sessionId) return
          setCountdown(null)
        }
      })
    )
    useSubscription(
      trpc.pty.onHibernated.subscriptionOptions(undefined, {
        onData: ({ sessionId: sid }) => {
          if (sid !== sessionId) return
          setCountdown(null)
          // Dispose (don't cache) the dead xterm so reopen builds a fresh one
          // showing the resumed session.
          markSkipCache(sessionId)
          setReason('hibernated')
          setExistsChecked(true)
          setStarted(false)
        }
      })
    )

    useVisibleInterval(
      () =>
        setCountdown((c) => {
          if (c === null) return null
          if (c <= 1) return 0
          return c - 1
        }),
      1000,
      { enabled: countdown !== null && countdown > 0 }
    )

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          if (innerRef.current) innerRef.current.focus()
          else gateButtonRef.current?.focus()
        },
        hasSelection: () => innerRef.current?.hasSelection() ?? false,
        getSelection: () => innerRef.current?.getSelection() ?? '',
        selectAll: () => innerRef.current?.selectAll(),
        scrollToBottom: () => innerRef.current?.scrollToBottom(),
        openSearch: () => innerRef.current?.openSearch(),
        clearBuffer: async () => {
          await innerRef.current?.clearBuffer()
        }
      }),
      []
    )

    const label = getModeLabel(mode)

    if (started) {
      const handleCancelCountdown = (): void => {
        setCountdown(null)
        ptyTouchMutation.mutate({ sessionId })
      }
      return (
        <div className="relative h-full w-full">
          <Terminal {...terminalProps} sessionId={sessionId} mode={mode} ref={innerRef} />
          {countdown !== null && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 whitespace-nowrap rounded-xl bg-orange-500/25 px-5 py-3 text-white shadow-lg ring-1 ring-orange-400/30 backdrop-blur-md">
              <Moon className="size-6 shrink-0 animate-pulse" />
              <span className="text-sm">
                Closing idle {label} in{' '}
                <span className="text-lg font-bold tabular-nums">{countdown}s</span>
              </span>
              <button
                type="button"
                onClick={handleCancelCountdown}
                className="ml-1 rounded-lg bg-white px-3.5 py-1.5 text-sm font-semibold text-black hover:bg-orange-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Keep open
              </button>
            </div>
          )}
        </div>
      )
    }

    if (!existsChecked) {
      return (
        <div
          className="h-full w-full"
          style={{ backgroundColor: themeColors.background ?? '#0a0a0a' }}
        />
      )
    }

    const Icon = MODE_ICONS[mode]
    const isHibernated = reason === 'hibernated'

    // The checkbox turns off whichever feature put us on this screen: idle-close
    // for the hibernated screen, otherwise one more notch of automatic startup.
    const nextStartupMode = nextAgentStartupMode(startupMode ?? 'manual')
    const handleStart = () => {
      if (dontShowAgain) {
        if (isHibernated)
          settingsSetMutation.mutate({ key: 'terminal_auto_close_idle', value: '0' })
        else settingsSetMutation.mutate({ key: AGENT_STARTUP_SETTING, value: nextStartupMode })
      }
      setReason('initial')
      setStarted(true)
    }

    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center gap-6 px-6"
        style={{ backgroundColor: themeColors.background ?? '#0a0a0a' }}
      >
        <div className="space-y-2 text-center max-w-md">
          <h2 className="text-2xl font-semibold text-foreground">
            {isHibernated ? `${label} closed to save memory` : `${label} is idle`}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isHibernated
              ? 'It sat idle, so it was closed. Reopen to resume the conversation.'
              : 'Saves CPU and API credits until you start it.'}
          </p>
        </div>
        <div className="flex flex-col items-center gap-3">
          <button
            ref={gateButtonRef}
            type="button"
            onClick={handleStart}
            className="flex items-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground hover:bg-surface-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {Icon ? <Icon className="size-4" /> : <Play className="size-4" />}
            {isHibernated ? `Reopen ${label}` : `Open ${label}`}
          </button>
          {/* The startup-mode checkbox is a no-op for temp tasks (they always start
              regardless) — hide it so the control never lies. Hibernation's
              checkbox is unrelated. */}
          {(isHibernated || !isTemporary) && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="cursor-pointer"
              />
              <span>
                {isHibernated
                  ? "Don't auto-close this agent"
                  : nextStartupMode === 'auto'
                    ? 'Start new and running agents automatically'
                    : 'Always start agents when a task opens'}
              </span>
            </label>
          )}
        </div>
      </div>
    )
  }
)
