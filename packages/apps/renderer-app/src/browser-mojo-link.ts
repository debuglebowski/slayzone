// Chromium-fork browser bridge — a tRPC terminating link that resolves the
// canonical task-browser panel's `app.browser.*` operations against the fork's
// native mojo host (`window.api.browser.*`, installed by @slayzone/window-api-shim)
// instead of forwarding them over the WebSocket to the standalone sidecar (which
// fail-loud-stubs every `browser.*` capability — no Electron WebContentsView).
//
// Why a link and not a prop: the canonical BrowserPanel drives the native view by
// calling `trpcClient.app.browser.*` directly (no host/registry injection point).
// So the seam is the transport: this link short-circuits `app.browser.*` and lets
// everything else fall through to wsLink via `next(op)`. The canonical
// task-browser package stays 100% unmodified.
//
// The mapping is near 1:1: the `app.browser` tRPC router (packages/shared/
// transport/src/server/routers/app.ts) is `input → getAppDeps().browser.<m>(...args)`,
// and the shim object is typed AS that same `ElectronAPI['browser']` namespace, so
// the positional arg order matches. The shim implements only a subset at runtime
// (the rest are `as unknown as` type-only), so every call is optional-chained with a
// sensible fallback. Event shapes are already produced in the canonical
// onEvent contract by the shim (state-snapshot replay, did-navigate, dom-ready, …).
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '@slayzone/transport/client'

const PREFIX = 'app.browser.'

type AnyFn = (...args: unknown[]) => unknown
type BrowserHost = Record<string, AnyFn | undefined>

function browserHost(): BrowserHost | null {
  const api = (window as unknown as { api?: { browser?: BrowserHost } }).api
  return api?.browser ?? null
}

// Mirrors the `app.browser` router's `input → positional args` for queries +
// mutations. `?.` because the shim defines only a subset at runtime; fallbacks
// match the shim's own stub returns so read-only probes degrade, never throw.
/* eslint-disable @typescript-eslint/no-explicit-any -- bridge: tRPC inputs are anyInput-typed */
type Handler = (h: BrowserHost, i: any) => unknown
const PROCS: Record<string, Handler> = {
  createView: (h, i) => h.createView?.(i),
  destroyView: (h, i) => h.destroyView?.(i.viewId),
  destroyAllForTask: (h, i) => h.destroyAllForTask?.(i.taskId),
  setBounds: (h, i) => h.setBounds?.(i.viewId, i.bounds),
  setVisible: (h, i) => h.setVisible?.(i.viewId, i.visible),
  setLocked: (h, i) => h.setLocked?.(i.viewId, i.locked),
  hideAll: (h) => h.hideAll?.(),
  showAll: (h) => h.showAll?.(),
  setHandoffPolicy: (h, i) => h.setHandoffPolicy?.(i.viewId, i.policy),
  navigate: (h, i) => h.navigate?.(i.viewId, i.url),
  goBack: (h, i) => h.goBack?.(i.viewId),
  goForward: (h, i) => h.goForward?.(i.viewId),
  reload: (h, i) => h.reload?.(i.viewId, i.ignoreCache),
  stop: (h, i) => h.stop?.(i.viewId),
  executeJs: (h, i) => h.executeJs?.(i.viewId, i.code),
  insertCss: (h, i) => h.insertCss?.(i.viewId, i.css),
  removeCss: (h, i) => h.removeCss?.(i.viewId, i.key),
  setZoom: (h, i) => h.setZoom?.(i.viewId, i.factor),
  focus: (h, i) => h.focus?.(i.viewId),
  findInPage: (h, i) => h.findInPage?.(i.viewId, i.text, i.options) ?? null,
  stopFindInPage: (h, i) => h.stopFindInPage?.(i.viewId, i.action),
  setKeyboardPassthrough: (h, i) => h.setKeyboardPassthrough?.(i.viewId, i.enabled),
  sendInputEvent: (h, i) => h.sendInputEvent?.(i.viewId, i.input),
  openDevTools: (h, i) => h.openDevTools?.(i.viewId, i.mode),
  closeDevTools: (h, i) => h.closeDevTools?.(i.viewId),
  isDevToolsOpen: (h, i) => h.isDevToolsOpen?.(i.viewId) ?? false,
  getUrl: (h, i) => h.getUrl?.(i.viewId) ?? '',
  getBounds: (h, i) => h.getBounds?.(i.viewId) ?? null,
  getZoomFactor: (h, i) => h.getZoomFactor?.(i.viewId) ?? 1,
  getActualNativeBounds: (h, i) => h.getActualNativeBounds?.(i.viewId) ?? null,
  getViewVisible: (h, i) => h.getViewVisible?.(i.viewId) ?? true,
  getViewsForTask: (h, i) => h.getViewsForTask?.(i.taskId) ?? [],
  getAllViewIds: (h) => h.getAllViewIds?.() ?? [],
  listViews: (h) => h.listViews?.() ?? [],
  getNativeChildViewCount: (h) => h.getNativeChildViewCount?.() ?? 0,
  isAllHidden: (h) => h.isAllHidden?.() ?? false,
  isFocused: (h, i) => h.isFocused?.(i.viewId) ?? false,
  isViewNativelyVisible: (h, i) => h.isViewNativelyVisible?.(i.viewId) ?? true,
  getPartition: (h, i) => h.getPartition?.(i.viewId) ?? '',
  getWebContentsId: (h, i) => h.getWebContentsId?.(i.viewId) ?? null,
  activateExtension: (h, i) => h.activateExtension?.(i.extensionId) ?? false,
  getExtensions: (h) => h.getExtensions?.() ?? [],
  loadExtension: (h) => h.loadExtension?.() ?? null,
  removeExtension: (h, i) => h.removeExtension?.(i.extensionId),
  discoverBrowserExtensions: (h) => h.discoverBrowserExtensions?.() ?? [],
  importExtension: (h, i) => h.importExtension?.(i.extPath) ?? { error: 'not supported' },
  reparentToCurrentWindow: (h, i) => h.reparentToCurrentWindow?.(i.viewId)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// `app.browser.<routerName>` → shim subscription method. The router's stream
// names differ from the preload's (onShortcut/onFocused vs onBrowserView*).
const SUBS: Record<string, string> = {
  onEvent: 'onEvent',
  onShortcut: 'onBrowserViewShortcut',
  onFocused: 'onBrowserViewFocused',
  onCreateTaskFromLink: 'onCreateTaskFromLink'
}

// tRPC OperationResultEnvelope shapes the client unwraps (success → result.data;
// subscription → result.type started/data/stopped). Local minimal type avoids
// depending on tRPC's @internal export.
type Envelope =
  | { result: { data: unknown } }
  | { result: { type: 'started' } }
  | { result: { type: 'stopped' } }
  | { result: { type: 'data'; data: unknown } }

export function browserMojoLink(): TRPCLink<AppRouter> {
  const link =
    () =>
    (opts: { op: { type: string; path: string; input: unknown }; next: (op: unknown) => unknown }) => {
      const { op, next } = opts
      if (!op.path.startsWith(PREFIX)) return next(op) as never
      const method = op.path.slice(PREFIX.length)

      return observable<Envelope, TRPCClientError<AppRouter>>((observer) => {
        const host = browserHost()
        if (!host) {
          observer.error(
            TRPCClientError.from(new Error(`[browser-mojo-link] window.api.browser unavailable for ${op.path}`))
          )
          return
        }

        if (op.type === 'subscription') {
          const sub = SUBS[method] ? host[SUBS[method]] : undefined
          observer.next({ result: { type: 'started' } })
          if (typeof sub !== 'function') return // unknown stream: open, emits nothing
          let unsub: (() => void) | undefined
          try {
            unsub = sub((evt: unknown) => observer.next({ result: { type: 'data', data: evt } })) as () => void
          } catch (err) {
            observer.error(TRPCClientError.from(err as Error))
            return
          }
          return () => {
            try {
              unsub?.()
            } catch {
              /* best-effort teardown */
            }
          }
        }

        const handler = PROCS[method]
        if (!handler) {
          observer.error(TRPCClientError.from(new Error(`[browser-mojo-link] unmapped app.browser.${method}`)))
          return
        }
        Promise.resolve()
          .then(() => handler(host, op.input))
          .then((data) => {
            observer.next({ result: { data } })
            observer.complete()
          })
          .catch((err) => observer.error(TRPCClientError.from(err)))
        return
      })
    }
  return link as unknown as TRPCLink<AppRouter>
}
