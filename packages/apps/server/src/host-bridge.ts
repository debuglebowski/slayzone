import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { TypedEmitter } from '@slayzone/platform/events'
import { settingsEvents } from '@slayzone/settings/server'
import type {
  AppDeps,
  CapabilityBridgeRouter,
  CapabilityEventFrame,
  MenuEventMap,
  PowerResumeEventMap
} from '@slayzone/transport/server'

/**
 * Side-car → Electron-host capability bridge (slice 9 local cutover).
 *
 * When supervised by the Electron host, the renderer talks to THIS side-car
 * for everything, but Electron-only capabilities (browser-WCV, clipboard,
 * dialogs, backup, task-windows, floating-agent, native menus, …) can only run
 * in the host. So the side-car's `AppDeps` become forwarding proxies over the
 * host's `capabilityBridgeRouter`, and host-originated events stream back over
 * a single subscription and are re-emitted onto local buses that the side-car's
 * own `appRouter` subscriptions already wrap.
 *
 * windowId rides along as a plain method argument (the renderer-facing `app.ts`
 * procedures read `ctx.windowId` and pass it down) — no special handling here.
 */

export type HostBridge = {
  appDeps: AppDeps
  /** Host-forwarded native menu/accelerator events + side-car-local emits land here. */
  menuEvents: TypedEmitter<MenuEventMap>
  /** Host `powerMonitor 'resume'`, forwarded so the side-car engine runs catchup. */
  powerResume: TypedEmitter<PowerResumeEventMap>
  connect: () => void
  dispose: () => void
}

export function createHostBridge(url: string, opts: { getTrpcPort: () => number }): HostBridge {
  const wsClient = createWSClient({
    url,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket
  })
  const client = createTRPCClient<CapabilityBridgeRouter>({
    links: [wsLink({ client: wsClient, transformer: superjson })]
  })

  const invoke = (path: string, ...args: unknown[]): Promise<unknown> =>
    client.invoke.mutate({ path, args })

  // Local re-emit targets — the side-car appRouter subscriptions wrap these,
  // and the host's events stream feeds them (plus side-car-local menu emits).
  const browserEmitter = new EventEmitter()
  const floatingEmitter = new EventEmitter()
  const webviewEmitter = new EventEmitter()
  const taskWindowsEmitter = new EventEmitter()
  const menuEvents = new TypedEmitter<MenuEventMap>()
  const powerResume = new TypedEmitter<PowerResumeEventMap>()

  const emitterByChannel: Record<CapabilityEventFrame['channel'], EventEmitter> = {
    browser: browserEmitter,
    floatingAgent: floatingEmitter,
    webview: webviewEmitter,
    taskWindows: taskWindowsEmitter,
    menu: menuEvents,
    power: powerResume,
    // Re-emit host theme:changed onto THIS process's settingsEvents singleton —
    // the side-car's `settings.onThemeChanged` subscription wraps that instance.
    theme: settingsEvents
  }

  // Snapshot cache — `app.browser.onEvent` replays `getAllStateSnapshots()`
  // SYNCHRONOUSLY for late subscribers (the createView→loadURL WS-race fix), so
  // the proxy must return an array without awaiting. Primed on connect + after
  // every relayed browser event (coalesced), trailing live state by one
  // sub-ms loopback round-trip — a faithful mirror of the host's best-effort replay.
  let snapshotCache: unknown[] = []
  let refetching = false
  let refetchAgain = false
  const refreshSnapshots = (): void => {
    if (refetching) {
      refetchAgain = true
      return
    }
    refetching = true
    void invoke('browser.getAllStateSnapshots')
      .then((snaps) => {
        snapshotCache = Array.isArray(snaps) ? snaps : []
      })
      .catch(() => {
        /* host unreachable — keep the last good cache */
      })
      .finally(() => {
        refetching = false
        if (refetchAgain) {
          refetchAgain = false
          refreshSnapshots()
        }
      })
  }

  const makeNested = (
    prefix: string,
    emitter: EventEmitter,
    extra?: Record<string, () => unknown>
  ): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (typeof prop !== 'string') return undefined
          if (prop === 'events') return emitter
          if (extra && prop in extra) return extra[prop]
          return (...args: unknown[]) => invoke(`${prefix}.${prop}`, ...args)
        }
      }
    )

  const browserProxy = makeNested('browser', browserEmitter, {
    getAllStateSnapshots: () => snapshotCache
  })
  const floatingProxy = makeNested('floatingAgent', floatingEmitter)
  const webviewProxy = makeNested('webview', webviewEmitter)
  const taskWindowsProxy = makeNested('taskWindows', taskWindowsEmitter)
  // Eventless nested capability: forward every method as `credentialCipher.<m>`.
  // The side-car has no Electron safeStorage; the host holds the real cipher.
  const credentialCipherProxy = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined
        return (...args: unknown[]) => invoke(`credentialCipher.${prop}`, ...args)
      }
    }
  )

  const appDeps = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined
        switch (prop) {
          case 'browser':
            return browserProxy
          case 'floatingAgent':
            return floatingProxy
          case 'webview':
            return webviewProxy
          case 'taskWindows':
            return taskWindowsProxy
          case 'credentialCipher':
            return credentialCipherProxy
          // Self-referential: the renderer is connected to THIS side-car, so the
          // tRPC port it reports is the side-car's own bound port, not the host's.
          case 'appGetTrpcPort':
            return () => Promise.resolve(opts.getTrpcPort())
          default:
            return (...args: unknown[]) => invoke(prop, ...args)
        }
      }
    }
  ) as unknown as AppDeps

  let eventsSub: { unsubscribe: () => void } | null = null

  const connect = (): void => {
    refreshSnapshots()
    eventsSub = client.events.subscribe(undefined, {
      onData: (frame: CapabilityEventFrame) => {
        const emitter = emitterByChannel[frame.channel]
        if (!emitter) return
        emitter.emit(frame.event, ...frame.args)
        // A browser event may have shifted nav state — refresh the replay cache.
        if (frame.channel === 'browser') refreshSnapshots()
      },
      onError: () => {
        /* wsLink auto-reconnects + resubscribes; cache re-primes on next event */
      }
    })
  }

  const dispose = (): void => {
    try {
      eventsSub?.unsubscribe()
    } catch {
      /* ignore */
    }
    try {
      wsClient.close()
    } catch {
      /* ignore */
    }
  }

  return { appDeps, menuEvents, powerResume, connect, dispose }
}
