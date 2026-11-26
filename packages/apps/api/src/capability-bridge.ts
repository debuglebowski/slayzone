import { z } from 'zod'
import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import { observable } from '@trpc/server/observable'
import { EventEmitter } from 'node:events'
import { getAppDeps, type AppDeps } from './app-deps'

/**
 * Capability bridge — the host↔side-car seam for the slice-9 local cutover.
 *
 * After cutover the renderer talks to ONE server (the side-car), which serves
 * the full `appRouter`. Electron-only capabilities (clipboard,
 * dialogs, backup, task-windows, floating-agent, native menus, …) can only run
 * in the Electron host. So the side-car's `AppDeps` become thin proxies that
 * forward each call to the host over THIS router, and host-originated events
 * stream back over the single `events` subscription.
 *
 * Native menu / accelerator / updater / zoom events, the theme mode and the wake
 * from sleep no longer cross it (task 557ebb72): the desktop's client host hands the
 * first three to its own renderers directly, and the hub detects its own wake.
 *
 * Why a generic `invoke({path,args})` instead of mirroring every `app.*`
 * procedure: `AppDeps` already encodes window scoping as plain method ARGS
 * (e.g. `windowClose(windowId)`, `taskWindows.claimPanel(taskId, panelId,
 * windowId)`) — the renderer-facing `app.ts` procedures read `ctx.windowId`
 * and pass it down as an argument. Forwarding at the `AppDeps` boundary carries
 * windowId for free and keeps a SINGLE contract (the `AppDeps` interface),
 * with zero router duplication to drift against `app.ts`.
 *
 * The host serves this router (real `getAppDeps()` impls); the side-car holds a
 * tRPC client to it (`createHostBridge`). superjson (the shared transformer)
 * round-trips the complex args.
 */

/** Resolve a dotted `AppDeps` method path (one level of nesting supported). */
function resolveAppDepsMethod(path: string): (...args: unknown[]) => unknown {
  // Dispatch is by string, so the typed AppDeps surface is unusable here; the
  // `typeof fn !== 'function'` guards below are what make the calls safe.
  type Bag = Record<string, unknown>
  type Method = (...args: unknown[]) => unknown
  const deps = getAppDeps() as unknown as Bag
  const parts = path.split('.')
  if (parts.length === 1) {
    const fn = deps[parts[0]] as Method | undefined
    if (typeof fn !== 'function') throw new Error(`capability-bridge: ${path} is not a function`)
    return fn.bind(deps)
  }
  if (parts.length === 2) {
    const obj = deps[parts[0]] as Bag | undefined
    const fn = obj?.[parts[1]] as Method | undefined
    if (typeof fn !== 'function') throw new Error(`capability-bridge: ${path} is not a function`)
    return fn.bind(obj)
  }
  throw new Error(`capability-bridge: unsupported path "${path}"`)
}

/** Channels of host-originated events the side-car re-emits onto local buses. */
export type CapabilityEventChannel = 'floatingAgent' | 'taskWindows'

/** One host event, relayed verbatim. `args` are the emitter's listener args. */
export type CapabilityEventFrame = {
  channel: CapabilityEventChannel
  event: string
  args: unknown[]
}

// Event names per channel — kept here next to the bridge (TypedEmitter has no
// wildcard). Must match the events the `app.*` subscriptions wrap.
const FLOATING_EVENTS = ['state', 'session-changed', 'collapse-changed'] as const
const TASK_WINDOWS_EVENTS = [
  'list-changed',
  'primary-active-changed',
  'ownership-changed',
  'panels-released-on-close',
  'panels-close-request'
] as const
type AnyEmitter = AppDeps['floatingAgent']['events']

/**
 * This router has its OWN tRPC instance with an EMPTY context, deliberately.
 *
 * Every procedure here resolves its implementation from the AppDeps registry and
 * ignores the context entirely — but it used to be built on the
 * shared `TrpcContext`, whose `db: SlayzoneDb` is required. That meant the
 * desktop had to hand a live database handle to `createContext` purely to
 * satisfy a type nothing read, and so the Electron host kept a connection to the
 * shared DB open for a router that never queries it.
 *
 * Nothing merges this into `appRouter` (it is mounted alone, on the desktop
 * bridge listener), so a separate instance costs nothing and makes "the bridge
 * has no database" true by construction rather than by discipline.
 */
const t = initTRPC.context<Record<string, never>>().create({ transformer: superjson })
const router = t.router
const publicProcedure = t.procedure

export const capabilityBridgeRouter = router({
  // Forward a single AppDeps method call to the host. Sync- and async-typed
  // AppDeps methods both `await` cleanly; the result is superjson-serialized.
  invoke: publicProcedure
    .input(z.object({ path: z.string(), args: z.array(z.unknown()) }))
    .mutation(async ({ input }) => {
      const fn = resolveAppDepsMethod(input.path)
      return await fn(...input.args)
    }),

  // One merged stream of every host-originated capability event.
  // The side-car routes each frame to the matching local emitter by `channel`.
  events: publicProcedure.subscription(() =>
    observable<CapabilityEventFrame>((emit) => {
      const deps = getAppDeps()
      const offs: Array<() => void> = []
      const wire = (
        channel: CapabilityEventChannel,
        emitter: AnyEmitter | EventEmitter,
        events: readonly string[]
      ): void => {
        for (const event of events) {
          const handler = (...args: unknown[]): void => emit.next({ channel, event, args })
          ;(emitter as EventEmitter).on(event, handler)
          offs.push(() => {
            ;(emitter as EventEmitter).off(event, handler)
          })
        }
      }

      wire('floatingAgent', deps.floatingAgent.events, FLOATING_EVENTS)
      wire('taskWindows', deps.taskWindows.events, TASK_WINDOWS_EVENTS)

      return () => {
        for (const off of offs) off()
      }
    })
  )
})

export type CapabilityBridgeRouter = typeof capabilityBridgeRouter
