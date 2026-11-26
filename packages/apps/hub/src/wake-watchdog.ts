/**
 * Notices that this machine woke from sleep: a timer meant to tick every
 * `intervalMs` sees the wall clock jump by more than `intervalMs + slackMs` between
 * two ticks (timers do not run while the machine sleeps; the wall clock does).
 *
 * The hub uses it to run the automation engine's missed cron triggers
 * (`runCatchup`). It replaces the desktop forwarding Electron's `powerMonitor
 * 'resume'` over the capability bridge (D4, task 557ebb72), which only a hub
 * supervised by a desktop ever got — a standalone hub on a laptop never caught up.
 *
 * The slack absorbs a busy event loop: a late tick is not a wake. The timer is
 * unref'd so it never holds the process open. A throwing handler is logged and the
 * watchdog keeps running.
 */
export function startWakeWatchdog(opts: {
  onWake: () => void
  intervalMs?: number
  slackMs?: number
  now?: () => number
}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000
  const slackMs = opts.slackMs ?? 60_000
  const now = opts.now ?? Date.now
  let last = now()
  const timer = setInterval(() => {
    const t = now()
    const gap = t - last
    last = t
    if (gap <= intervalMs + slackMs) return
    try {
      opts.onWake()
    } catch (err) {
      console.error('[wake-watchdog] wake handler failed:', err)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
