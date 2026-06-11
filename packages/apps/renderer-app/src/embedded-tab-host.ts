// EmbeddedTabSurfaceHost — implements the layout framework's NativeSurfaceHost
// over the fork's window.api.browser.* (window-api-shim → mojo EmbeddedTabHost,
// already live in the prebuilt binary). One native browser view per tile.
//
// Also exposes navigation + per-tile state (url/title/canGoBack/...) for the
// Browser panel chrome. Falls back to inert behavior when window.api.browser
// is absent or the transport returns an empty viewId (e.g. plain-browser dev).
import type { NativeSurfaceHost, PlacedSurface, Rect } from '@slayzone/layout'

export interface TabState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  domReady: boolean
}

export interface EmbeddedTabHostApi extends NativeSurfaceHost {
  navigate(tileId: string, url: string): void
  goBack(tileId: string): void
  goForward(tileId: string): void
  reload(tileId: string): void
  getState(tileId: string): TabState
  /** Subscribe to per-tile state changes. Returns unsubscribe. */
  onState(tileId: string, cb: (state: TabState) => void): () => void
}

// Narrow structural view of window.api.browser — avoids depending on the full
// ElectronAPI type from the renderer-app stub.
interface BrowserApi {
  createView(opts: {
    taskId: string
    tabId: string
    url: string
    bounds: { x: number; y: number; width: number; height: number }
    profileKey?: string
  }): Promise<string>
  destroyView(viewId: string): Promise<void>
  setBounds(viewId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  setVisible(viewId: string, visible: boolean): Promise<void>
  navigate(viewId: string, url: string): Promise<void>
  goBack(viewId: string): Promise<void>
  goForward(viewId: string): Promise<void>
  reload(viewId: string, ignoreCache?: boolean): Promise<void>
  onEvent(cb: (evt: Record<string, unknown>) => void): () => void
  // Extensions inlay-modal surface (chromeless child window pinned under the
  // React modal card). Optional — absent on plain-browser dev.
  setExtensionsBounds?(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  closeExtensions?(): Promise<void>
}

type Box = { x: number; y: number; width: number; height: number }

// Extensions inlay modal. `openExtensionsModal` opens the chromeless child
// window (Web Store / chrome://extensions) on `profileKey`, pinned over `body`
// (the React modal's body rect, CSS px in the shell viewport).
// `setExtensionsModalBounds` re-pins on modal move/resize; `closeExtensionsModal`
// tears it down. All inert when window.api.browser is absent.
export function openExtensionsModal(
  body: Box,
  profileKey: string,
  view: 'store' | 'manage' = 'store'
): void {
  const api = browserApi()
  if (!api) return
  void api.createView({
    taskId: 'extensions',
    tabId: 'extensions',
    url: view === 'manage' ? 'slayzone:open-extensions#manage' : 'slayzone:open-extensions',
    bounds: body,
    profileKey
  })
}
export function setExtensionsModalBounds(body: Box): void {
  void browserApi()?.setExtensionsBounds?.(body)
}
export function closeExtensionsModal(): void {
  void browserApi()?.closeExtensions?.()
}

function browserApi(): BrowserApi | null {
  const api = (window as unknown as { api?: { browser?: BrowserApi } }).api
  return api?.browser ?? null
}

// Pooled-profile key applied to NEW pane views — the task's identity (own
// Google login / 1Password). '' = the shell's default profile. The shell's
// profile dropdown sets this; panes created afterwards open on that profile.
let currentProfileKey = ''
export function setEmbeddedProfileKey(key: string): void {
  currentProfileKey = key
}
export function getEmbeddedProfileKey(): string {
  return currentProfileKey
}

const DEFAULT_STATE: TabState = {
  url: '',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  domReady: false
}

interface Entry {
  viewId: string | null
  creating: Promise<string> | null
  lastRect: Rect | null
  visible: boolean
  destroyed: boolean
  state: TabState
  subs: Set<(s: TabState) => void>
}

function toBounds(rect: Rect): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.w),
    height: Math.round(rect.h)
  }
}

export function createEmbeddedTabHost(taskId: string, defaultUrl: string): EmbeddedTabHostApi {
  const entries = new Map<string, Entry>()
  const byViewId = new Map<string, string>() // viewId → tileId
  let eventsWired = false

  const entryFor = (tileId: string): Entry => {
    let e = entries.get(tileId)
    if (!e) {
      e = {
        viewId: null,
        creating: null,
        lastRect: null,
        visible: true,
        destroyed: false,
        state: { ...DEFAULT_STATE, url: defaultUrl },
        subs: new Set()
      }
      entries.set(tileId, e)
    }
    return e
  }

  const emit = (e: Entry): void => {
    e.subs.forEach((cb) => {
      try {
        cb(e.state)
      } catch {
        // one bad subscriber doesn't break the others
      }
    })
  }

  const wireEvents = (api: BrowserApi): void => {
    if (eventsWired) return
    eventsWired = true
    api.onEvent((evt) => {
      const viewId = evt.viewId as string | undefined
      if (!viewId) return
      const tileId = byViewId.get(viewId)
      if (!tileId) return
      const e = entries.get(tileId)
      if (!e) return
      switch (evt.type) {
        case 'did-navigate':
          e.state = {
            ...e.state,
            url: (evt.url as string) ?? e.state.url,
            canGoBack: Boolean(evt.canGoBack),
            canGoForward: Boolean(evt.canGoForward)
          }
          break
        case 'page-title-updated':
          e.state = { ...e.state, title: (evt.title as string) ?? '' }
          break
        case 'did-start-loading':
          e.state = { ...e.state, isLoading: true }
          break
        case 'did-stop-loading':
          e.state = { ...e.state, isLoading: false }
          break
        case 'dom-ready':
          e.state = { ...e.state, domReady: true }
          break
        default:
          return
      }
      emit(e)
    })
  }

  const ensureView = (tileId: string, rect: Rect): void => {
    const api = browserApi()
    if (!api) return
    wireEvents(api)
    const e = entryFor(tileId)
    if (e.destroyed) return
    if (e.viewId) {
      void api.setBounds(e.viewId, toBounds(rect))
      return
    }
    e.lastRect = rect
    if (e.creating) return
    e.creating = api
      .createView({ taskId, tabId: tileId, url: e.state.url, bounds: toBounds(rect), profileKey: currentProfileKey })
      .then((viewId) => {
        e.creating = null
        if (!viewId) return '' // transport absent — stay inert
        if (e.destroyed) {
          void api.destroyView(viewId)
          return viewId
        }
        e.viewId = viewId
        byViewId.set(viewId, tileId)
        if (e.lastRect) void api.setBounds(viewId, toBounds(e.lastRect))
        if (!e.visible) void api.setVisible(viewId, false)
        return viewId
      })
  }

  return {
    place(surface: PlacedSurface): void {
      const e = entryFor(surface.tileId)
      e.lastRect = surface.rect
      ensureView(surface.tileId, surface.rect)
    },
    setVisible(tileId: string, visible: boolean): void {
      const e = entryFor(tileId)
      e.visible = visible
      const api = browserApi()
      if (api && e.viewId) void api.setVisible(e.viewId, visible)
    },
    remove(tileId: string): void {
      const e = entries.get(tileId)
      if (!e) return
      e.destroyed = true
      const api = browserApi()
      if (api && e.viewId) {
        byViewId.delete(e.viewId)
        void api.destroyView(e.viewId)
      }
      entries.delete(tileId)
    },
    navigate(tileId: string, url: string): void {
      const e = entryFor(tileId)
      e.state = { ...e.state, url, domReady: false }
      emit(e)
      const api = browserApi()
      if (api && e.viewId) void api.navigate(e.viewId, url)
    },
    goBack(tileId: string): void {
      const e = entries.get(tileId)
      const api = browserApi()
      if (api && e?.viewId) void api.goBack(e.viewId)
    },
    goForward(tileId: string): void {
      const e = entries.get(tileId)
      const api = browserApi()
      if (api && e?.viewId) void api.goForward(e.viewId)
    },
    reload(tileId: string): void {
      const e = entries.get(tileId)
      const api = browserApi()
      if (api && e?.viewId) void api.reload(e.viewId)
    },
    getState(tileId: string): TabState {
      return entryFor(tileId).state
    },
    onState(tileId: string, cb: (state: TabState) => void): () => void {
      const e = entryFor(tileId)
      e.subs.add(cb)
      return () => e.subs.delete(cb)
    }
  }
}
