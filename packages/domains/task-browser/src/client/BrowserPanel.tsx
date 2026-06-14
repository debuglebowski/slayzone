import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  createRef
} from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSubscription, useTRPC, useTRPCClient } from '@slayzone/transport/client'
import { track } from '@slayzone/telemetry/client'
import { cn, useShortcutAction, useShortcutDisplay } from '@slayzone/ui'
import { useAppearance } from '@slayzone/settings/client'
import { type BrowserTabPlaceholderHandle } from './BrowserTabPlaceholder'
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
    canUseDomPicker = true
  }: BrowserPanelProps,
  ref
) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const setActiveBrowserTab = useMutation(
    trpc.app.webview.setActiveBrowserTab.mutationOptions()
  ).mutate
  const { browserDefaultUrl, browserDefaultZoom, browserDeviceDefaults } = useAppearance()
  const elementPickerShortcut = useShortcutDisplay('browser-element-picker')
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

  // Convenience accessors for active tab
  // getActiveHandle reads the ref at call time — safe for event handlers where
  // the imperative handle may have updated since the last render.
  const activeTabIdRef = useRef(tabs.activeTabId)
  activeTabIdRef.current = tabs.activeTabId
  const getActiveHandle = useCallback(() => {
    const tabId = activeTabIdRef.current
    return tabId ? (tabRefsRef.current.get(tabId)?.current ?? null) : null
  }, [])
  const activeTabRef = getActiveHandle()
  const activeActions = activeTabRef?.actions
  const activeViewId = activeTabRef?.viewId ?? null
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

  const { cycleTheme } = useBrowserTheme({ activeActions, activeTab, updateActiveTab })

  const { activeLocked, toggleActiveLock } = useBrowserLock({
    taskId,
    tabs,
    onTabsChange,
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

  // Mirror the active tab id to the main-process registry so CLI calls without
  // an explicit --tab flag default to whichever tab the user is currently viewing.
  // Per-tab webContents registration is owned by BrowserTabPlaceholder.
  useEffect(() => {
    if (!taskId) return
    setActiveBrowserTab({ taskId, tabId: tabs.activeTabId })
  }, [taskId, tabs.activeTabId, setActiveBrowserTab])

  // Sync keyboard passthrough to main process.
  // NOTE: browser.setKeyboardPassthrough manipulates the active WebContentsView
  // (electron-native) — stays on the preload bridge per migration design.
  useEffect(() => {
    if (!activeViewId) return
    void trpcClient.app.browser.setKeyboardPassthrough.mutate({
      viewId: activeViewId,
      enabled: captureShortcuts
    })
  }, [activeViewId, captureShortcuts, trpcClient])

  // Update URL bar when active tab changes
  useEffect(() => {
    setInputUrl(activeTab?.url || '')
  }, [activeTab?.id, activeTab?.url])

  // Belt-and-suspenders: explicitly sync all view visibility on tab switch.
  // Note: isActive (parent task tab visibility) is intentionally NOT a gate
  // here — when the parent tab is hidden, the active browser sub-tab keeps
  // painting and useBrowserViewBounds parks it off-screen via offScreen.
  // browser.setVisible drives WebContentsView painting (electron-native) — bridge.
  useEffect(() => {
    for (const [tabId, ref] of tabRefsRef.current) {
      const handle = ref.current
      if (!handle?.viewId) continue
      const shouldBeVisible = tabId === tabs.activeTabId && !extensionsManagerOpen
      void trpcClient.app.browser.setVisible.mutate({
        viewId: handle.viewId,
        visible: shouldBeVisible
      })
    }
  }, [tabs.activeTabId, extensionsManagerOpen, trpcClient])

  // Refs for stable event handler closures (avoids tearing down listeners on every tabs change)
  const tabsRef = useRef(tabs)
  const onTabsChangeRef = useRef(onTabsChange)
  const createNewTabRef = useRef(createNewTab)
  tabsRef.current = tabs
  onTabsChangeRef.current = onTabsChange
  createNewTabRef.current = createNewTab

  // Eagerly update tabsRef + notify parent. Prevents stale-ref races when
  // multiple webview events (did-navigate, page-title-updated, page-favicon-updated)
  // fire in the same React batch before a re-render can refresh the ref.
  const commitTabsUpdate = useRef((next: BrowserTabsState) => {
    tabsRef.current = next
    onTabsChangeRef.current(next)
  }).current

  // Sync active view state to tab data (url, title, favicon)
  useEffect(() => {
    if (!activeViewState.url || !tabs.activeTabId) return
    const t = tabsRef.current
    const activeTabData = t.tabs.find((tab) => tab.id === t.activeTabId)
    if (activeTabData && activeViewState.url !== activeTabData.url) {
      commitTabsUpdate({
        ...t,
        tabs: t.tabs.map((tab) =>
          tab.id === t.activeTabId ? { ...tab, url: activeViewState.url } : tab
        )
      })
    }
  }, [activeViewState.url])

  useEffect(() => {
    if (!activeViewState.title || !tabs.activeTabId) return
    const t = tabsRef.current
    commitTabsUpdate({
      ...t,
      tabs: t.tabs.map((tab) =>
        tab.id === t.activeTabId ? { ...tab, title: activeViewState.title } : tab
      )
    })
  }, [activeViewState.title])

  useEffect(() => {
    if (!activeViewState.favicon || !tabs.activeTabId) return
    const t = tabsRef.current
    commitTabsUpdate({
      ...t,
      tabs: t.tabs.map((tab) =>
        tab.id === t.activeTabId ? { ...tab, favicon: activeViewState.favicon } : tab
      )
    })
  }, [activeViewState.favicon])

  // Handle new-tab-request events from main process (Cmd+Click / middle-click on links)
  useSubscription(
    trpc.app.browser.onEvent.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: (raw) => {
        const event = raw as {
          type: string
          taskId?: string
          url?: string
          background?: boolean
        }
        if (event.type !== 'new-tab-request' || event.taskId !== taskId) return
        const tabUrl = event.url as string
        if (event.background) {
          const newTab: BrowserTab = { id: generateTabId(), url: tabUrl, title: tabUrl }
          const t = tabsRef.current
          commitTabsUpdate({ tabs: [...t.tabs, newTab], activeTabId: t.activeTabId })
        } else {
          createNewTabRef.current(tabUrl)
        }
      }
    })
  )

  // Apply the browser's own baseline zoom without tying it to app-level UI zoom.
  useEffect(() => {
    if (!activeActions || !webviewReady) return
    activeActions.setZoom(browserDefaultZoom / 100)
  }, [browserDefaultZoom, activeActions, activeViewState.url, webviewReady])

  // Forward Cmd+Arrow to webpage via scope-aware shortcut system.
  // Only fires when browser scope is active (panel or WebContentsView focused).
  // browser.sendInputEvent injects synthetic input into the WebContentsView
  // (electron-native) — kept on the preload bridge per migration design.
  useShortcutAction('browser-scroll-top', () => {
    if (!activeViewId) return false // decline — let event propagate
    void trpcClient.app.browser.sendInputEvent.mutate({
      viewId: activeViewId,
      input: {
        type: 'keyDown',
        keyCode: 'Up',
        modifiers: ['meta']
      }
    })
    return undefined
  })
  useShortcutAction('browser-scroll-bottom', () => {
    if (!activeViewId) return false
    void trpcClient.app.browser.sendInputEvent.mutate({
      viewId: activeViewId,
      input: {
        type: 'keyDown',
        keyCode: 'Down',
        modifiers: ['meta']
      }
    })
    return undefined
  })

  // Keyboard shortcuts when focused
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isFocused || !captureShortcuts) return
      if (e.metaKey && e.key === 't') {
        e.preventDefault()
        createNewTab()
      }
      if (e.metaKey && e.key === 'w') {
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
    const handle = getActiveHandle()
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

    // DevTools open/close/query operate on the WebContentsView (electron-native)
    // — kept on the preload bridge per migration design.
    void (async () => {
      try {
        const isOpen = await trpcClient.app.browser.isDevToolsOpen.query({ viewId: activeViewId })
        if (isOpen) {
          await trpcClient.app.browser.closeDevTools.mutate({ viewId: activeViewId })
          setDevToolsOpen(false)
        } else {
          await trpcClient.app.browser.openDevTools.mutate({ viewId: activeViewId, mode: 'bottom' })
          setDevToolsOpen(true)
        }
      } catch {
        // DevTools toggle failed silently
      }
    })()
  }, [multiDeviceMode, webviewReady, activeViewId, trpcClient])

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
    [handlePickElement, activeActions, findMode, closeFindMode, createNewTab]
  )

  return (
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
        />
      )}
    </div>
  )
})
