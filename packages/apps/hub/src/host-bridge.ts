import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { TypedEmitter } from '@slayzone/platform/events'
import { settingsEvents } from '@slayzone/settings/server'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
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

/** Bridged `AppDeps` members that open, reveal, probe or install on the host machine. */
const HOST_LOCAL_EXEC = new Set([
  'shellOpenExternal',
  'shellOpenPath',
  'shellShowItemInFolder',
  'filesPathExists',
  'appInstallCli'
])

export function createHostBridge(
  url: string,
  opts: { getTrpcPort: () => number; token?: string | null }
): HostBridge {
  // The desktop's `/cap` listener rejects the WS upgrade itself without this —
  // loopback alone is not trusted there (see desktop-bridge-server.ts). Appended
  // as a query param (not `connectionParams`) because the gate runs at
  // `verifyClient`, before any tRPC message — and before this client's context
  // creation on the OTHER side even exists to read one.
  const bridgeUrl = opts.token ? `${url}?token=${encodeURIComponent(opts.token)}` : url
  const wsClient = createWSClient({
    url: bridgeUrl,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    // Every (re)open: browser events were lost while the socket was down.
    onOpen: () => refreshSnapshots()
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

  // Replay cache — `app.browser.onEvent` replays `getAllStateSnapshots()`
  // SYNCHRONOUSLY to every new subscriber (the createView→loadURL WS-race fix),
  // so the proxy must answer without awaiting. Each browser tab subscribes on its
  // own, so a tab that subscribes right after a relayed dom-ready/did-stop-loading
  // has missed that event and is healed ONLY by this replay — the cache must
  // never trail the events already relayed. It used to be re-fetched async after
  // each event (one desktop round trip behind), so such a tab was replayed
  // "loading" and stranded its loading overlay for good.
  //
  // Now it moves in lockstep with the stream: the desktop stamps every browser
  // nav event with that view's state as the event fires
  // (`CapabilityEventFrame.snapshot`), applied below in the same tick, before
  // the event is re-emitted. A full fetch still primes it on every (re)connect —
  // events are lost while the socket is down — and its result is re-emitted to
  // live subscribers so they converge too. A view a relayed event touched while
  // that fetch was in flight keeps the event's state (at least as new as the
  // fetch's: both ride one socket, in order).
  const snapshotCache = new Map<string, unknown>()
  let touchedDuringFetch: Set<string> | null = null
  let fetching = false
  let fetchAgain = false
  const viewIdOf = (x: unknown): string | null => {
    const viewId = (x as { viewId?: unknown } | null)?.viewId
    return typeof viewId === 'string' ? viewId : null
  }
  const refreshSnapshots = (): void => {
    if (fetching) {
      fetchAgain = true
      return
    }
    fetching = true
    const touched = new Set<string>()
    touchedDuringFetch = touched
    void invoke('browser.getAllStateSnapshots')
      .then((snaps) => {
        if (!Array.isArray(snaps)) return
        const live = new Set<string>()
        const fresh: unknown[] = []
        for (const s of snaps) {
          const viewId = viewIdOf(s)
          if (!viewId) continue
          live.add(viewId)
          if (touched.has(viewId)) continue
          snapshotCache.set(viewId, s)
          fresh.push(s)
        }
        for (const viewId of [...snapshotCache.keys()]) {
          if (!live.has(viewId) && !touched.has(viewId)) snapshotCache.delete(viewId)
        }
        // Heal live subscribers that missed events while the socket was down.
        // `state-snapshot` is the authoritative shape they already apply on replay.
        for (const s of fresh) browserEmitter.emit('event', s)
      })
      .catch(() => {
        /* host unreachable — keep the last good cache */
      })
      .finally(() => {
        if (touchedDuringFetch === touched) touchedDuringFetch = null
        fetching = false
        if (fetchAgain) {
          fetchAgain = false
          refreshSnapshots()
        }
      })
  }
  /** Apply a relayed browser nav event's own snapshot — before it is re-emitted. */
  const applyBrowserFrame = (frame: CapabilityEventFrame): void => {
    if (frame.channel !== 'browser' || frame.event !== 'event') return
    // No snapshot: the desktop could not read the view's state — re-read them all.
    if (!('snapshot' in frame)) return refreshSnapshots()
    const viewId = viewIdOf(frame.args[0])
    if (!viewId) return
    touchedDuringFetch?.add(viewId)
    if (frame.snapshot == null) snapshotCache.delete(viewId)
    else snapshotCache.set(viewId, frame.snapshot)
  }

  const makeNested = (
    prefix: string,
    emitter: EventEmitter,
    extra?: Record<string, (...args: never[]) => unknown>
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
    getAllStateSnapshots: () => [...snapshotCache.values()],
    // A destroyed view emits nothing more, so drop it here rather than replay it
    // to every later subscriber until the next (re)connect prime.
    destroyView: (viewId: string) => {
      snapshotCache.delete(viewId)
      return invoke('browser.destroyView', viewId)
    }
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

  // Eventless nested capability: the task/tab browser registry (distinct from
  // `browser`, the view-id-keyed manager). Forwards every method as
  // `browserTabs.<m>` so the REST browser routes can run HERE, against this
  // process's DB, instead of being reverse-proxied to the host wholesale.
  const browserTabsProxy = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined
        return (...args: unknown[]) => invoke(`browserTabs.${prop}`, ...args)
      }
    }
  )

  const appDeps = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined
        // Host capabilities that exec or probe on this machine (the desktop runs
        // them for us, but it is still the hub's machine): refused first on a hub
        // with processes switched off (T-06), exactly like the native ones.
        if (HOST_LOCAL_EXEC.has(prop)) {
          return (...args: unknown[]) => {
            assertHubLocalExecEnabled({ op: `host.${prop}` })
            return invoke(prop, ...args)
          }
        }
        switch (prop) {
          case 'browser':
            return browserProxy
          case 'browserTabs':
            return browserTabsProxy
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
        applyBrowserFrame(frame)
        emitter.emit(frame.event, ...frame.args)
      },
      onError: () => {
        /* wsLink auto-reconnects + resubscribes; `onOpen` re-primes the replay cache */
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
