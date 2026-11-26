import { z } from 'zod'
import type { TypedEmitter } from '@slayzone/platform/events'
import {
  CLIENT_HOST_EVENTS,
  CLIENT_HOST_METHODS,
  type ClientEventMap,
  type ClientHostEvent,
  type ClientHostMethod,
  type ClientHostMethods,
  type UpdateStatus
} from '@slayzone/platform/client-host'

/**
 * The client host over Electron IPC (ARCHITECTURE.md, "client-local host work"):
 * THIS device's renderers reach Electron main directly for what the device owns —
 * theme mode, labs flags, keyboard-shortcut overrides, app zoom, the updater — and
 * hear its native-menu / accelerator / updater events. Never through a hub: a hub
 * cannot answer for a device it does not run on, and a hub must not be able to
 * drive this device's menu actions.
 *
 * Two channels, mirrored by the preload's `window.api.clientHost`:
 *   `client-host:invoke` (method, args) → one `ClientHostMethods` call.
 *   `client-host:event`  (event, payload) ← pushed to every subscribed renderer; a
 *                        renderer subscribes once with `client-host:subscribe` and
 *                        first gets the last `update-status`, if any (an update that
 *                        finished downloading before the window subscribed still
 *                        shows its restart button).
 *
 * Senders are checked (`isAllowedSender`: the app's own windows and the floating
 * agent panel — never a browser-panel web view or an extension page), methods are
 * allowlisted and every input is validated.
 *
 * Electron-free (the ipc object is injected) so it is unit-tested directly.
 */

export type ClientHostImpl = {
  [K in ClientHostMethod]: (
    ...args: Parameters<ClientHostMethods[K]>
  ) => ReturnType<ClientHostMethods[K]> | Promise<ReturnType<ClientHostMethods[K]>>
}

export interface ClientHostSender {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, ...args: unknown[]) => void
  once: (event: 'destroyed', listener: () => void) => void
}

type IpcEvent<S> = { sender: S }

export interface ClientHostIpcDeps<S extends ClientHostSender> {
  ipc: {
    on: (channel: string, listener: (e: IpcEvent<S>, ...args: unknown[]) => void) => void
    handle: (channel: string, handler: (e: IpcEvent<S>, ...args: unknown[]) => unknown) => void
  }
  impl: ClientHostImpl
  /** Main's client event bus: native menu, accelerators, updater, zoom, deep links. */
  events: Pick<TypedEmitter<ClientEventMap>, 'on'>
  isAllowedSender: (sender: S) => boolean
  /** Registers `client-host:test-emit` (e2e drives the menu events through it). */
  isPlaywright: boolean
}

const theme = z.enum(['light', 'dark', 'system'])
const overrides = z.record(z.string(), z.string().nullable())

/** Each method's argument tuple. */
const ARGS: { [K in ClientHostMethod]: z.ZodType<Parameters<ClientHostMethods[K]>> } = {
  'settings.snapshot': z.tuple([]),
  'theme.set': z.tuple([theme]),
  'labs.set': z.tuple([z.enum(['testsPanel', 'loopMode']), z.boolean()]),
  'shortcuts.set': z.union([
    z.tuple([overrides]),
    z.tuple([
      overrides,
      z
        .object({ adoptedFromHub: z.boolean().optional(), localEdit: z.boolean().optional() })
        .optional()
    ])
  ]) as z.ZodType<Parameters<ClientHostMethods['shortcuts.set']>>,
  'zoom.get': z.tuple([]),
  'zoom.adjust': z.tuple([z.enum(['in', 'out', 'reset'])]),
  'update.restart': z.tuple([]),
  'update.check': z.tuple([])
}

const ALLOWED = new Set<string>(CLIENT_HOST_METHODS)

/** Events e2e may fire through `client-host:test-emit` (the bare menu signals and a
 *  deep-link open; not `settings-changed` / `update-status`, which carry state). */
const TEST_EMITTABLE = new Set<string>(
  CLIENT_HOST_EVENTS.filter((e) => e !== 'settings-changed' && e !== 'update-status')
)

export function registerClientHostIpc<S extends ClientHostSender>(
  deps: ClientHostIpcDeps<S>
): void {
  const subscribers = new Set<S>()
  let lastUpdateStatus: UpdateStatus | null = null

  const send = (event: ClientHostEvent, payload: unknown): void => {
    for (const wc of subscribers) {
      if (wc.isDestroyed()) {
        subscribers.delete(wc)
        continue
      }
      wc.send('client-host:event', event, payload)
    }
  }

  for (const event of CLIENT_HOST_EVENTS) {
    deps.events.on(event, ((payload?: unknown) => {
      if (event === 'update-status') lastUpdateStatus = payload as UpdateStatus
      send(event, payload)
    }) as never)
  }

  deps.ipc.on('client-host:subscribe', (e) => {
    const wc = e.sender
    if (!deps.isAllowedSender(wc) || subscribers.has(wc)) return
    subscribers.add(wc)
    wc.once('destroyed', () => subscribers.delete(wc))
    if (lastUpdateStatus) wc.send('client-host:event', 'update-status', lastUpdateStatus)
  })

  deps.ipc.handle('client-host:invoke', (e, method: unknown, args: unknown) => {
    if (!deps.isAllowedSender(e.sender)) throw new Error('client host: not an app renderer')
    if (typeof method !== 'string' || !ALLOWED.has(method)) {
      throw new Error(`client host: unknown method ${String(method)}`)
    }
    const m = method as ClientHostMethod
    const parsed = ARGS[m].safeParse(Array.isArray(args) ? args : [])
    if (!parsed.success) throw new Error(`client host: invalid arguments for ${m}`)
    const fn = deps.impl[m] as (...a: unknown[]) => unknown
    return fn(...(parsed.data as unknown[]))
  })

  if (deps.isPlaywright) {
    deps.ipc.handle('client-host:test-emit', (_e, event: unknown, payload: unknown) => {
      if (typeof event !== 'string' || !TEST_EMITTABLE.has(event)) {
        throw new Error(`client host: cannot test-emit ${String(event)}`)
      }
      send(event as ClientHostEvent, payload)
    })
  }
}
