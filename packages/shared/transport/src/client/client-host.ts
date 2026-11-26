import { useEffect, useSyncExternalStore } from 'react'
import {
  createStorageClientHost,
  type ClientHostEvent,
  type ClientHostEvents,
  type ClientHostMethod,
  type ClientHostMethods,
  type ClientSettingsSnapshot,
  type ElectronClientHost,
  type ShortcutOverrideMap
} from '@slayzone/platform/client-host'
import { electronBootstrap } from './electron-bootstrap'
import { useStableCallback } from './useStableCallback'

/**
 * The typed client for THIS device's client host (`@slayzone/platform/client-host`):
 * theme mode, labs flags, shortcut overrides, app zoom, updates, and the native-menu
 * / accelerator events. Electron main over IPC on the desktop, the shell's own store
 * in the web and chromium shells — never a hub.
 *
 * Where the shell installed no host (unit tests, a partial host), an in-memory one
 * answers with the shells' defaults, so readers never branch on "is there a host".
 */
export interface ClientHost {
  call<K extends ClientHostMethod>(
    method: K,
    ...args: Parameters<ClientHostMethods[K]>
  ): Promise<Awaited<ReturnType<ClientHostMethods[K]>>>
  on<E extends ClientHostEvent>(
    event: E,
    listener: (payload: ClientHostEvents[E]) => void
  ): () => void
}

/** Events whose last value a later listener is given first. */
const STICKY = new Set<ClientHostEvent>(['update-status'])

let cached: { raw: ElectronClientHost; client: ClientHost } | null = null
let fallback: ElectronClientHost | null = null

/** Electron wraps a host error as "Error invoking remote method '…': Error: <message>". */
function withoutIpcPrefix(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  return new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''))
}

function memoryFallback(): ElectronClientHost {
  if (!fallback) {
    const data = new Map<string, string>()
    fallback = createStorageClientHost({
      kv: { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) },
      systemTheme: () =>
        typeof matchMedia === 'function' && !matchMedia('(prefers-color-scheme: dark)').matches
          ? 'light'
          : 'dark'
    })
  }
  return fallback
}

function wrap(raw: ElectronClientHost): ClientHost {
  const last = new Map<ClientHostEvent, unknown>()
  // One raw subscription for the whole renderer, so sticky values are seen even
  // before anyone listens to them.
  const listeners = new Set<(event: string, payload: unknown) => void>()
  let subscribed = false
  const ensureSubscribed = (): void => {
    if (subscribed) return
    subscribed = true
    raw.on((event, payload) => {
      if (STICKY.has(event as ClientHostEvent)) last.set(event as ClientHostEvent, payload)
      for (const l of [...listeners]) l(event, payload)
    })
  }
  return {
    call: (method, ...args) =>
      (
        raw.invoke(method, args) as Promise<Awaited<ReturnType<ClientHostMethods[typeof method]>>>
      ).catch((err: unknown) => {
        throw withoutIpcPrefix(err)
      }),
    on: (event, listener) => {
      ensureSubscribed()
      const l = (name: string, payload: unknown): void => {
        if (name === event) listener(payload as ClientHostEvents[typeof event])
      }
      listeners.add(l)
      if (last.has(event)) listener(last.get(event) as ClientHostEvents[typeof event])
      return () => {
        listeners.delete(l)
      }
    }
  }
}

export function getClientHost(): ClientHost {
  const raw = electronBootstrap.clientHost() ?? memoryFallback()
  if (cached?.raw === raw) return cached.client
  cached = { raw, client: wrap(raw) }
  return cached.client
}

/** Tests only: forget the cached host (a new `window.api` per test). */
export function __resetClientHostForTests(): void {
  cached = null
  fallback = null
  snapshot = null
  snapshotLoading = null
}

/**
 * Listen to one client-host event for the component's lifetime. The handler may
 * change between renders without re-subscribing; `enabled: false` pauses it.
 */
export function useClientHostEvent<E extends ClientHostEvent>(
  event: E,
  handler: (payload: ClientHostEvents[E]) => void,
  opts: { enabled?: boolean } = {}
): void {
  const enabled = opts.enabled !== false
  const stable = useStableCallback(handler)
  useEffect(() => {
    if (!enabled) return
    return getClientHost().on(event, stable)
  }, [event, enabled, stable])
}

// ── the settings snapshot, shared by every reader in this renderer ──────────────

let snapshot: ClientSettingsSnapshot | null = null
let snapshotLoading: Promise<ClientSettingsSnapshot> | null = null
const snapshotListeners = new Set<() => void>()
let snapshotWired: ClientHost | null = null

const setSnapshot = (next: ClientSettingsSnapshot): void => {
  snapshot = next
  for (const l of [...snapshotListeners]) l()
}

/** Read (once) and keep current this device's client settings. */
export function loadClientSettings(): Promise<ClientSettingsSnapshot> {
  const host = getClientHost()
  if (snapshotWired !== host) {
    snapshotWired = host
    host.on('settings-changed', setSnapshot)
    snapshotLoading = null
  }
  if (snapshot && snapshotLoading) return Promise.resolve(snapshot)
  snapshotLoading ??= host.call('settings.snapshot').then((s) => {
    setSnapshot(s)
    return s
  })
  return snapshotLoading
}

/** This device's theme / labs / shortcuts; null until the first read lands. */
export function useClientSettings(): ClientSettingsSnapshot | null {
  return useSyncExternalStore(
    (onChange) => {
      snapshotListeners.add(onChange)
      void loadClientSettings().catch(() => undefined)
      return () => {
        snapshotListeners.delete(onChange)
      }
    },
    () => snapshot,
    () => null
  )
}

// ── keyboard shortcuts (`@slayzone/ui`'s `ShortcutBackend`, structurally) ─────────

export interface ClientHostShortcutBackend {
  load: () => Promise<ShortcutOverrideMap | null>
  save: (overrides: ShortcutOverrideMap) => Promise<void>
  onChanged: (listener: (overrides: ShortcutOverrideMap) => void) => () => void
}

/**
 * The shortcut store's persistence on this device's client host (D1). `mirror`
 * copies each save to the default hub as best effort (older app versions on the
 * same hub, and a new device's one-time adoption, read it there); its failure is
 * logged, never surfaced. `ready` (the one-time adoption) is awaited before the
 * first load, so the store never shows the pre-adoption map.
 */
export function clientHostShortcutBackend(opts: {
  host?: ClientHost
  mirror?: (json: string) => Promise<unknown>
  ready?: Promise<unknown>
}): ClientHostShortcutBackend {
  const host = (): ClientHost => opts.host ?? getClientHost()
  return {
    load: async () => {
      await opts.ready?.catch(() => undefined)
      return (await host().call('settings.snapshot')).shortcuts
    },
    save: async (overrides) => {
      await host().call('shortcuts.set', overrides)
      if (opts.mirror) {
        opts.mirror(JSON.stringify(overrides)).catch((err: unknown) => {
          console.warn('[shortcuts] mirror to the hub failed:', err)
        })
      }
    },
    onChanged: (listener) => host().on('settings-changed', (s) => listener(s.shortcuts))
  }
}
