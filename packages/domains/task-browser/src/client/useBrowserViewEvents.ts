import { useState, useRef, useEffect } from 'react'
import { useSubscription, useTRPC } from '@slayzone/transport/client'

export interface LoadError {
  code: number
  description: string
  url: string
}

export interface BrowserViewState {
  url: string
  title: string
  favicon: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  error: LoadError | null
  domReady: boolean
  /** True once dom-ready has fired for a real page (not about:blank) */
  hasLoadedRealPage: boolean
}

type BrowserViewEvent = { viewId: string; type: string; [key: string]: unknown }

const INITIAL_STATE: BrowserViewState = {
  url: '',
  title: '',
  favicon: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  error: null,
  domReady: false,
  hasLoadedRealPage: false
}

export function useBrowserViewEvents(viewId: string | null): BrowserViewState {
  const trpc = useTRPC()
  const [state, setState] = useState<BrowserViewState>(INITIAL_STATE)
  const viewIdRef = useRef(viewId)
  viewIdRef.current = viewId

  // Reset to initial state when the view clears. Matches the old effect's
  // `if (!viewId) setState(INITIAL_STATE)` branch exactly — a non-null →
  // non-null viewId change intentionally carries state until new events arrive.
  useEffect(() => {
    if (!viewId) setState(INITIAL_STATE)
  }, [viewId])

  useSubscription(
    trpc.app.browser.onEvent.subscriptionOptions(undefined, {
      enabled: !!viewId,
      onData: (raw) => {
        const event = raw as BrowserViewEvent
        if (event.viewId !== viewIdRef.current) return

        switch (event.type) {
          // Authoritative nav-state replay from main, sent once per live view
          // when the subscription attaches. Heals events missed in the gap
          // between createView's loadURL and the WS subscription going live
          // (and after WS reconnects) — without it a fast page load strands
          // the loading overlay forever. domReady/hasLoadedRealPage are
          // sticky-OR'd to match their live-event semantics.
          case 'state-snapshot':
            setState((prev) => ({
              url: (event.url as string) || prev.url,
              title: (event.title as string) || prev.title,
              favicon: (event.favicon as string | null) ?? prev.favicon,
              canGoBack: event.canGoBack as boolean,
              canGoForward: event.canGoForward as boolean,
              isLoading: event.isLoading as boolean,
              error: event.error as LoadError | null,
              domReady: prev.domReady || (event.domReady as boolean),
              hasLoadedRealPage: prev.hasLoadedRealPage || (event.hasLoadedRealPage as boolean)
            }))
            break

          case 'did-navigate':
            setState((prev) => ({
              ...prev,
              url: event.url as string,
              canGoBack: event.canGoBack as boolean,
              canGoForward: event.canGoForward as boolean,
              error: null
            }))
            break

          case 'did-start-loading':
            setState((prev) => ({ ...prev, isLoading: true }))
            break

          case 'did-stop-loading':
            setState((prev) => ({ ...prev, isLoading: false }))
            break

          case 'page-title-updated':
            setState((prev) => ({ ...prev, title: event.title as string }))
            break

          case 'page-favicon-updated': {
            const favicons = event.favicons as string[] | undefined
            const favicon = favicons?.[0]
            if (favicon) {
              setState((prev) => ({ ...prev, favicon }))
            }
            break
          }

          case 'dom-ready':
            setState((prev) => ({
              ...prev,
              domReady: true,
              error: null,
              hasLoadedRealPage:
                prev.hasLoadedRealPage || (prev.url !== '' && prev.url !== 'about:blank')
            }))
            break

          case 'did-fail-load':
            setState((prev) => ({
              ...prev,
              isLoading: false,
              error: {
                code: event.errorCode as number,
                description: event.errorDescription as string,
                url: event.url as string
              }
            }))
            break

          case 'crashed':
            setState((prev) => ({
              ...prev,
              isLoading: false,
              error: { code: -1, description: 'Renderer process crashed', url: '' }
            }))
            break
        }
      }
    })
  )

  return state
}
