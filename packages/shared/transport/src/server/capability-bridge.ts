import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { EventEmitter } from 'node:events'
import { settingsEvents } from '@slayzone/settings/server'
import { router, publicProcedure } from './trpc'
import {
  getAppDeps,
  getMenuEvents,
  getPowerResumeEvents,
  type AppDeps,
  type MenuEventMap
} from './app-deps'

/**
 * Capability bridge — the host↔side-car seam for the slice-9 local cutover.
 *
 * After cutover the renderer talks to ONE server (the side-car), which serves
 * the full `appRouter`. Electron-only capabilities (browser-WCV, clipboard,
 * dialogs, backup, task-windows, floating-agent, native menus, …) can only run
 * in the Electron host. So the side-car's `AppDeps` become thin proxies that
 * forward each call to the host over THIS router, and host-originated events
 * stream back over the single `events` subscription.
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
 * round-trips the complex args (`sendInputEvent`, `createView` opts, bounds).
 */

/** Resolve a dotted `AppDeps` method path (one level of nesting supported). */
function resolveAppDepsMethod(path: string): (...args: unknown[]) => unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic dispatch over the AppDeps surface
  const deps = getAppDeps() as any
  const parts = path.split('.')
  if (parts.length === 1) {
    const fn = deps[parts[0]]
    if (typeof fn !== 'function') throw new Error(`capability-bridge: ${path} is not a function`)
    return fn.bind(deps)
  }
  if (parts.length === 2) {
    const obj = deps[parts[0]]
    const fn = obj?.[parts[1]]
    if (typeof fn !== 'function') throw new Error(`capability-bridge: ${path} is not a function`)
    return fn.bind(obj)
  }
  throw new Error(`capability-bridge: unsupported path "${path}"`)
}

/** Channels of host-originated events the side-car re-emits onto local buses. */
export type CapabilityEventChannel =
  | 'browser'
  | 'floatingAgent'
  | 'webview'
  | 'taskWindows'
  | 'menu'
  | 'power'
  | 'theme'

/** One host event, relayed verbatim. `args` are the emitter's listener args. */
export type CapabilityEventFrame = {
  channel: CapabilityEventChannel
  event: string
  args: unknown[]
}

// Event names per channel — kept here next to the bridge (TypedEmitter has no
// wildcard). Must match the events the `app.ts` / `menu.ts` subscriptions wrap.
const BROWSER_EVENTS = ['event', 'shortcut', 'focused', 'create-task-from-link'] as const
const FLOATING_EVENTS = ['state', 'session-changed', 'collapse-changed'] as const
const WEBVIEW_EVENTS = ['shortcut'] as const
const TASK_WINDOWS_EVENTS = [
  'list-changed',
  'primary-active-changed',
  'ownership-changed',
  'panels-released-on-close',
  'panels-close-request'
] as const
const MENU_EVENTS: Array<keyof MenuEventMap> = [
  'go-home',
  'toggle-global-agent-panel',
  'toggle-agent-status-panel',
  'open-settings',
  'open-project-settings',
  'new-temporary-task',
  'open-task',
  'close-task',
  'open-artifact',
  'screenshot-trigger',
  'close-current-focus',
  'close-active-task',
  'sync-session-id',
  'reload-browser',
  'reload-app',
  'zoom-factor-changed',
  'update-status',
  'browser-ensure-panel-open',
  'browser-create-tab',
  'browser-agent-touched'
]
const POWER_EVENTS = ['resume'] as const
// nativeTheme 'updated' (OS dark/light toggle) + explicit setTheme both emit
// 'theme:changed' on the host's settingsEvents; relayed so the side-car's
// `settings.onThemeChanged` subscription fires for the renderer.
const THEME_EVENTS = ['theme:changed'] as const

type AnyEmitter = AppDeps['browser']['events']

export const capabilityBridgeRouter = router({
  // Forward a single AppDeps method call to the host. Sync- and async-typed
  // AppDeps methods both `await` cleanly; the result is superjson-serialized.
  invoke: publicProcedure
    .input(z.object({ path: z.string(), args: z.array(z.unknown()) }))
    .mutation(async ({ input }) => {
      const fn = resolveAppDepsMethod(input.path)
      return await fn(...input.args)
    }),

  // One merged stream of every host-originated capability + menu + power event.
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

      wire('browser', deps.browser.events, BROWSER_EVENTS)
      wire('floatingAgent', deps.floatingAgent.events, FLOATING_EVENTS)
      wire('webview', deps.webview.events, WEBVIEW_EVENTS)
      wire('taskWindows', deps.taskWindows.events, TASK_WINDOWS_EVENTS)
      wire('menu', getMenuEvents(), MENU_EVENTS as readonly string[])
      wire('power', getPowerResumeEvents(), POWER_EVENTS)
      wire('theme', settingsEvents, THEME_EVENTS)

      return () => {
        for (const off of offs) off()
      }
    })
  )
})

export type CapabilityBridgeRouter = typeof capabilityBridgeRouter
