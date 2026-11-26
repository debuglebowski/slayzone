import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import type { AppDeps, CapabilityBridgeRouter, CapabilityEventFrame } from '@slayzone/api'

/**
 * Side-car → Electron-host capability bridge (slice 9 local cutover).
 *
 * When supervised by the Electron host, the renderer talks to THIS side-car
 * for everything, but Electron-only capabilities (clipboard,
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
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket
  })
  const client = createTRPCClient<CapabilityBridgeRouter>({
    links: [wsLink({ client: wsClient, transformer: superjson })]
  })

  const invoke = (path: string, ...args: unknown[]): Promise<unknown> =>
    client.invoke.mutate({ path, args })

  // Local re-emit targets — the side-car appRouter subscriptions wrap these,
  // and the host's events stream feeds them (plus side-car-local menu emits).
  const floatingEmitter = new EventEmitter()
  const taskWindowsEmitter = new EventEmitter()
  const emitterByChannel: Record<CapabilityEventFrame['channel'], EventEmitter> = {
    floatingAgent: floatingEmitter,
    taskWindows: taskWindowsEmitter
  }

  const makeNested = (prefix: string, emitter: EventEmitter): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (typeof prop !== 'string') return undefined
          if (prop === 'events') return emitter
          return (...args: unknown[]) => invoke(`${prefix}.${prop}`, ...args)
        }
      }
    )

  const floatingProxy = makeNested('floatingAgent', floatingEmitter)
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
          case 'floatingAgent':
            return floatingProxy
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
    eventsSub = client.events.subscribe(undefined, {
      onData: (frame: CapabilityEventFrame) => {
        const emitter = emitterByChannel[frame.channel]
        if (!emitter) return
        emitter.emit(frame.event, ...frame.args)
      },
      onError: () => {
        /* wsLink auto-reconnects + resubscribes */
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

  return { appDeps, connect, dispose }
}
