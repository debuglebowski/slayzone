// cap-shell-4 — inline task browser.
//
// Routes `window.api.browser.*` to `slayzone::embedded_tab::mojom::EmbeddedTabHost`
// on the browser side. The host owns one content::WebContents per view_id
// (LRU cap=10) and a single shared views::WebView overlay in
// SlayzoneShellContainer.
//
// Event-schema contract: the browser-side observer emits method names whose
// mapping to `onEvent({viewId, type, ...})` payload matches the Electron
// baseline in packages/domains/task-browser/src/client/useBrowserViewEvents.ts.
// Deviations here land immediately as "the view never becomes visible"
// because the renderer gates `hasLoadedRealPage` on `dom-ready` + real URL.
//
// Guards: intentionally no `knownViewIds.has(viewId)` drop on mutating calls.
// Races where the renderer uses a viewId the shim's local Set hasn't seen
// yet (initial createView resolution, HMR remount) are handled server-side:
// the C++ host LOG(WARNING)s and no-ops on unknown ids rather than the shim
// eating the call silently.

import type { ElectronAPI } from '@slayzone/types'
import type { EmbeddedTabObserverCallbackRouter } from '@slayzone/mojo-bindings'
import { embeddedTabRemote } from '../transport/mojo'

type BrowserNS = ElectronAPI['browser']
type EventPayload = Parameters<Parameters<BrowserNS['onEvent']>[0]>[0]
type CreateViewParams = Parameters<BrowserNS['createView']>[0]
type FocusedSub = Parameters<BrowserNS['onBrowserViewFocused']>[0]

const eventSubs = new Set<(evt: EventPayload) => void>()
const focusedSubs = new Set<FocusedSub>()
let observerReady: Promise<void> | null = null

// Shim-side view registry: tracks viewId → taskId for ids resolved through
// this renderer. Authoritative state still lives on the C++ host; the
// registry is only used to (a) fan out lifecycle/visibility helpers that
// the host doesn't expose readbacks for, and (b) synthesize per-id observer
// events around bulk operations. Drifts under HMR remounts / cross-renderer
// races — only correct for single-renderer smoke flows.
const viewRegistry = new Map<string, { taskId: string; wcId: number }>()
let lastFocusedViewId: string | null = null
let wcIdCounter = 0

function hasMojo(): boolean {
  return typeof globalThis !== 'undefined' && 'Mojo' in (globalThis as Record<string, unknown>)
}

// One observer pipe per renderer. Lazy-installed on the first mutating call
// so unloaded shells don't hold a pipe open. The router fans incoming events
// into every onEvent subscriber.
async function ensureObserver(): Promise<void> {
  if (observerReady) {
    await observerReady
    return
  }
  observerReady = (async () => {
    const m = await import('@slayzone/mojo-bindings')
    const remote = await embeddedTabRemote()
    const router: EmbeddedTabObserverCallbackRouter = new m.EmbeddedTabObserverCallbackRouter()

    router.onDidNavigate.addListener(
      (viewId: string, url: string, canGoBack: boolean, canGoForward: boolean) => {
        console.debug('[browser-shim] did-navigate', { viewId, url, canGoBack, canGoForward })
        fanOut({ viewId, type: 'did-navigate', url, canGoBack, canGoForward })
      },
    )
    router.onPageTitleUpdated.addListener((viewId: string, title: string) => {
      fanOut({ viewId, type: 'page-title-updated', title })
    })
    router.onDidStartLoading.addListener((viewId: string) => {
      fanOut({ viewId, type: 'did-start-loading' })
    })
    router.onDidStopLoading.addListener((viewId: string) => {
      fanOut({ viewId, type: 'did-stop-loading' })
    })
    router.onDomReady.addListener((viewId: string) => {
      console.debug('[browser-shim] dom-ready', { viewId })
      fanOut({ viewId, type: 'dom-ready' })
    })
    router.onDidFailLoad.addListener(
      (viewId: string, errorCode: number, errorDescription: string, url: string) => {
        console.debug('[browser-shim] did-fail-load', { viewId, errorCode, errorDescription, url })
        fanOut({ viewId, type: 'did-fail-load', errorCode, errorDescription, url })
      },
    )

    remote.subscribe(router.$.bindNewPipeAndPassRemote())
  })()
  await observerReady
}

function fanOut(evt: EventPayload): void {
  eventSubs.forEach((cb) => {
    try {
      cb(evt)
    } catch {
      // one bad subscriber doesn't break the others
    }
  })
}

// DF (2026-04-26) — CDP-route bridge for the lever-1 final fork-cap-deferred
// scripting host methods (ExecuteJs/InsertCss/RemoveCss/SetZoom). The
// chromium-shell test fixture exposes `__slayzoneCdpEvaluateOnEmbedded` —
// outside the test fixture (production renderers) the binding is absent and
// every helper below falls back to its previous noop, matching the stub
// behavior renderer code already tolerates. Single-view smoke caveat
// inherited from BM's `__slayzoneCdpEmbeddedTargets` route: the binding
// always operates on the first non-shell embedded target. ViewId is
// accepted by every helper for API parity with the future fork cap, but
// the binding does NOT consume it — multi-view callers need the
// viewId→targetId mapping that the deferred fork cap will add.
type CdpEvalResult = unknown | { error: string } | null
type CdpEvaluator = (expression: string) => Promise<CdpEvalResult>

function cdpEvaluator(): CdpEvaluator | null {
  const target = globalThis as unknown as {
    __slayzoneCdpEvaluateOnEmbedded?: (expression: string) => Promise<CdpEvalResult>
  }
  return typeof target.__slayzoneCdpEvaluateOnEmbedded === 'function'
    ? target.__slayzoneCdpEvaluateOnEmbedded
    : null
}

function isCdpError(v: CdpEvalResult): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in (v as Record<string, unknown>)
}

async function cdpEvaluate(expression: string): Promise<CdpEvalResult> {
  const ev = cdpEvaluator()
  if (!ev) return null
  const r = await ev(expression).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }))
  return r
}

async function createView(opts: CreateViewParams): Promise<string> {
  if (!hasMojo()) {
    console.debug('[browser-shim] createView — no Mojo transport, returning empty id')
    return ''
  }
  await ensureObserver()
  const remote = await embeddedTabRemote()
  const { viewId } = await remote.createView({
    taskId: opts.taskId,
    tabId: opts.tabId,
    url: opts.url || 'about:blank',
    bounds: {
      x: opts.bounds.x,
      y: opts.bounds.y,
      width: opts.bounds.width,
      height: opts.bounds.height,
    },
    visible: true,
    // Pooled-profile key for the task's identity (own Google login / 1Password).
    // Empty = the shell's default profile.
    profileKey: (opts as { profileKey?: string }).profileKey ?? '',
  })
  console.debug('[browser-shim] createView resolved', {
    taskId: opts.taskId,
    tabId: opts.tabId,
    viewId,
    url: opts.url,
  })
  // Shim-side synthesis of view-attached. The browser-side host has inserted
  // the entry by the time createView resolves, so this matches the semantic
  // "observer fires after entry insertion" without a new mojom round-trip.
  if (viewId) viewRegistry.set(viewId, { taskId: opts.taskId, wcId: ++wcIdCounter })
  fanOut({ viewId, type: 'view-attached', taskId: opts.taskId, tabId: opts.tabId })
  return viewId
}

async function destroyView(viewId: string): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.destroyView(viewId)
  viewRegistry.delete(viewId)
  if (lastFocusedViewId === viewId) lastFocusedViewId = null
  fanOut({ viewId, type: 'view-detached' })
}

async function destroyAllForTask(taskId: string): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.destroyAllForTask(taskId)
  // Synthesize view-detached per registry entry. Host removed them already
  // by the time the RPC was sent; we just publish the per-id observer fan-
  // out the renderer expects.
  const victims: string[] = []
  for (const [id, meta] of viewRegistry) if (meta.taskId === taskId) victims.push(id)
  for (const id of victims) {
    viewRegistry.delete(id)
    if (lastFocusedViewId === id) lastFocusedViewId = null
    fanOut({ viewId: id, type: 'view-detached' })
  }
}

async function setBounds(
  viewId: string,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.setBounds(viewId, bounds)
}

async function setVisible(viewId: string, visible: boolean): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.setVisible(viewId, visible)
}

// Extensions inlay-modal helpers. The window itself is opened via createView
// with url "slayzone:open-extensions"; these keep the chromeless child window
// pinned under the React modal card (on move/resize) and tear it down on close.
async function setExtensionsBounds(bounds: {
  x: number
  y: number
  width: number
  height: number
}): Promise<void> {
  if (!hasMojo()) return
  const remote = await embeddedTabRemote()
  remote.setExtensionsBounds(bounds)
}

async function closeExtensions(): Promise<void> {
  if (!hasMojo()) return
  const remote = await embeddedTabRemote()
  remote.closeExtensions()
}

// SlayZone extension bar: list the modal identity's installed extensions, and
// open one's options/settings page in the open inlay.
async function listExtensions(profileKey: string): Promise<
  Array<{ id: string; name: string; enabled: boolean; hasOptions: boolean }>
> {
  if (!hasMojo()) return []
  const remote = await embeddedTabRemote()
  const { extensions } = await remote.listExtensions(profileKey)
  return extensions
}

async function openExtensionOptions(extensionId: string): Promise<void> {
  if (!hasMojo()) return
  const remote = await embeddedTabRemote()
  remote.openExtensionOptions(extensionId)
}

async function openExtensionPopup(extensionId: string): Promise<void> {
  if (!hasMojo()) return
  const remote = await embeddedTabRemote()
  remote.openExtensionPopup(extensionId)
}

async function navigate(viewId: string, url: string): Promise<void> {
  console.debug('[browser-shim] navigate', { viewId, url })
  const remote = await embeddedTabRemote()
  remote.navigate(viewId, url)
}

async function goBack(viewId: string): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.goBack(viewId)
}

async function goForward(viewId: string): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.goForward(viewId)
}

async function reload(viewId: string, ignoreCache?: boolean): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.reload(viewId, Boolean(ignoreCache))
}

async function stop(viewId: string): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.stop(viewId)
}

async function focus(viewId: string): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.focus(viewId)
  // Shim-side synthesis of focus observer events. Real WebContentsObserver
  // focus signals require the still-deferred fork cap; until then, the
  // only focus transitions we observe in tests are the ones driven through
  // this RPC, and those we can publish ourselves. The host has already
  // accepted the focus call by the time we return, so the event ordering
  // matches a server-side observer fire for single-renderer flows.
  const prev = lastFocusedViewId
  if (prev && prev !== viewId) {
    fanOut({ viewId: prev, type: 'view-blurred' })
  }
  lastFocusedViewId = viewId
  fanOut({ viewId, type: 'view-focused' })
  focusedSubs.forEach((cb) => {
    try { cb({ viewId }) } catch { /* one bad subscriber doesn't break others */ }
  })
}

async function openDevTools(
  viewId: string,
  _mode: 'bottom' | 'right' | 'undocked' | 'detach',
): Promise<void> {
  const remote = await embeddedTabRemote()
  // Mojom covers toggle only; the renderer calls open+close pairs around the
  // same viewId so toggle stays balanced in practice.
  remote.toggleDevtools(viewId)
}

async function closeDevTools(viewId: string): Promise<void> {
  const remote = await embeddedTabRemote()
  remote.toggleDevtools(viewId)
}

async function isDevToolsOpen(_viewId: string): Promise<boolean> {
  // No mojom readback; renderer tolerates best-effort.
  return false
}

function onEvent(cb: (event: EventPayload) => void): () => void {
  void ensureObserver()
  eventSubs.add(cb)
  return () => {
    eventSubs.delete(cb)
  }
}

const noopUnsub = (): void => undefined
const noopSub = (): (() => void) => noopUnsub

// STUB list (renderer surface that isn't covered by this cap; safe noops so
// mount paths don't throw): setHandoffPolicy/executeJs/insertCss/removeCss/
// setZoom/findInPage/stopFindInPage/setKeyboardPassthrough/sendInputEvent/
// onBrowserViewShortcut/onCreateTaskFromLink/extensions surfaces.
// Registry-backed synthesis (AD batch 3): getWebContentsId/getPartition/
// getAllViewIds/getViewsForTask/getNativeChildViewCount/isFocused.
export const browserShim = {
  createView,
  destroyView,
  destroyAllForTask,

  setBounds,
  setVisible,
  setExtensionsBounds,
  closeExtensions,
  listExtensions,
  openExtensionOptions,
  openExtensionPopup,
  hideAll: async (): Promise<void> => {
    // Shim-side fan-out over registered viewIds. Host has no bulk-visibility
    // method on the current mojom — the renderer expects per-id transitions
    // observable through the existing setVisible path. Per-id `view-hidden`
    // events let smoke specs verify the fan-out hit every entry.
    for (const id of Array.from(viewRegistry.keys())) {
      const remote = await embeddedTabRemote()
      remote.setVisible(id, false)
      fanOut({ viewId: id, type: 'view-hidden' })
    }
  },
  showAll: async (): Promise<void> => {
    for (const id of Array.from(viewRegistry.keys())) {
      const remote = await embeddedTabRemote()
      remote.setVisible(id, true)
      fanOut({ viewId: id, type: 'view-shown' })
    }
  },
  setHandoffPolicy: async (): Promise<void> => undefined,

  navigate,
  goBack,
  goForward,
  reload,
  stop,

  // DF — CDP-route bridge. ViewId is accepted for API parity but the
  // underlying binding always targets the first non-shell embedded view.
  // Falls back to `undefined` (matching the prior noop) when the binding is
  // absent or any error surfaces.
  executeJs: async (_viewId: string, code: string): Promise<unknown> => {
    // Wrap in IIFE so callers passing a multi-statement body whose last line
    // produces the value still get a return through Runtime.evaluate.
    const expr = `(function(){ return (function(){ ${code} })(); })()`
    const r = await cdpEvaluate(expr)
    if (r === null || isCdpError(r)) return undefined
    return r
  },
  insertCss: async (_viewId: string, css: string): Promise<string> => {
    const key = 'slay-css-' + Math.random().toString(36).slice(2, 10)
    const expr =
      '(function(){' +
      `var s=document.createElement('style');s.id=${JSON.stringify(key)};` +
      `s.textContent=${JSON.stringify(css)};` +
      'document.head.appendChild(s);return s.id;})()'
    const r = await cdpEvaluate(expr)
    if (typeof r === 'string') return r
    return ''
  },
  removeCss: async (_viewId: string, key: string): Promise<void> => {
    const expr =
      '(function(){' +
      `var el=document.getElementById(${JSON.stringify(key)});` +
      'if(el)el.remove();return true;})()'
    await cdpEvaluate(expr)
  },
  setZoom: async (_viewId: string, factor: number): Promise<void> => {
    // CDP-only zoom approximation via CSS `zoom`. Equivalent visual effect
    // for smoke tests; the deferred fork cap's HostZoomMap path is the
    // production-correct implementation.
    const expr = `(function(){document.body.style.zoom=${Number(factor)};return document.body.style.zoom;})()`
    await cdpEvaluate(expr)
  },
  focus,
  findInPage: async (): Promise<number | null> => null,
  stopFindInPage: async (): Promise<void> => undefined,
  // Registry-backed synthesis. Monotonic wcId per viewId lets renderer code
  // treat different views as distinct wcIds without a mojom readback. Drift
  // caveat same as bulk ops / focus events — single-renderer authoritative.
  getWebContentsId: async (viewId: string): Promise<number | null> =>
    viewRegistry.get(viewId)?.wcId ?? null,
  // No partitions set today (see handoff doc). Empty string matches the fork
  // cap's planned return contract.
  getPartition: async (_viewId: string): Promise<string> => '',
  // Enumeration reads over the shim registry. Covers the read-only lifecycle
  // probes in 76-browser-view-lifecycle without a mojom readback. Drift
  // caveat same as bulk ops / focus events.
  getAllViewIds: async (): Promise<string[]> => Array.from(viewRegistry.keys()),
  getViewsForTask: async (taskId: string): Promise<string[]> => {
    const out: string[] = []
    for (const [id, meta] of viewRegistry) if (meta.taskId === taskId) out.push(id)
    return out
  },
  getNativeChildViewCount: async (): Promise<number> => viewRegistry.size,
  // Focus state readback. Only RPC-driven focus transitions are observable;
  // real user-driven focus (keyboard/click in the WebContents) still needs
  // the deferred WebContentsObserver glue. Consistent with focus events in
  // spec 129.
  isFocused: async (viewId: string): Promise<boolean> => lastFocusedViewId === viewId,
  setKeyboardPassthrough: async (): Promise<void> => undefined,
  sendInputEvent: async (): Promise<void> => undefined,

  onBrowserViewShortcut: noopSub,
  onBrowserViewFocused: (cb: FocusedSub): (() => void) => {
    focusedSubs.add(cb)
    return () => { focusedSubs.delete(cb) }
  },

  openDevTools,
  closeDevTools,
  isDevToolsOpen,

  getExtensions: async (): Promise<never[]> => [],
  loadExtension: async (): Promise<null> => null,
  removeExtension: async (): Promise<void> => undefined,
  discoverBrowserExtensions: async (): Promise<never[]> => [],
  importExtension: async (): Promise<{ error: string }> => ({ error: 'not supported' }),
  activateExtension: async (): Promise<boolean> => false,
  onCreateTaskFromLink: noopSub,

  onEvent,
} as unknown as BrowserNS
