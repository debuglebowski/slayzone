import { getTrpcClient } from '@slayzone/transport/client'
import type { TelemetryTier, TelemetryEventName, TelemetryEventProps } from '../shared/types'

declare const __POSTHOG_API_KEY__: string
declare const __POSTHOG_HOST__: string
declare const __DEV__: boolean

const POSTHOG_KEY = typeof __POSTHOG_API_KEY__ !== 'undefined' ? __POSTHOG_API_KEY__ : ''
const POSTHOG_HOST = typeof __POSTHOG_HOST__ !== 'undefined' ? __POSTHOG_HOST__ : ''
const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : true
const ENABLED = !!(POSTHOG_KEY && POSTHOG_HOST)

const HEARTBEAT_INTERVAL = 10 * 60 * 1000 // 10 minutes
const ACTIVITY_THROTTLE = 1000 // 1 second

// Lazy-loaded posthog instance. The import() trigger is deferred until the
// first initTelemetry() call (which itself runs from a useEffect after first
// paint). Triggering at module top would still kick off chunk fetch + parse
// during boot — even though the Promise is fire-and-forget, the fetch
// competes with main-bundle parse for CPU + I/O on cold start.
let ph: typeof import('posthog-js').default | null = null
let phReady: Promise<typeof import('posthog-js').default | null> | null = null

function ensurePosthogLoading(): Promise<typeof import('posthog-js').default | null> | null {
  if (!ENABLED) return null
  if (!phReady) {
    phReady = import('posthog-js')
      .then((m) => {
        ph = m.default
        return m.default
      })
      .catch(() => null)
  }
  return phReady
}

let currentTier: TelemetryTier = 'anonymous'
let initialized = false
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastActive = 0
let lastActivityUpdate = 0
let accumulatedActiveMs = 0
let heartbeatActiveMs = 0
let activeStartTs: number | null = null
let isForeground = false

function isAppForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function beginActiveWindow(now = Date.now()): void {
  if (activeStartTs === null) {
    activeStartTs = now
  }
}

function closeActiveWindow(now = Date.now()): void {
  if (activeStartTs === null) return
  const delta = Math.max(0, now - activeStartTs)
  if (delta > 0) {
    accumulatedActiveMs += delta
    heartbeatActiveMs += delta
  }
  activeStartTs = null
}

function toActiveMinutes(activeMs: number): number {
  return Math.round((activeMs / 60000) * 100) / 100
}

function emitHeartbeatIfNeeded(now = Date.now()): void {
  closeActiveWindow(now)
  if (heartbeatActiveMs <= 0) return

  track('heartbeat', {
    active_ms: heartbeatActiveMs,
    active_minutes: toActiveMinutes(heartbeatActiveMs)
  })
  heartbeatActiveMs = 0

  if (isForeground && now - lastActive < HEARTBEAT_INTERVAL) {
    beginActiveWindow(now)
  }
}

function emitBackgrounded(reason: 'backgrounded' | 'shutdown'): void {
  if (accumulatedActiveMs <= 0) return

  track('app_backgrounded', {
    reason,
    active_ms: accumulatedActiveMs,
    active_minutes: toActiveMinutes(accumulatedActiveMs)
  })
  accumulatedActiveMs = 0
}

function onActivity(): void {
  if (!isForeground) return
  const now = Date.now()
  if (now - lastActivityUpdate > ACTIVITY_THROTTLE) {
    lastActive = now
    lastActivityUpdate = now
    beginActiveWindow(now)
  }
}

function onForegroundChange(): void {
  const now = Date.now()
  const nextForeground = isAppForeground()
  if (nextForeground === isForeground) return

  isForeground = nextForeground

  if (isForeground) {
    lastActive = now
    lastActivityUpdate = now
    beginActiveWindow(now)
    return
  }

  emitHeartbeatIfNeeded(now)
  emitBackgrounded('backgrounded')
}

export function startHeartbeat(): void {
  if (heartbeatTimer) return

  isForeground = isAppForeground()
  lastActive = Date.now()
  lastActivityUpdate = Date.now()
  if (isForeground) {
    beginActiveWindow(lastActive)
  }

  document.addEventListener('mousemove', onActivity, { passive: true })
  document.addEventListener('keydown', onActivity, { passive: true })
  document.addEventListener('mousedown', onActivity, { passive: true })
  document.addEventListener('scroll', onActivity, { passive: true })
  document.addEventListener('visibilitychange', onForegroundChange, { passive: true })
  window.addEventListener('focus', onForegroundChange)
  window.addEventListener('blur', onForegroundChange)

  // Foreground state IS the data being tracked; gating by visibility would
  // break active-window accounting (the heartbeat itself closes the window
  // when un-foregrounded).
  // eslint-disable-next-line no-restricted-syntax
  heartbeatTimer = setInterval(() => {
    const now = Date.now()
    if (!isForeground || now - lastActive >= HEARTBEAT_INTERVAL) {
      closeActiveWindow(now)
      return
    }

    emitHeartbeatIfNeeded(now)
  }, HEARTBEAT_INTERVAL)
}

export function stopHeartbeat(): void {
  const now = Date.now()
  emitHeartbeatIfNeeded(now)
  closeActiveWindow(now)
  emitBackgrounded('shutdown')

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  document.removeEventListener('mousemove', onActivity)
  document.removeEventListener('keydown', onActivity)
  document.removeEventListener('mousedown', onActivity)
  document.removeEventListener('scroll', onActivity)
  document.removeEventListener('visibilitychange', onForegroundChange)
  window.removeEventListener('focus', onForegroundChange)
  window.removeEventListener('blur', onForegroundChange)

  isForeground = false
  activeStartTs = null
  heartbeatActiveMs = 0
  accumulatedActiveMs = 0
}

export async function initTelemetry(tier: TelemetryTier): Promise<void> {
  if (!ENABLED) return

  const ready = ensurePosthogLoading()
  if (!ready) return

  const posthog = await ready
  if (!posthog) return

  if (initialized) {
    posthog.reset()
  }

  currentTier = tier

  const isOptedIn = tier === 'opted_in'

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    persistence: isOptedIn ? 'localStorage+cookie' : 'memory',
    person_profiles: 'identified_only',
    capture_pageview: false,
    autocapture: false,
    disable_session_recording: true,
    capture_exceptions: isOptedIn,
    ...(isOptedIn ? {} : { disable_persistence: true })
  })

  posthog.register({ environment: IS_DEV ? 'development' : 'production' })

  if (isOptedIn) {
    const storedId = localStorage.getItem('slayzone_telemetry_id')
    if (storedId) {
      posthog.identify(storedId)
    } else {
      const id = crypto.randomUUID()
      localStorage.setItem('slayzone_telemetry_id', id)
      posthog.identify(id)
    }
  }

  initialized = true
}

let ipcCleanup: (() => void) | null = null

export function startIpcTelemetryBridge(): void {
  if (ipcCleanup) return
  if (typeof window === 'undefined') return
  // Runs from TelemetryProvider's init effect — i.e. after a tRPC query has
  // already resolved — so the vanilla client is initialized. Guard defensively.
  try {
    const sub = getTrpcClient().telemetry.onIpcEvent.subscribe(undefined, {
      onData: ({ event, props }) => {
        if (!initialized || !ph) return
        ph.capture(event, props)
      }
    })
    ipcCleanup = () => sub.unsubscribe()
  } catch {
    // tRPC client not yet initialized — bridge stays off (no telemetry loss that
    // matters: pre-init IPC events predate posthog readiness anyway).
  }
}

export function stopIpcTelemetryBridge(): void {
  ipcCleanup?.()
  ipcCleanup = null
}

export function track<E extends TelemetryEventName>(
  event: E,
  ...args: TelemetryEventProps[E] extends Record<string, never> ? [] : [TelemetryEventProps[E]]
): void {
  if (!initialized || !ph) return
  ph.capture(event, args[0] as Record<string, unknown> | undefined)
}

export function trackShortcut(key: string): void {
  track('keyboard_shortcut_used', { key })
}

export function setTelemetryTier(tier: TelemetryTier): void {
  if (tier === currentTier) return

  if (tier === 'anonymous' && ph) {
    ph.reset()
    localStorage.removeItem('slayzone_telemetry_id')
  }

  void initTelemetry(tier)
}

export function getTelemetryTier(): TelemetryTier {
  return currentTier
}

export function shutdownTelemetry(): void {
  stopHeartbeat()
  if (initialized && ph) {
    ph.reset()
    initialized = false
  }
}

/** Returns the posthog instance once loaded, for PostHogProvider */
export async function getPosthogInstance(): Promise<typeof import('posthog-js').default | null> {
  const ready = ensurePosthogLoading()
  if (!ready) return null
  return ready
}
