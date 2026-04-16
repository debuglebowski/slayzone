import { useCallback, useEffect, useMemo, useRef } from 'react'
import { RotateCw, X, Globe, Copy, Check, RotateCcw } from 'lucide-react'
import { IconButton, Tooltip, TooltipTrigger, TooltipContent, useAppearance } from '@slayzone/ui'
import { useBrowserView } from '@slayzone/task-browser'
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
import { useState } from 'react'

interface WebPanelViewProps {
  taskId: string
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
  isActive?: boolean
}

export function WebPanelView({
  taskId,
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
  isActive,
}: WebPanelViewProps) {
  const [copied, setCopied] = useState(false)
  const { browserDefaultZoom } = useAppearance()

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

  const actionsRef = useRef<{ navigate: (url: string) => void }>({ navigate: () => {} })

  const onPopupRoute = useCallback((popupUrl: string) => {
    if (isLoopbackUrl(popupUrl)) return
    if (desktopHandoffPolicy && isEncodedDesktopHandoffUrl(popupUrl, desktopHandoffPolicy)) return

    if (
      desktopHandoffPolicy?.hostScope &&
      isUrlWithinHostScope(popupUrl, desktopHandoffPolicy.hostScope)
    ) {
      actionsRef.current.navigate(popupUrl)
      return
    }

    void window.api.shell.openExternal(
      popupUrl,
      desktopHandoffPolicy ? { desktopHandoff: desktopHandoffPolicy } : undefined
    ).catch(() => {})
  }, [desktopHandoffPolicy])

  const { viewId, state, actions, placeholderRef } = useBrowserView({
    tabId: panelId,
    taskId,
    url: (url || 'about:blank').replace(/^file:\/\//, 'slz-file://'),
    partition: 'persist:web-panels',
    kind: 'web-panel',
    desktopHandoffPolicy,
    onPopupRoute,
    isResizing,
    visible: isActive !== false,
  })
  actionsRef.current = actions

  // Apply browser baseline zoom to match browser panel rendering
  useEffect(() => {
    if (viewId) actions.setZoom(browserDefaultZoom / 100)
  }, [viewId, browserDefaultZoom, actions])

  // Sync URL changes to parent — skip OAuth/SSO intermediate pages
  const onUrlChangeRef = useRef(onUrlChange)
  onUrlChangeRef.current = onUrlChange
  const prevUrlRef = useRef(state.url)
  useEffect(() => {
    if (!state.url || state.url === prevUrlRef.current) return
    prevUrlRef.current = state.url
    // Don't persist transient OAuth/SSO URLs — they're dead-ends when reloaded
    try {
      const u = new URL(state.url)
      if (u.pathname.includes('sso') || u.pathname.includes('oauth') || u.pathname.includes('callback') || u.pathname.includes('auth/') || u.searchParams.has('code') || u.searchParams.has('state')) return
    } catch { /* invalid URL — skip persist */ return }
    onUrlChangeRef.current(panelId, state.url)
  }, [state.url, panelId])

  // Sync favicon changes to parent
  const onFaviconChangeRef = useRef(onFaviconChange)
  onFaviconChangeRef.current = onFaviconChange
  const prevFaviconRef = useRef(state.favicon)
  useEffect(() => {
    if (!state.favicon || state.favicon === prevFaviconRef.current) return
    prevFaviconRef.current = state.favicon
    onFaviconChangeRef.current?.(panelId, state.favicon)
  }, [state.favicon, panelId])

  return (
    <div className="flex flex-col h-full">
      {/* Header — h-10 matches Terminal/Browser/Editor tab bars */}
      <div className="shrink-0 flex items-center h-10 px-2 gap-1.5 border-b border-border bg-surface-1">
        <Globe className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-muted-foreground shrink-0">{name}</span>
        <span className="text-[10px] text-muted-foreground/50 truncate flex-1 min-w-0 ml-2 bg-muted/50 rounded-full px-2 py-0.5">{state.url || url}</span>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label="Copy URL"
                onClick={() => {
                  navigator.clipboard.writeText(state.url || url)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>{copied ? 'Copied!' : 'Copy URL'}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label="Reset to original URL"
                onClick={() => {
                  actions.navigate(baseUrl)
                  onUrlChange(panelId, baseUrl)
                }}
              >
                <RotateCcw className="size-3.5" />
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>Reset to original URL</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <IconButton
                variant="ghost"
                size="icon-sm"
                aria-label={state.isLoading ? 'Stop loading' : 'Reload'}
                onClick={() => {
                  if (state.isLoading) actions.stop()
                  else actions.reload()
                }}
              >
                {state.isLoading ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
              </IconButton>
            </span>
          </TooltipTrigger>
          <TooltipContent>{state.isLoading ? 'Stop loading' : 'Reload'}</TooltipContent>
        </Tooltip>
      </div>

      {/* WCV placeholder */}
      <div className="relative flex-1">
        <div ref={placeholderRef} data-view-id={viewId} data-web-panel className="absolute inset-0" />
        {state.error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#1a1a1a] text-neutral-400 gap-2">
            <div className="text-xs font-medium text-neutral-300">Failed to load</div>
            <div className="text-[11px] text-neutral-500">{state.error.description}</div>
            <IconButton
              variant="ghost"
              size="icon-sm"
              aria-label="Retry"
              onClick={() => actions.reload()}
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
