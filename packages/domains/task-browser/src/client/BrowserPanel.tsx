import {
  useState,
  useRef,
  useEffect,
  useEffectEvent,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useInsertionEffect,
  createRef
} from 'react'
import { callBrowserHost, getBrowserHost, useBrowserHostEvent } from './browser-host'
import { BrowserRelayHostContext, useBrowserRelayHost } from './useBrowserRelayHost'
import { useTrack } from '@slayzone/telemetry/client'
import { cn, isPrimaryModifier, useShortcutAction, useShortcutDisplay } from '@slayzone/ui'
import { useAppearance } from '@slayzone/ui'
import { type BrowserTabPlaceholderHandle, type BrowserTabView } from './BrowserTabPlaceholder'
import type { BrowserViewState } from './useBrowserView'
import type { BrowserTab, BrowserTabsState } from '../shared'
import { MultiDeviceGrid } from './MultiDeviceGrid'
import { EXTENSIONS_MANAGER_ENABLED } from './BrowserPanel.constants'
import { generateTabId, normalizeUrl } from './BrowserPanel.utils'
import type { BrowserPanelHandle, BrowserPanelProps } from './BrowserPanel.types'
import { BrowserTabBar } from './BrowserTabBar'
import { BrowserToolbar } from './BrowserToolbar'
import { BrowserMultiDeviceToolbar } from './BrowserMultiDeviceToolbar'
import { BrowserViewport } from './BrowserViewport'
import { ExtensionsManagerView, useBrowserExtensions } from './BrowserExtensionsManager'
import { useBrowserTabs } from './useBrowserTabs'
import { useBrowserMultiDevice } from './useBrowserMultiDevice'
import { useBrowserPickElement } from './useBrowserPickElement'
import { useBrowserFind } from './useBrowserFind'
import { useBrowserTheme } from './useBrowserTheme'
import { useBrowserLock } from './useBrowserLock'
import { useBrowserImportUrls } from './useBrowserImportUrls'

export type { BrowserPanelHandle } from './BrowserPanel.types'

/**
 * Which browser panel shows each live view (viewId → panel), across every mounted
 * BrowserPanel. A task may have several browser panels (instances): a tab request
 * from main (a link opened in a new tab, an extension's tab) goes to the panel whose
 * view sent it; one from a view no browser panel shows (a web panel's) goes to the
 * task's primary browser panel.
 */
const viewOwners = new Map<string, symbol>()

export const BrowserPanel = forwardRef<BrowserPanelHandle, BrowserPanelProps>(function BrowserPanel(
  {
    className,
    tabs,
    onTabsChange,
    onRequestHide,
    taskId,
    projectId,
    isResizing,
    isActive,
    onElementSnippet,
    onScreenshot,
    canUseDomPicker = true,
    primaryInstance = true
  }: BrowserPanelProps,
  ref
) {
  const hasBrowserHost = getBrowserHost() !== null
  const relayHost = useBrowserRelayHost(taskId, primaryInstance)
  const [ownerKey] = useState(() => Symbol('browser-panel'))
  const { browserDefaultUrl, browserDefaultZoom, browserDeviceDefaults } = useAppearance()
  const elementPickerShortcut = useShortcutDisplay('browser-element-picker')
  const { track } = useTrack()
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [inputUrl, setInputUrl] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  const [captureShortcuts, setCaptureShortcuts] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Per-tab view refs — each BrowserTabPlaceholder exposes its viewId/state/actions
  const tabRefsRef = useRef<Map<string, React.RefObject<BrowserTabPlaceholderHandle | null>>>(
    new Map()
  )
  const getTabRef = useCallback((tabId: string) => {
    let existing = tabRefsRef.current.get(tabId)
    if (!existing) {
      existing = createRef<BrowserTabPlaceholderHandle>()
      tabRefsRef.current.set(tabId, existing)
    }
    return existing
  }, [])

  // Active tab's state (updated via onStateChange callback from placeholder)
  const [activeViewState, setActiveViewState] = useState<BrowserViewState>({
    url: '',
    title: '',
    favicon: '',
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    error: null,
    domReady: false,
    hasLoadedRealPage: false
  })
  const [hiddenByOverlay, setHiddenByOverlay] = useState(false)

  // Reset view state when active tab changes so stale hasLoadedRealPage doesn't leak
  useEffect(() => {
    if (!tabs.activeTabId) return
    const handle = tabRefsRef.current.get(tabs.activeTabId)?.current
    if (handle) {
      setActiveViewState(handle.state)
    } else {
      setActiveViewState({
        url: '',
        title: '',
        favicon: '',
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
        error: null,
        domReady: false,
        hasLoadedRealPage: false
      })
    }
  }, [tabs.activeTabId])

  // Per-tab viewId/actions, reported by each mounted BrowserTabPlaceholder
  // (null on unmount). Render reads this state, never the imperative handles:
  // a render-time ref read would be frozen by React Compiler memoization.
  const [tabViews, setTabViews] = useState<Record<string, BrowserTabView>>({})
  const handleTabViewChange = useCallback((tabId: string, view: BrowserTabView | null) => {
    setTabViews((prev) => {
      const cur = prev[tabId]
      if (!view) {
        if (!cur) return prev
        const next = { ...prev }
        delete next[tabId]
        return next
      }
      if (cur && cur.viewId === view.viewId && cur.actions === view.actions) return prev
      return { ...prev, [tabId]: view }
    })
  }, [])

  // Claim this panel's views so main's tab requests from them come here (viewOwners).
  useEffect(() => {
    const ids = Object.values(tabViews).flatMap((v) => (v.viewId ? [v.viewId] : []))
    for (const id of ids) viewOwners.set(id, ownerKey)
    return () => {
      for (const id of ids) if (viewOwners.get(id) === ownerKey) viewOwners.delete(id)
    }
  }, [tabViews, ownerKey])

  // Convenience accessors for active tab
  const activeView = tabs.activeTabId ? tabViews[tabs.activeTabId] : undefined
  const activeActions = activeView?.actions
  const activeViewId = activeView?.viewId ?? null
  const canGoBack = activeViewState.canGoBack
  const canGoForward = activeViewState.canGoForward
  const isLoading = activeViewState.isLoading
  const loadError = activeViewState.error
  const webviewReady = activeViewState.domReady

  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeTabId) || null

  const updateActiveTab = useCallback(
    (patch: Partial<BrowserTab>) => {
      if (!tabs.activeTabId) return
      onTabsChange({
        ...tabs,
        tabs: tabs.tabs.map((t) => (t.id === tabs.activeTabId ? { ...t, ...patch } : t))
      })
    },
    [tabs, onTabsChange]
  )

  // Refs for stable event handler closures (avoids tearing down listeners on every tabs change).
  // Written every commit (no deps), before any effect or handler reads them.
  const tabsRef = useRef(tabs)
  const onTabsChangeRef = useRef(onTabsChange)
  useInsertionEffect(() => {
    tabsRef.current = tabs
    onTabsChangeRef.current = onTabsChange
  })

  // Eagerly update tabsRef + notify parent. Prevents stale-ref races when
  // multiple webview events (did-navigate, page-title-updated, page-favicon-updated)
  // fire in the same React batch before a re-render can refresh the ref.
  const commitTabsUpdate = useCallback((next: BrowserTabsState) => {
    tabsRef.current = next
    onTabsChangeRef.current(next)
  }, [])
  /** The latest tabs, as every write through commitTabsUpdate leaves them. */
  const latestTabs = useCallback(() => tabsRef.current, [])

  // --- Concern-grouped hooks ---
  const {
    extensionsManagerOpen,
    setExtensionsManagerOpen,
    extensions,
    browserExtensions,
    extensionsLoading,
    extensionsError,
    refreshExtensions,
    handleToggleExtensionsManager,
    handleActivateExtension,
    handleImportExtension,
    handleLoadExtension,
    handleRemoveExtension
  } = useBrowserExtensions()

  const {
    multiDeviceMode,
    multiDeviceConfig,
    multiDeviceLayout,
    reloadTrigger,
    forceReloadTrigger,
    setReloadTrigger,
    setForceReloadTrigger,
    toggleMultiDevice,
    setMultiDeviceLayout,
    toggleSlot,
    setPreset
  } = useBrowserMultiDevice({ activeTab, updateActiveTab, browserDeviceDefaults })

  const {
    createNewTab,
    closeTab,
    switchToTab,
    renameTab,
    tabSensors,
    handleTabDragEnd,
    switchToNextTab,
    switchToPrevTab
  } = useBrowserTabs({ tabs, onTabsChange, onRequestHide, browserDefaultUrl })

  const { cycleTheme } = useBrowserTheme({ activeTab, updateActiveTab })

  const { activeLocked, toggleActiveLock } = useBrowserLock({
    taskId,
    tabs,
    latestTabs,
    commitTabs: commitTabsUpdate,
    activeTab
  })

  const { isPickingElement, pickError, handlePickElement } = useBrowserPickElement({
    activeActions,
    extensionsManagerOpen,
    canUseDomPicker,
    multiDeviceMode,
    onElementSnippet
  })

  const {
    findMode,
    findText,
    findResult,
    findInputRef,
    closeFindMode,
    findNext,
    handleFindTextChange
  } = useBrowserFind({
    activeViewId,
    multiDeviceMode,
    extensionsManagerOpen,
    activeTabId: tabs.activeTabId,
    containerRef
  })

  const { otherTaskUrls, importDropdownOpen, setImportDropdownOpen } = useBrowserImportUrls({
    taskId,
    projectId
  })

  // Mirror the active tab id to this device's tab registry and the hub relay, so CLI
  // calls without an explicit --tab flag default to whichever tab the user is viewing.
  // Per-tab webContents registration is owned by BrowserTabPlaceholder.
  useEffect(() => {
    if (!taskId) return
    callBrowserHost('tabs.setActive', taskId, tabs.activeTabId)
    relayHost.setActiveTab(tabs.activeTabId)
  }, [taskId, tabs.activeTabId, relayHost])

  // Sync keyboard passthrough to this device's browser host.
  useEffect(() => {
    if (!activeViewId) return
    callBrowserHost('view.setKeyboardPassthrough', activeViewId, captureShortcuts)
  }, [activeViewId, captureShortcuts])

  // Update URL bar when active tab changes
  useEffect(() => {
    setInputUrl(activeTab?.url || '')
  }, [activeTab?.id, activeTab?.url])

  // Belt-and-suspenders: explicitly sync all view visibility on tab switch.
  // Note: isActive (parent task tab visibility) is intentionally NOT a gate
  // here — when the parent tab is hidden, the active browser sub-tab keeps
  // painting and useBrowserViewBounds parks it off-screen via offScreen.
  useEffect(() => {
    for (const [tabId, ref] of tabRefsRef.current) {
      const handle = ref.current
      if (!handle?.viewId) continue
      const shouldBeVisible = tabId === tabs.activeTabId && !extensionsManagerOpen
      callBrowserHost('view.setVisible', handle.viewId, shouldBeVisible)
    }
  }, [tabs.activeTabId, extensionsManagerOpen])

  // Sync active view state to tab data (url, title, favicon). An Effect Event:
  // each sync runs only when its view field changes, reading the active tab and
  // commit fn as of then.
  const patchActiveTab = useEffectEvent((patch: Partial<BrowserTab>): void => {
    if (!tabs.activeTabId) return
    const t = tabsRef.current
    if (patch.url !== undefined) {
      const activeTabData = t.tabs.find((tab) => tab.id === t.activeTabId)
      if (!activeTabData || patch.url === activeTabData.url) return
    }
    commitTabsUpdate({
      ...t,
      tabs: t.tabs.map((tab) => (tab.id === t.activeTabId ? { ...tab, ...patch } : tab))
    })
  })

  useEffect(() => {
    if (activeViewState.url) patchActiveTab({ url: activeViewState.url })
  }, [activeViewState.url])

  useEffect(() => {
    if (activeViewState.title) patchActiveTab({ title: activeViewState.title })
  }, [activeViewState.title])

  useEffect(() => {
    if (activeViewState.favicon) patchActiveTab({ favicon: activeViewState.favicon })
  }, [activeViewState.favicon])

  // Tab requests from main: new-tab-request (Cmd+Click / middle-click on links, and
  // Chrome extensions' chrome.tabs.create — those carry the tabId main waits on),
  // select-tab-request / close-tab-request (chrome.tabs.update / chrome.tabs.remove).
  const handleNewTabRequest = (raw: unknown): void => {
    const event = raw as {
      type: string
      viewId?: string
      taskId?: string
      url?: string
      background?: boolean
      tabId?: string
      /** Opened from an isolated tab: the new tab is isolated too. */
      isolated?: boolean
    }
    if (event.taskId !== taskId) return
    // Another browser panel of the task handles requests for its own tabs and views.
    if (event.type === 'select-tab-request' || event.type === 'close-tab-request') {
      if (!tabsRef.current.tabs.some((t) => t.id === event.tabId)) return
    } else {
      const owner = event.viewId ? viewOwners.get(event.viewId) : undefined
      if (owner ? owner !== ownerKey : !primaryInstance) return
    }
    if (event.type === 'select-tab-request' && event.tabId) {
      switchToTab(event.tabId)
      return
    }
    if (event.type === 'close-tab-request' && event.tabId) {
      closeTab(event.tabId)
      return
    }
    if (event.type !== 'new-tab-request') return
    const tabUrl = event.url as string
    const isolated = event.isolated === true
    if (event.background) {
      const newTab: BrowserTab = {
        id: generateTabId(),
        url: tabUrl,
        title: tabUrl,
        ...(isolated ? { isolated: true } : {})
      }
      const t = tabsRef.current
      commitTabsUpdate({ tabs: [...t.tabs, newTab], activeTabId: t.activeTabId })
    } else {
      createNewTab(tabUrl, event.tabId, { isolated })
    }
  }
  useBrowserHostEvent('event', handleNewTabRequest, !!taskId)

  // Apply the browser's own baseline zoom without tying it to app-level UI zoom.
  useEffect(() => {
    if (!activeActions || !webviewReady) return
    activeActions.setZoom(browserDefaultZoom / 100)
  }, [browserDefaultZoom, activeActions, activeViewState.url, webviewReady])

  // Forward Cmd+Arrow to webpage via scope-aware shortcut system.
  // Only fires when browser scope is active (panel or WebContentsView focused).
  useShortcutAction('browser-scroll-top', () => {
    if (!activeViewId) return false // decline — let event propagate
    callBrowserHost('view.sendInputEvent', activeViewId, {
      type: 'keyDown',
      keyCode: 'Up',
      modifiers: ['meta']
    })
    return undefined
  })
  useShortcutAction('browser-scroll-bottom', () => {
    if (!activeViewId) return false
    callBrowserHost('view.sendInputEvent', activeViewId, {
      type: 'keyDown',
      keyCode: 'Down',
      modifiers: ['meta']
    })
    return undefined
  })

  // Keyboard shortcuts when focused
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isFocused || !captureShortcuts) return
      if (isPrimaryModifier(e) && e.key === 't') {
        e.preventDefault()
        createNewTab()
      }
      if (isPrimaryModifier(e) && e.key === 'w') {
        e.preventDefault()
        if (tabs.activeTabId) closeTab(tabs.activeTabId)
      }
      if (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        switchToNextTab()
      }
      if (e.ctrlKey && e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        switchToPrevTab()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [isFocused, captureShortcuts, tabs, createNewTab, closeTab, switchToNextTab, switchToPrevTab])

  const handleNavigate = () => {
    if (extensionsManagerOpen || !inputUrl.trim()) return

    const url = normalizeUrl(inputUrl)

    if (multiDeviceMode) {
      setInputUrl(url)
      updateActiveTab({ url })
      return
    }

    // Read ref at call time — activeActions from render may be stale if the
    // child's useImperativeHandle updated after the parent's last render.
    const activeTabId = tabs.activeTabId
    const handle = activeTabId ? (tabRefsRef.current.get(activeTabId)?.current ?? null) : null
    if (!handle?.actions) return
    handle.actions.navigate(url)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleNavigate()
  }

  const handleFocus = () => setIsFocused(true)
  const handleBlur = (e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsFocused(false)
    }
  }

  const toggleDevTools = useCallback(() => {
    if (multiDeviceMode || !webviewReady || !activeViewId) {
      return
    }
    track('browser_devtools_toggled')

    const host = getBrowserHost()
    if (!host) return
    void (async () => {
      try {
        const isOpen = await host.call('view.isDevToolsOpen', activeViewId)
        if (isOpen) {
          await host.call('view.closeDevTools', activeViewId)
          setDevToolsOpen(false)
        } else {
          await host.call('view.openDevTools', activeViewId, 'bottom')
          setDevToolsOpen(true)
        }
      } catch {
        // DevTools toggle failed silently
      }
    })()
  }, [multiDeviceMode, webviewReady, activeViewId, track])

  const toggleCaptureShortcuts = useCallback(() => {
    setCaptureShortcuts((prev) => !prev)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => containerRef.current?.focus(),
      pickElement: () => {
        handlePickElement()
      },
      reload: () => {
        activeActions?.reload()
      },
      focusUrlBar: () => {
        if (findMode) closeFindMode()
        urlInputRef.current?.focus()
        urlInputRef.current?.select()
      },
      getActiveViewId: () => activeViewId,
      newTab: (url?: string) => createNewTab(url)
    }),
    [handlePickElement, activeActions, findMode, closeFindMode, activeViewId, createNewTab]
  )

  if (!hasBrowserHost) {
    return (
      <div
        data-browser-panel="true"
        className={cn(
          'flex items-center justify-center p-6 text-center text-sm text-muted-foreground',
          className
        )}
      >
        The browser panel runs in the SlayZone desktop app.
      </div>
    )
  }

  return (
    <BrowserRelayHostContext.Provider value={relayHost}>
      <div
        ref={containerRef}
        data-browser-panel="true"
        data-picker-active={isPickingElement ? 'true' : 'false'}
        className={cn(
          'flex flex-col rounded-md transition-shadow',
          isPickingElement && 'ring-2 ring-amber-500/70',
          className
        )}
        tabIndex={-1}
        onFocus={handleFocus}
        onBlur={handleBlur}
        // Working in the panel's own chrome makes this client the one `slay browser`
        // reaches (input inside a web view arrives as the host's `engaged`).
        onPointerDownCapture={relayHost.noteUse}
        onKeyDownCapture={relayHost.noteUse}
      >
        <BrowserTabBar
          tabs={tabs}
          isPickingElement={isPickingElement}
          tabSensors={tabSensors}
          onDragEnd={handleTabDragEnd}
          onSwitch={switchToTab}
          onClose={closeTab}
          onRename={renameTab}
          onNewTab={() => createNewTab()}
        />

        <BrowserToolbar
          activeLocked={activeLocked}
          findMode={findMode}
          activeViewUrl={activeViewState.url}
          activeTab={activeTab}
          toggleActiveLock={toggleActiveLock}
          findInputRef={findInputRef}
          findText={findText}
          handleFindTextChange={handleFindTextChange}
          findNext={findNext}
          closeFindMode={closeFindMode}
          findResult={findResult}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          isLoading={isLoading}
          extensionsManagerOpen={extensionsManagerOpen}
          multiDeviceMode={multiDeviceMode}
          activeActions={activeActions}
          setReloadTrigger={setReloadTrigger}
          setForceReloadTrigger={setForceReloadTrigger}
          urlInputRef={urlInputRef}
          inputUrl={inputUrl}
          setInputUrl={setInputUrl}
          handleKeyDown={handleKeyDown}
          taskId={taskId}
          importDropdownOpen={importDropdownOpen}
          setImportDropdownOpen={setImportDropdownOpen}
          otherTaskUrls={otherTaskUrls}
          updateActiveTab={updateActiveTab}
          toggleMultiDevice={toggleMultiDevice}
          canUseDomPicker={canUseDomPicker}
          webviewReady={webviewReady}
          isPickingElement={isPickingElement}
          handlePickElement={handlePickElement}
          elementPickerShortcut={elementPickerShortcut}
          onScreenshot={onScreenshot}
          activeViewId={activeViewId}
          devToolsOpen={devToolsOpen}
          toggleDevTools={toggleDevTools}
          cycleTheme={cycleTheme}
          captureShortcuts={captureShortcuts}
          toggleCaptureShortcuts={toggleCaptureShortcuts}
          handleToggleExtensionsManager={handleToggleExtensionsManager}
        />

        {pickError && !multiDeviceMode && !extensionsManagerOpen && (
          <div
            className="shrink-0 px-2 py-1.5 border-b text-xs text-destructive bg-destructive/5 truncate"
            title={pickError}
          >
            Element picker error: {pickError}
          </div>
        )}

        {/* Responsive toolbar */}
        {multiDeviceMode && !extensionsManagerOpen && (
          <BrowserMultiDeviceToolbar
            multiDeviceConfig={multiDeviceConfig}
            multiDeviceLayout={multiDeviceLayout}
            onToggleSlot={toggleSlot}
            onSetLayout={setMultiDeviceLayout}
          />
        )}

        {/* Webview / Multi-device */}
        {EXTENSIONS_MANAGER_ENABLED && extensionsManagerOpen ? (
          <ExtensionsManagerView
            extensions={extensions}
            browserExtensions={browserExtensions}
            isLoading={extensionsLoading}
            error={extensionsError}
            onRefresh={() => {
              void refreshExtensions()
            }}
            onClose={() => setExtensionsManagerOpen(false)}
            onActivate={handleActivateExtension}
            onRemove={(extensionId) => {
              void handleRemoveExtension(extensionId)
            }}
            onImport={(path, name) => {
              void handleImportExtension(path, name)
            }}
            onLoadUnpacked={() => {
              void handleLoadExtension()
            }}
          />
        ) : multiDeviceMode ? (
          <MultiDeviceGrid
            config={multiDeviceConfig}
            layout={multiDeviceLayout}
            url={activeTab?.url || 'about:blank'}
            isolated={!!activeTab?.isolated}
            isResizing={isResizing}
            reloadTrigger={reloadTrigger}
            forceReloadTrigger={forceReloadTrigger}
            onPresetChange={setPreset}
          />
        ) : (
          <BrowserViewport
            tabs={tabs}
            taskId={taskId}
            getTabRef={getTabRef}
            extensionsManagerOpen={extensionsManagerOpen}
            loadError={loadError}
            hasLoadedRealPage={activeViewState.hasLoadedRealPage}
            isActive={isActive}
            isResizing={isResizing}
            isPickingElement={isPickingElement}
            hiddenByOverlay={hiddenByOverlay}
            activeActions={activeActions}
            setActiveViewState={setActiveViewState}
            setHiddenByOverlay={setHiddenByOverlay}
            onTabViewChange={handleTabViewChange}
          />
        )}
      </div>
    </BrowserRelayHostContext.Provider>
  )
})
