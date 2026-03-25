import { useState, useEffect, useRef } from 'react'

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

const INITIAL_STATE: BrowserViewState = {
  url: '',
  title: '',
  favicon: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  error: null,
  domReady: false,
  hasLoadedRealPage: false,
}

export function useBrowserViewEvents(viewId: string | null): BrowserViewState {
  const [state, setState] = useState<BrowserViewState>(INITIAL_STATE)
  const viewIdRef = useRef(viewId)
  viewIdRef.current = viewId

  useEffect(() => {
    if (!viewId) {
      setState(INITIAL_STATE)
      return
    }

    const unsubscribe = window.api.browser.onEvent((event) => {
      if (event.viewId !== viewIdRef.current) return

      switch (event.type) {
        case 'did-navigate':
          setState((prev) => ({
            ...prev,
            url: event.url as string,
            canGoBack: event.canGoBack as boolean,
            canGoForward: event.canGoForward as boolean,
            error: null,
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
            hasLoadedRealPage: prev.hasLoadedRealPage || (prev.url !== '' && prev.url !== 'about:blank'),
          }))
          break

        case 'did-fail-load':
          setState((prev) => ({
            ...prev,
            isLoading: false,
            error: {
              code: event.errorCode as number,
              description: event.errorDescription as string,
              url: event.url as string,
            },
          }))
          break

        case 'crashed':
          setState((prev) => ({
            ...prev,
            isLoading: false,
            error: { code: -1, description: 'Renderer process crashed', url: '' },
          }))
          break
      }
    })

    return unsubscribe
  }, [viewId])

  return state
}
