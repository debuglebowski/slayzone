import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { RotateCw, X, Globe, Copy, Check } from 'lucide-react'
import { IconButton } from '@slayzone/ui'
import {
  inferHostScopeFromUrl,
  inferProtocolFromUrl,
  isEncodedDesktopHandoffUrl,
  isLoopbackUrl,
  isUrlWithinHostScope,
  normalizeDesktopHostScope,
  normalizeDesktopProtocol,
} from '../shared/handoff'
import type { DesktopHandoffPolicy } from '../shared/types'

interface WebviewElement extends HTMLElement {
  reload(): void
  stop(): void
  loadURL(url: string): void
  getURL(): string
  getWebContentsId(): number
}

interface WebPanelViewProps {
  panelId: string
  url: string
  baseUrl: string
  name: string
  blockDesktopHandoff?: boolean
  handoffProtocol?: string
  handoffHostScope?: string
  onUrlChange: (panelId: string, url: string) => void
  onFaviconChange?: (panelId: string, favicon: string) => void
  isResizing?: boolean
}

export function WebPanelView({
  panelId,
  url,
  baseUrl,
  name,
  blockDesktopHandoff = false,
  handoffProtocol,
  handoffHostScope,
  onUrlChange,
  onFaviconChange,
  isResizing,
}: WebPanelViewProps) {
  const webviewRef = useRef<WebviewElement>(null)
  const [webviewReady, setWebviewReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [loadError, setLoadError] = useState<{ code: number; description: string } | null>(null)
  const [initialSrc] = useState(() => (url || 'about:blank').replace(/^file:\/\//, 'slz-file://'))
  const loadedUrlRef = useRef(url)

  const handleNavigate = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return
    setLoadError(null)
    const currentUrl = wv.getURL().replace(/^slz-file:\/\//, 'file://')
    loadedUrlRef.current = currentUrl
    onUrlChange(panelId, currentUrl)
  }, [panelId, onUrlChange])

  const desktopHandoffPolicy = useMemo<DesktopHandoffPolicy | null>(() => {
    if (!blockDesktopHandoff) return null

    const protocol =
      normalizeDesktopProtocol(handoffProtocol) ??
      normalizeDesktopProtocol(inferProtocolFromUrl(baseUrl))
    if (!protocol) return null
    const hostScope =
      normalizeDesktopHostScope(handoffHostScope) ??
      normalizeDesktopHostScope(inferHostScopeFromUrl(baseUrl))
    return hostScope ? { protocol, hostScope } : { protocol }
  }, [blockDesktopHandoff, handoffProtocol, handoffHostScope, baseUrl])

  const syncDesktopHandoffPolicy = useCallback((wv: WebviewElement) => {
    void window.api.webview.setDesktopHandoffPolicy(wv.getWebContentsId(), desktopHandoffPolicy)
  }, [desktopHandoffPolicy])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const onStartLoading = () => setIsLoading(true)
    const onStopLoading = () => setIsLoading(false)
    const onDidAttach = () => {
      syncDesktopHandoffPolicy(wv)
    }
    const onDomReady = () => {
      setLoadError(null)
      setWebviewReady(true)
      loadedUrlRef.current = wv.getURL().replace(/^slz-file:\/\//, 'file://')
      syncDesktopHandoffPolicy(wv)
    }

    const onFavicon = (e: Event) => {
      const favicons = (e as CustomEvent).detail?.favicons as string[] | undefined
      if (favicons?.[0] && onFaviconChange) {
        onFaviconChange(panelId, favicons[0])
      }
    }

    const onNewWindow = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const popupUrl = detail?.url ?? ''
      if (!popupUrl.startsWith('http://') && !popupUrl.startsWith('https://')) return
      // Popups from webviews without desktop handoff open as real BrowserWindows — skip.
      if (detail?.disposition === 'new-window' && !desktopHandoffPolicy) return

      if (desktopHandoffPolicy) {
        if (isLoopbackUrl(popupUrl)) return

        // Suppress explicit encoded handoff links.
        if (isEncodedDesktopHandoffUrl(popupUrl, desktopHandoffPolicy)) return

        // Keep same-host popups inside the panel to avoid browser-level handoff paths.
        if (
          desktopHandoffPolicy.hostScope &&
          isUrlWithinHostScope(popupUrl, desktopHandoffPolicy.hostScope)
        ) {
          wv.loadURL(popupUrl)
          return
        }
      }

      // Default behavior: open popup in system browser.
      void window.api.shell.openExternal(
        popupUrl,
        desktopHandoffPolicy ? { desktopHandoff: desktopHandoffPolicy } : undefined
      ).catch(() => {})
    }

    const onWillNavigate = (e: Event) => {
      if (!desktopHandoffPolicy) return
      const nextUrl = (e as CustomEvent).detail?.url ?? ''
      if (!nextUrl) return
      if (isLoopbackUrl(nextUrl)) {
        e.preventDefault()
        return
      }
      if (!isEncodedDesktopHandoffUrl(nextUrl, desktopHandoffPolicy)) return
      e.preventDefault()
    }

    const onFocus = () => wv.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    const onFailLoad = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const errorCode = detail?.errorCode ?? 0
      if (errorCode === -3) return
      setIsLoading(false)
      setLoadError({ code: errorCode, description: detail?.errorDescription ?? 'Load failed' })
    }

    const onCrashed = () => {
      setIsLoading(false)
      setLoadError({ code: -1, description: 'Webview process crashed' })
    }

    wv.addEventListener('did-attach', onDidAttach)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('will-navigate', onWillNavigate)
    wv.addEventListener('will-frame-navigate', onWillNavigate)
    wv.addEventListener('did-navigate', handleNavigate)
    wv.addEventListener('did-navigate-in-page', handleNavigate)
    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('page-favicon-updated', onFavicon)
    wv.addEventListener('new-window', onNewWindow)
    wv.addEventListener('focus', onFocus)
    wv.addEventListener('did-fail-load', onFailLoad)
    wv.addEventListener('crashed', onCrashed)

    return () => {
      wv.removeEventListener('did-attach', onDidAttach)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('will-navigate', onWillNavigate)
      wv.removeEventListener('will-frame-navigate', onWillNavigate)
      wv.removeEventListener('did-navigate', handleNavigate)
      wv.removeEventListener('did-navigate-in-page', handleNavigate)
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('page-favicon-updated', onFavicon)
      wv.removeEventListener('new-window', onNewWindow)
      wv.removeEventListener('focus', onFocus)
      wv.removeEventListener('did-fail-load', onFailLoad)
      wv.removeEventListener('crashed', onCrashed)
    }
  }, [handleNavigate, panelId, onFaviconChange, desktopHandoffPolicy, syncDesktopHandoffPolicy])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !webviewReady) return
    syncDesktopHandoffPolicy(wv)
  }, [webviewReady, syncDesktopHandoffPolicy])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !webviewReady || !url || url === 'about:blank') return
    if (url === loadedUrlRef.current) return
    const currentUrl = wv.getURL().replace(/^slz-file:\/\//, 'file://')
    if (url === currentUrl) {
      loadedUrlRef.current = url
      return
    }
    loadedUrlRef.current = url
    wv.loadURL(url.replace(/^file:\/\//, 'slz-file://'))
  }, [url, webviewReady])

  return (
    <div className="flex flex-col h-full">
      {/* Header — h-10 matches Terminal/Browser/Editor tab bars */}
      <div className="shrink-0 flex items-center h-10 px-2 gap-1.5 border-b border-border bg-surface-1">
        <Globe className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-muted-foreground flex-1">{name}</span>

        <IconButton
          variant="ghost"
          size="icon-sm"
          aria-label="Copy URL"
          onClick={() => {
            const currentUrl = webviewRef.current?.getURL() ?? url
            navigator.clipboard.writeText(currentUrl)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
        </IconButton>

        <IconButton
          variant="ghost"
          size="icon-sm"
          aria-label={isLoading ? 'Stop loading' : 'Reload'}
          onClick={() => {
            const wv = webviewRef.current
            if (!wv) return
            if (isLoading) wv.stop()
            else wv.reload()
          }}
        >
          {isLoading ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
        </IconButton>
      </div>

      {/* Webview */}
      <div className="relative flex-1">
        <webview
          ref={webviewRef}
          src={initialSrc}
          partition="persist:web-panels"
          className="absolute inset-0"
          // @ts-expect-error - webview attributes not in React types
          allowpopups="true"
        />
        {loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#1a1a1a] text-neutral-400 gap-2">
            <div className="text-xs font-medium text-neutral-300">Failed to load</div>
            <div className="text-[11px] text-neutral-500">{loadError.description}</div>
            <IconButton
              variant="ghost"
              size="icon-sm"
              aria-label="Retry"
              onClick={() => { setLoadError(null); webviewRef.current?.reload() }}
            >
              <RotateCw className="size-3.5" />
            </IconButton>
          </div>
        )}
        {isResizing && <div className="absolute inset-0 z-10" />}
      </div>
    </div>
  )
}
