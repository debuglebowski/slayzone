import type { ServerHandle, StartServerOpts } from '@slayzone/server'

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const
const HEALTHY_RESET_MS = 60_000

export interface SupervisorOpts {
  startServer: (opts: StartServerOpts) => Promise<ServerHandle>
  buildStartOpts: () => StartServerOpts
  onStarted?: (handle: ServerHandle) => void
  onPermanentFailure?: (info: { attempts: number; lastError: unknown }) => void
}

export interface SupervisorHandle {
  getHandle: () => ServerHandle | null
  stop: () => Promise<void>
}

export function startEmbeddedServerSupervised(opts: SupervisorOpts): SupervisorHandle {
  let attempt = 0
  let handle: ServerHandle | null = null
  let stopped = false
  let backoffTimer: NodeJS.Timeout | null = null
  let healthyTimer: NodeJS.Timeout | null = null

  const tryStart = (): void => {
    if (stopped) return
    opts.startServer(opts.buildStartOpts()).then((h) => {
      if (stopped) {
        // Raced: stop() was called while startServer was in flight. Tear down.
        void h.stop()
        return
      }
      handle = h
      opts.onStarted?.(h)
      // Reset attempt counter after a window of healthy uptime so transient
      // crashes hours apart don't trigger a false "permanently failed".
      healthyTimer = setTimeout(() => { attempt = 0 }, HEALTHY_RESET_MS)
    }).catch((err) => {
      if (stopped) return
      attempt += 1
      if (attempt >= BACKOFF_MS.length) {
        opts.onPermanentFailure?.({ attempts: attempt, lastError: err })
        return
      }
      const delay = BACKOFF_MS[attempt - 1]
      console.error(`[embedded-server] start failed (attempt ${attempt}/${BACKOFF_MS.length}); retry in ${delay}ms`, err)
      backoffTimer = setTimeout(tryStart, delay)
    })
  }

  tryStart()

  return {
    getHandle: () => handle,
    stop: async () => {
      stopped = true
      if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
      if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null }
      if (handle) {
        const h = handle
        handle = null
        try { await h.stop() } catch { /* ignore */ }
      }
    },
  }
}
