import { RotateCw } from 'lucide-react'
import type { BrowserTabsState } from '../shared'
import { BrowserTabPlaceholder, type BrowserTabPlaceholderHandle } from './BrowserTabPlaceholder'
import { BrowserLoadingAnimation } from './BrowserLoadingAnimation'
import type { BrowserViewState } from './useBrowserView'

interface BrowserViewportProps {
  tabs: BrowserTabsState
  taskId?: string
  getTabRef: (tabId: string) => React.RefObject<BrowserTabPlaceholderHandle | null>
  extensionsManagerOpen: boolean
  loadError: BrowserViewState['error']
  hasLoadedRealPage: boolean
  isActive?: boolean
  isResizing?: boolean
  isPickingElement: boolean
  hiddenByOverlay: boolean
  activeActions: BrowserTabPlaceholderHandle['actions'] | undefined
  setActiveViewState: React.Dispatch<React.SetStateAction<BrowserViewState>>
  setHiddenByOverlay: React.Dispatch<React.SetStateAction<boolean>>
}

export function BrowserViewport({
  tabs,
  taskId,
  getTabRef,
  extensionsManagerOpen,
  loadError,
  hasLoadedRealPage,
  isActive,
  isResizing,
  isPickingElement,
  hiddenByOverlay,
  activeActions,
  setActiveViewState,
  setHiddenByOverlay
}: BrowserViewportProps) {
  return (
    <div className="relative flex-1 min-h-0">
      {/* Render a placeholder per tab — each owns its own WebContentsView */}
      {tabs.tabs.map((tab) => (
        <BrowserTabPlaceholder
          key={tab.id}
          ref={getTabRef(tab.id)}
          tabId={tab.id}
          taskId={taskId || ''}
          url={tab.url || 'about:blank'}
          partition="persist:browser-tabs"
          visible={tab.id === tabs.activeTabId && !extensionsManagerOpen}
          hidden={!!loadError || extensionsManagerOpen || !hasLoadedRealPage}
          offScreen={isActive === false}
          isResizing={isResizing}
          locked={!!tab.locked}
          className="absolute inset-0"
          onStateChange={tab.id === tabs.activeTabId ? setActiveViewState : undefined}
          onOverlayChange={tab.id === tabs.activeTabId ? setHiddenByOverlay : undefined}
        />
      ))}
      {!hasLoadedRealPage && !loadError && !hiddenByOverlay && (
        <div data-testid="browser-loading-animation" className="absolute inset-0 z-10 bg-surface-0">
          <BrowserLoadingAnimation />
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-0 text-muted-foreground gap-3">
          <div className="text-sm font-medium text-foreground">Failed to load page</div>
          <div
            className="text-xs text-muted-foreground max-w-xs text-center truncate"
            title={loadError.url}
          >
            {loadError.description} ({loadError.code})
          </div>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent"
            onClick={() => {
              setActiveViewState((prev) => ({ ...prev, error: null }))
              activeActions?.reload()
            }}
          >
            <RotateCw className="size-3.5" />
            Retry
          </button>
        </div>
      )}
      {isPickingElement && (
        <div
          data-testid="browser-picker-active-overlay"
          className="absolute inset-0 z-10 pointer-events-none border-2 border-amber-500/70 bg-amber-500/8"
        >
          <div className="absolute top-2 left-2 rounded bg-amber-500 text-black text-[11px] px-2 py-1 font-medium">
            Element picker active
          </div>
        </div>
      )}
      {isResizing && <div className="absolute inset-0 z-10" />}
      {hiddenByOverlay && !loadError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-background/95 via-background/90 to-background/95 overflow-hidden">
          {/* Decorative ornaments */}
          <div className="pointer-events-none absolute inset-0">
            {/* Dot grid */}
            <svg className="absolute inset-0 size-full opacity-[0.07]">
              <defs>
                <pattern
                  id="browser-dots"
                  x="0"
                  y="0"
                  width="24"
                  height="24"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="2" cy="2" r="1" fill="currentColor" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#browser-dots)" />
            </svg>
            {/* Concentric arcs */}
            <svg
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[32rem]"
              viewBox="0 0 400 400"
              fill="none"
            >
              <circle
                cx="200"
                cy="200"
                r="180"
                stroke="currentColor"
                strokeWidth="0.5"
                strokeDasharray="8 12"
                className="text-muted-foreground/10"
              />
              <circle
                cx="200"
                cy="200"
                r="140"
                stroke="currentColor"
                strokeWidth="0.5"
                strokeDasharray="4 16"
                className="text-muted-foreground/8"
              />
              <path
                d="M 200 40 A 160 160 0 0 1 360 200"
                stroke="currentColor"
                strokeWidth="1"
                className="text-muted-foreground/15"
              />
              <path
                d="M 200 360 A 160 160 0 0 1 40 200"
                stroke="currentColor"
                strokeWidth="1"
                className="text-muted-foreground/15"
              />
            </svg>
          </div>
          <p className="text-3xl font-semibold tracking-tight text-muted-foreground/60">
            Browser paused
          </p>
          <p className="text-base text-muted-foreground/40">
            Temporarily hidden while a popup is open
          </p>
        </div>
      )}
    </div>
  )
}
